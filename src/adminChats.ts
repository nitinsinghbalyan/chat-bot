/**
 * Admin Chats pages: every conversation of every seller, tagged by where it came from (website,
 * embedded widget, bot API, test run), with each turn's model calls and product picks. A test run
 * (simulator run id) also gets the comparison tables: tokens, latency and cost per call type, and
 * word rules vs Jev vs Haiku against the scenario's product (src/runReport.ts, as sim:report).
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { importRun } from "./chatImport.js";
import { CHAT_SOURCES, type ChatDb, type ChatFilter, type ChatRow, type ChatSource, type ChatTurnRow } from "./db.js";
import { accuracy, accuracyCsv, callStats, callsCsv, effective, PICKERS, verdict, type Picker, type RunTurn, type Tally } from "./runReport.js";
import type { SellerRegistry } from "./sellers.js";
import { esc } from "./site/html.js";

type Handler = (req: Request, res: Response, next: NextFunction) => void;

export interface ChatsDeps {
  db: ChatDb;
  sellers: SellerRegistry;
  requireAdmin: Handler;
  sameOriginPost: Handler;
  /** The admin page frame (title, body, active nav item). */
  shell: (title: string, body: string, active: "chats") => string;
  fmtIST: (v: string) => string;
  /** A "Langfuse ↗" button for a Langfuse session ("<seller>:<chat id>"), or "". */
  sessionLink: (langfuseSession: string) => string;
}

export const SOURCE_LABEL: Record<ChatSource, string> = { website: "Website", embedded: "Embedded", api: "Bot API", test: "Test run" };
const PER_PAGE = 50;

const usd = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(5)}` : n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const int = (n: number) => Math.round(n).toLocaleString("en-IN");
const ms = (n: number) => `${int(n)} ms`;
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "–");

/** A chat's turns in the report's shape (a chat is one scenario attempt). */
function runTurns(rows: Array<{ chat: ChatRow; turn: ChatTurnRow }>): RunTurn[] {
  const attempt = new Map<string, number>();
  return rows.map(({ chat, turn }) => {
    if (!attempt.has(chat.chatId)) attempt.set(chat.chatId, attempt.size + 1);
    return {
      seller: chat.seller,
      scenarioId: chat.scenarioId ?? chat.chatId,
      attempt: attempt.get(chat.chatId)!,
      turn: turn.turn,
      language: chat.language ?? "",
      suite: chat.label ?? "",
      focus: chat.expectedProduct ?? "",
      buyer: turn.buyer,
      traceId: turn.traceId,
      calls: turn.calls,
      product: turn.product,
    };
  });
}

/** The first product each picker set in a chat, judged against its expected product. */
function firstVerdicts(chat: ChatRow, turns: RunTurn[]): Partial<Record<Picker, ReturnType<typeof verdict>>> {
  if (!chat.expectedProduct) return {};
  const out: Partial<Record<Picker, ReturnType<typeof verdict>>> = {};
  for (const { id } of PICKERS) {
    const asked = turns.filter((t) => (id === "wordRules" ? t.product.wordRules !== undefined : t.product[id] !== undefined));
    if (!asked.length) continue;
    out[id] = verdict(chat.expectedProduct, asked.map((t) => effective(t, id)).find((x) => x) ?? null);
  }
  return out;
}

const mark = (v: ReturnType<typeof verdict> | undefined) => (v === "right" ? '<span class="vmark ok" title="right">✓</span>' : v === "wrong" ? '<span class="vmark err" title="wrong">✗</span>' : v === "none" ? '<span class="vmark none" title="no product">–</span>' : "");

function tallyRow(name: string, t: Tally) {
  return `<td>${esc(name)}</td><td class="tnum">${pct(t.right, t.turns)}</td><td class="tnum">${pct(t.wrong, t.turns)}</td><td class="tnum">${pct(t.none, t.turns)}</td>`;
}

/** The run summary card: totals, tokens/latency/cost per call type, and the product-pick comparison. */
function runSummary(runId: string, turns: RunTurn[], chats: ChatRow[], qs: string): string {
  const cs = callStats(turns);
  const acc = accuracy(turns, 6);
  const botCost = turns.reduce((a, t) => a + t.calls.reduce((b, c) => b + (c.costUsd ?? 0), 0), 0);
  const summaries = chats.filter((c) => c.summaryShown).length;
  const tiles = [
    [int(chats.length), "chats"],
    [int(turns.length), "buyer messages"],
    [int(summaries), "reached the summary"],
    [usd(botCost), "bot cost"],
    [usd(turns.length ? (1000 * botCost) / turns.length : 0), "per 1,000 messages"],
  ]
    .map(([b, s]) => `<div class="tile"><b class="tnum">${b}</b><span>${s}</span></div>`)
    .join("");
  const callRows = cs
    .map(
      (s) =>
        `<tr><td>${esc(s.label)}</td><td><code>${esc(s.model)}</code></td><td class="tnum">${int(s.calls)}</td><td class="tnum">${int(s.input.mean)} / ${int(s.input.p95)}</td><td class="tnum">${int(s.output.mean)}</td><td class="tnum">${ms(s.latency.mean)} / ${ms(s.latency.p95)}</td><td class="tnum">${s.firstToken ? ms(s.firstToken.mean) : "–"}</td><td class="tnum">${usd(s.costMean)}</td><td class="tnum">${usd(s.costTotal)}</td></tr>`,
    )
    .join("");
  const pickRows = PICKERS.map((p) => {
    const f = acc.firstProduct[p.id];
    return `<tr>${tallyRow(p.name, acc.perTurn[p.id])}<td class="tnum">${pct(f.right, f.turns)} / ${pct(f.wrong, f.turns)}</td><td class="tnum">${acc.offTopic.picks[p.id]}</td></tr>`;
  }).join("");
  const split = (title: string, groups: Record<string, Record<Picker, Tally>>) => {
    const keys = Object.keys(groups).sort();
    if (!keys.length) return "";
    return `<div class="table-wrap"><table class="compact"><thead><tr><th>${esc(title)}</th>${PICKERS.map((p) => `<th>${esc(p.name)} right / wrong</th>`).join("")}<th>Turns</th></tr></thead><tbody>${keys
      .map((k) => `<tr><td>${esc(k)}</td>${PICKERS.map((p) => `<td class="tnum">${pct(groups[k]![p.id].right, groups[k]![p.id].turns)} / ${pct(groups[k]![p.id].wrong, groups[k]![p.id].turns)}</td>`).join("")}<td class="tnum">${groups[k]!.jev.turns}</td></tr>`)
      .join("")}</tbody></table></div>`;
  };
  return `<section class="card run-summary" aria-labelledby="run-h">
  <div class="card-head"><div><h2 id="run-h">Run <code>${esc(runId)}</code></h2><p class="card-desc">Every model call of the run, and how each product picker did against the scenario's product.</p></div>
  <div class="btn-row"><a class="btn small" href="/admin/chats/run.csv${qs}&amp;kind=calls">calls.csv</a><a class="btn small" href="/admin/chats/run.csv${qs}&amp;kind=accuracy">accuracy.csv</a></div></div>
  <div class="tiles">${tiles}</div>
  <h3>Tokens, latency and cost per call</h3>
  <div class="table-wrap"><table class="compact"><thead><tr><th>Call</th><th>Model</th><th>Calls</th><th>Input tokens mean / p95</th><th>Output mean</th><th>Latency mean / p95</th><th>First token</th><th>Cost per call</th><th>Total</th></tr></thead><tbody>${callRows || '<tr><td colspan="9" class="muted">No calls recorded.</td></tr>'}</tbody></table></div>
  <h3>Product pick: word rules vs Jev vs Haiku</h3>
  <p class="card-desc">On ${int(acc.compared)} turns where Jev and Haiku were both asked, in chats with a known product. Each picker's product is what the chat would get if it decided: its own pick, the current product on "keep", the word rules' when unsure.</p>
  <div class="table-wrap"><table class="compact"><thead><tr><th>Picker</th><th>Right</th><th>Wrong</th><th>No product</th><th>First product right / wrong</th><th>Off-topic picks</th></tr></thead><tbody>${pickRows}</tbody></table></div>
  <p class="card-desc">Jev and Haiku agreed and were right on ${int(acc.agreement.bothRight)} turns; only Jev right on ${int(acc.agreement.onlyJev)}, only Haiku right on ${int(acc.agreement.onlyHaiku)}, neither on ${int(acc.agreement.bothWrongOrNone)}. Off-topic chats: ${int(acc.offTopic.turns)} turns.</p>
  <div class="grid-2">${split("Language", acc.byLanguage)}${split("Suite", acc.bySuite)}</div>
</section>`;
}

/** The calls of one turn as a small table. */
function callsTable(calls: any[]): string {
  if (!calls.length) return '<p class="muted small">No model calls this turn.</p>';
  const kind = (k: string) => (k === "reply" ? "Reply" : k === "jev-pick" ? "Jev pick" : k === "haiku-pick" ? "Haiku pick" : k);
  return `<div class="table-wrap"><table class="compact calls"><thead><tr><th>Call</th><th>Model</th><th>Input</th><th>Cache read</th><th>Output</th><th>Latency</th><th>First token</th><th>Cost</th><th>Decision</th></tr></thead><tbody>${calls
    .map(
      (c) =>
        `<tr${c.error ? ' class="err"' : ""}><td>${esc(kind(c.kind))}${c.round ? ` ${c.round}` : ""}</td><td><code>${esc(c.model ?? "")}</code></td><td class="tnum">${int(c.inputTokens ?? 0)}</td><td class="tnum">${c.cacheRead !== undefined ? int(c.cacheRead) : "–"}</td><td class="tnum">${int(c.outputTokens ?? 0)}</td><td class="tnum">${ms(c.latencyMs ?? 0)}</td><td class="tnum">${typeof c.firstTokenMs === "number" ? ms(c.firstTokenMs) : "–"}</td><td class="tnum">${c.costUsd === null || c.costUsd === undefined ? "–" : usd(c.costUsd)}</td><td>${c.error ? `<span class="warn-text">${esc(String(c.error))}</span>` : c.decision !== undefined ? `${esc(c.decision ?? "unsure")}${c.confidence !== null && c.confidence !== undefined ? ` <span class="muted small">(${esc(typeof c.confidence === "number" ? c.confidence.toFixed(2) : String(c.confidence))})</span>` : ""}` : ""}</td></tr>`,
    )
    .join("")}</tbody></table></div>`;
}

/** Each picker's product this turn, marked against the expected product. */
function picksLine(turn: RunTurn, expected: string | null): string {
  const p = turn.product;
  if (p.jev === undefined && p.wordRules === undefined) return p.used ? `<p class="picks small"><span>Product: <b>${esc(p.used)}</b></span></p>` : "";
  const item = (label: string, value: string | null | undefined, id?: Picker) => {
    if (value === undefined) return "";
    const v = id && expected ? verdict(expected, effective(turn, id)) : undefined;
    return `<span>${label}: <b>${esc(value ?? "unsure")}</b>${mark(v)}</span>`;
  };
  return `<p class="picks small">${item("Current", p.current ?? "none")}${item("Word rules", p.wordRules ?? "none", "wordRules")}${item("Jev", p.jev, "jev")}${item("Haiku", p.haiku, "haiku")}${item("Used", p.used ?? "none")}</p>`;
}

export function mountChats(app: Express, d: ChatsDeps) {
  const { db, sellers } = d;
  const name = (slug: string) => sellers.get(slug)?.config.name ?? slug;

  function filterOf(req: Request): ChatFilter & { page: number } {
    const s = typeof req.query.seller === "string" && sellers.get(req.query.seller) ? req.query.seller : undefined;
    const tag = typeof req.query.tag === "string" && (CHAT_SOURCES as string[]).includes(req.query.tag) ? (req.query.tag as ChatSource) : undefined;
    const run = typeof req.query.run === "string" && req.query.run ? req.query.run.slice(0, 120) : undefined;
    const q = typeof req.query.q === "string" ? req.query.q.slice(0, 100) : undefined;
    const page = Math.max(1, Number(req.query.page) || 1);
    return { seller: s, source: run ? "test" : tag, runId: run, q, page };
  }
  const qsOf = (f: Partial<ChatFilter & { page: number }>) => {
    const p = new URLSearchParams();
    if (f.seller) p.set("seller", f.seller);
    if (f.source) p.set("tag", f.source);
    if (f.runId) p.set("run", f.runId);
    if (f.q) p.set("q", f.q);
    if (f.page && f.page > 1) p.set("page", String(f.page));
    return p.size ? `?${p}` : "";
  };

  app.get("/admin/chats", d.requireAdmin, (req, res) => {
    const f = filterOf(req);
    const { rows, total } = db.listChats(f, { limit: PER_PAGE, offset: (f.page - 1) * PER_PAGE });
    const counts = db.chatCounts(f.seller);
    const all = Object.values(counts).reduce((a, b) => a + b, 0);
    const chip = (tag: ChatSource | undefined, label: string, n: number) =>
      `<a class="chip" href="/admin/chats${esc(qsOf({ seller: f.seller, source: tag, q: f.q }))}" aria-pressed="${f.source === tag && !(tag === undefined && f.runId)}">${esc(label)} <span class="n">${int(n)}</span></a>`;
    const chips = [chip(undefined, "All", all), ...CHAT_SOURCES.map((s) => chip(s, SOURCE_LABEL[s] + (s === "test" ? "s" : ""), counts[s]))].join("");
    const sellerOptions = [`<option value="">All sellers</option>`, ...sellers.list().map((s) => `<option value="${esc(s.config.slug)}"${s.config.slug === f.seller ? " selected" : ""}>${esc(s.config.name)}</option>`)].join("");
    const runs = f.source === "test" ? db.chatRuns(f.seller) : [];
    const runSelect = runs.length
      ? `<select name="run" aria-label="Test run" onchange="this.form.submit()"><option value="">All test runs</option>${runs
          .map((r) => `<option value="${esc(r.runId)}"${r.runId === f.runId ? " selected" : ""}>${esc(r.runId)} · ${int(r.chats)} chats · ${esc(d.fmtIST(r.startedAt))}</option>`)
          .join("")}</select>`
      : "";
    const summary = f.runId ? runSummary(f.runId, runTurns(db.chatTurnsFor({ runId: f.runId, seller: f.seller })), db.listChats({ runId: f.runId, seller: f.seller }, { limit: 100_000 }).rows, esc(qsOf({ runId: f.runId, seller: f.seller }))) : "";

    const testCols = rows.some((r) => r.expectedProduct);
    const body = rows
      .map((c) => {
        const tags = [`<span class="badge ${c.source === "test" ? "info" : "plain"}">${esc(SOURCE_LABEL[c.source])}</span>`, c.runId ? `<span class="badge plain">${esc(c.runId)}</span>` : "", c.label ? `<span class="badge plain">${esc(c.label)}</span>` : "", c.language ? `<span class="badge plain">${esc(c.language)}</span>` : ""].join("");
        const v = testCols && c.expectedProduct ? firstVerdicts(c, runTurns(db.chatTurns(c.chatId).map((turn) => ({ chat: c, turn })))) : {};
        return `<tr><td class="nowrap">${esc(d.fmtIST(c.startedAt))}</td><td>${esc(name(c.seller))}</td><td><div class="badges">${tags}</div>${c.scenarioId ? `<span class="muted small">${esc(c.scenarioId)}</span>` : ""}</td><td>${esc(c.buyerName ?? "")}${c.buyerMobile ? `<br><span class="muted small">${esc(c.buyerMobile)}</span>` : ""}</td><td class="tnum">${c.turns}</td><td>${esc(c.product ?? "")}${c.expectedProduct ? `<br><span class="muted small">expected: ${esc(c.expectedProduct)}</span>` : ""}</td>${testCols ? `<td class="nowrap">${c.expectedProduct ? `W ${mark(v.wordRules)} J ${mark(v.jev)} H ${mark(v.haiku)}` : ""}</td>` : ""}<td>${c.summaryShown ? '<span class="badge ok">Summary</span>' : ""}</td><td class="tnum">${usd(c.costUsd)}</td><td><a class="btn small" href="/admin/chats/${encodeURIComponent(c.chatId)}">Open</a></td></tr>`;
      })
      .join("");
    const pages = Math.max(1, Math.ceil(total / PER_PAGE));
    const pager =
      pages > 1
        ? `<nav class="pager" aria-label="Pages">${f.page > 1 ? `<a class="btn small" href="/admin/chats${esc(qsOf({ ...f, page: f.page - 1 }))}">← Newer</a>` : ""}<span class="muted small">Page ${f.page} of ${pages}</span>${f.page < pages ? `<a class="btn small" href="/admin/chats${esc(qsOf({ ...f, page: f.page + 1 }))}">Older →</a>` : ""}</nav>`
        : "";
    const importCard =
      f.source === "test"
        ? `<details class="card import-run"><summary><b>Import a run from files</b> <span class="muted small">for simulator runs made before chats were logged</span></summary>
<p class="card-desc">Choose the run folder's <code>turns.jsonl</code> and <code>conversations.jsonl</code>. Chats already imported are skipped.</p>
<form id="import-run" class="toolbar"><label class="field">turns.jsonl <input type="file" id="imp-turns" accept=".jsonl,.json,.txt" required></label><label class="field">conversations.jsonl (optional) <input type="file" id="imp-convs" accept=".jsonl,.json,.txt"></label><button class="btn primary" type="submit">Import</button><span id="imp-result" class="muted small" role="status"></span></form>
<script>
document.getElementById("import-run").addEventListener("submit", async function (e) {
  e.preventDefault();
  var out = document.getElementById("imp-result");
  var t = document.getElementById("imp-turns").files[0], c = document.getElementById("imp-convs").files[0];
  if (!t) return;
  out.textContent = "Importing…";
  var text = (await t.text()) + "\\n" + (c ? await c.text() : "");
  var r = await fetch("/admin/chats/import", { method: "POST", headers: { "Content-Type": "text/plain" }, body: text });
  var j = await r.json().catch(function () { return {}; });
  out.textContent = r.ok ? "Imported " + j.chats + " chats (" + j.turns + " turns); " + j.skipped + " already there, " + j.ignored + " lines ignored." : "Import failed: " + (j.error || r.status);
  if (r.ok && j.chats) setTimeout(function () { location.reload(); }, 1200);
});
</script></details>`
        : "";

    res.send(
      d.shell(
        "Chats",
        `<div class="page-head"><div><h1>Chats</h1><p class="muted">${int(total)} ${total === 1 ? "chat" : "chats"}${f.seller ? ` for ${esc(name(f.seller))}` : ""}${f.source ? ` · ${esc(SOURCE_LABEL[f.source])}${f.source === "test" ? "s" : ""}` : ""}, latest first. Each chat shows its turns with every model call and product pick.</p></div></div>
<form method="get" class="toolbar filters-bar">${f.source ? `<input type="hidden" name="tag" value="${esc(f.source)}">` : ""}<select name="seller" aria-label="Seller" onchange="this.form.submit()">${sellerOptions}</select>${runSelect}<input type="search" name="q" value="${esc(f.q ?? "")}" placeholder="Scenario, buyer, product or run" aria-label="Search chats"><button class="btn" type="submit">Search</button></form>
<div class="chips">${chips}</div>
${importCard}
${summary}
<div class="table-wrap">${
          body
            ? `<table><thead><tr><th>Started</th><th>Seller</th><th>Tags</th><th>Buyer</th><th>Turns</th><th>Product</th>${testCols ? '<th title="First product: word rules, Jev, Haiku">First pick W · J · H</th>' : ""}<th>Summary</th><th>Cost</th><th></th></tr></thead><tbody>${body}</tbody></table>`
            : '<div class="empty">No chats yet. Every conversation is logged here from now on.</div>'
        }</div>
${pager}`,
        "chats",
      ),
    );
  });

  app.get("/admin/chats/run.csv", d.requireAdmin, (req, res) => {
    const f = filterOf(req);
    if (!f.runId) {
      res.status(400).send("Choose a run.");
      return;
    }
    const turns = runTurns(db.chatTurnsFor({ runId: f.runId, seller: f.seller }));
    const kind = req.query.kind === "accuracy" ? "accuracy" : "calls";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${f.runId.replace(/[^A-Za-z0-9_.-]+/g, "_")}-${kind}.csv"`);
    res.send(kind === "accuracy" ? accuracyCsv(turns) : callsCsv(turns));
  });

  app.post("/admin/chats/import", d.requireAdmin, d.sameOriginPost, express.text({ type: "text/plain", limit: "25mb" }), (req, res) => {
    if (typeof req.body !== "string" || !req.body.trim()) {
      res.status(400).json({ error: "Send turns.jsonl (and conversations.jsonl) as text." });
      return;
    }
    res.json(importRun(db, req.body, { knownSeller: (s) => !!sellers.get(s) }));
  });

  app.get("/admin/chats/:chatId", d.requireAdmin, (req, res) => {
    const chat = db.chat(String(req.params.chatId));
    if (!chat) {
      res.status(404).send(d.shell("Not found", `<div class="panel empty">This chat isn't in the log. <a href="/admin/chats">Back to chats</a></div>`, "chats"));
      return;
    }
    const turns = db.chatTurns(chat.chatId);
    const rt = runTurns(turns.map((turn) => ({ chat, turn })));
    const tags = [`<span class="badge ${chat.source === "test" ? "info" : "plain"}">${esc(SOURCE_LABEL[chat.source])}</span>`, chat.runId ? `<a class="badge plain" href="/admin/chats?run=${encodeURIComponent(chat.runId)}">${esc(chat.runId)}</a>` : "", chat.label ? `<span class="badge plain">${esc(chat.label)}</span>` : "", chat.language ? `<span class="badge plain">${esc(chat.language)}</span>` : ""].join("");
    const tiles = [
      [int(chat.turns), "buyer messages"],
      [`${int(chat.inputTokens)} / ${int(chat.outputTokens)}`, "tokens in / out (replies)"],
      [usd(chat.costUsd), "cost"],
      [esc(chat.leadStage ?? "–"), "lead stage"],
      [esc(chat.product ?? "–"), "product"],
    ]
      .map(([b, s]) => `<div class="tile"><b class="tnum">${b}</b><span>${s}</span></div>`)
      .join("");
    const lines = turns
      .map((t, i) => {
        const chips = t.chips.length ? `<div class="reply-chips">${t.chips.map((c) => `<span>${esc(c)}</span>`).join("")}</div>` : "";
        const cards = t.cards.length ? `<div class="shared">${t.cards.map((c) => `<span>${esc(c.type)}: ${esc(c.title)}</span>`).join("")}</div>` : "";
        const summary = t.summary
          ? `<div class="chat-summary"><b>Summary card</b>${t.summary.rows.length ? `<dl>${t.summary.rows.map((r) => `<dt>${esc(r.label)}</dt><dd>${esc(r.value)}</dd>`).join("")}</dl>` : ""}${t.summary.note ? `<p class="muted small">${esc(t.summary.note)}</p>` : ""}</div>`
          : "";
        const totalMs = t.calls.reduce((a: number, c: any) => a + (c.latencyMs ?? 0), 0);
        const details = `<details class="turn-details"><summary>${t.calls.length} model ${t.calls.length === 1 ? "call" : "calls"} · ${usd(t.costUsd)} · ${ms(totalMs)}${t.fallback ? ' · <span class="warn-text">fallback reply</span>' : ""}</summary>${callsTable(t.calls)}${picksLine(rt[i]!, chat.expectedProduct)}${t.traceId ? `<p class="muted small">Trace <code>${esc(t.traceId)}</code></p>` : ""}</details>`;
        return `<div class="msg buyer"><div class="meta">Buyer · turn ${t.turn} · ${esc(d.fmtIST(t.at))}</div>${esc(t.buyer)}</div>
<div class="msg bot"><div class="meta">Assistant</div>${esc(t.reply)}${chips}${cards}${summary}</div>${details}`;
      })
      .join("");
    res.send(
      d.shell(
        "Chat",
        `<nav class="crumb" aria-label="Breadcrumb"><a href="/admin/chats">Chats</a> › <a href="/admin/chats?seller=${encodeURIComponent(chat.seller)}">${esc(name(chat.seller))}</a> › <span>Chat</span></nav>
<div class="page-head"><div><h1>${esc(chat.buyerName || "Chat")}${chat.buyerMobile ? ` <span class="muted small">${esc(chat.buyerMobile)}</span>` : ""}</h1><div class="badges">${tags}</div><p class="muted small">${esc(name(chat.seller))} · started ${esc(d.fmtIST(chat.startedAt))}${chat.scenarioId ? ` · scenario <code>${esc(chat.scenarioId)}</code>` : ""}${chat.expectedProduct ? ` · expected product <b>${esc(chat.expectedProduct)}</b>` : ""}</p></div><div class="btn-row">${d.sessionLink(`${chat.seller}:${chat.chatId}`)}<a class="btn small" href="/admin/transcript/${encodeURIComponent(chat.sessionId)}?chat=${encodeURIComponent(chat.chatId)}">Plain transcript</a></div></div>
<div class="tiles">${tiles}</div>
<div class="chat chat-log">${lines || '<div class="panel empty">No turns.</div>'}</div>`,
        "chats",
      ),
    );
  });
}
