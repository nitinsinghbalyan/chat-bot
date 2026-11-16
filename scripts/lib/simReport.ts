/**
 * The simulation report: per call type (Haiku replies, Jev pick, Haiku asked the same question, the
 * simulated buyer) tokens, latency and cost; and how often each product picker (word rules, Jev,
 * Haiku) chose the scenario's product. Pure functions over a run's turns.jsonl / conversations.jsonl.
 */
import { namesFocus } from "./productMatch.js";
import type { ConversationRow, TurnRow } from "./sim.js";

// ---- numbers ----

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

export interface CallStats {
  label: string;
  model: string;
  calls: number;
  input: { mean: number; p50: number; p95: number };
  output: { mean: number; p50: number; p95: number };
  cacheReadMean: number | null;
  latency: { mean: number; p50: number; p95: number };
  firstToken: { mean: number; p50: number; p95: number } | null;
  costMean: number;
  costTotal: number;
}

interface Sample {
  input: number;
  output: number;
  cacheRead?: number;
  latency: number;
  firstToken?: number | null;
  cost: number;
}

function stats(label: string, model: string, xs: Sample[]): CallStats {
  const tri = (v: number[]) => ({ mean: mean(v), p50: percentile(v, 50), p95: percentile(v, 95) });
  const ft = xs.map((x) => x.firstToken).filter((v): v is number => typeof v === "number");
  const cr = xs.map((x) => x.cacheRead).filter((v): v is number => typeof v === "number");
  return {
    label,
    model,
    calls: xs.length,
    input: tri(xs.map((x) => x.input)),
    output: tri(xs.map((x) => x.output)),
    cacheReadMean: cr.length ? mean(cr) : null,
    latency: tri(xs.map((x) => x.latency)),
    firstToken: ft.length ? tri(ft) : null,
    costMean: mean(xs.map((x) => x.cost)),
    costTotal: xs.reduce((a, x) => a + x.cost, 0),
  };
}

/** Tokens, latency and cost per call type. A reply's "input" counts every prompt token (uncached + cache read + cache write). */
export function callStats(turns: TurnRow[]): CallStats[] {
  const groups = new Map<string, { label: string; model: string; xs: Sample[] }>();
  const add = (label: string, model: string, x: Sample) => {
    const k = `${label}|${model}`;
    const g = groups.get(k) ?? { label, model, xs: [] };
    g.xs.push(x);
    groups.set(k, g);
  };
  for (const t of turns) {
    const replies = t.calls.filter((c) => c.kind === "reply");
    for (const c of t.calls) {
      if (c.error) continue;
      const label = c.kind === "reply" ? "Haiku reply (one call)" : c.kind === "jev-pick" ? "Jev product pick" : "Haiku product pick (same question)";
      add(label, c.model, { input: c.inputTokens + (c.cacheRead ?? 0) + (c.cacheWrite ?? 0), output: c.outputTokens, cacheRead: c.kind === "reply" ? (c.cacheRead ?? 0) : undefined, latency: c.latencyMs, firstToken: c.firstTokenMs, cost: c.costUsd ?? 0 });
    }
    if (replies.length)
      add("Haiku reply (whole turn)", replies[0]!.model, {
        input: replies.reduce((a, c) => a + c.inputTokens + (c.cacheRead ?? 0) + (c.cacheWrite ?? 0), 0),
        output: replies.reduce((a, c) => a + c.outputTokens, 0),
        cacheRead: replies.reduce((a, c) => a + (c.cacheRead ?? 0), 0),
        latency: replies.reduce((a, c) => a + c.latencyMs, 0),
        firstToken: replies[0]!.firstTokenMs,
        cost: replies.reduce((a, c) => a + (c.costUsd ?? 0), 0),
      });
    add("Simulated buyer (not the bot)", "buyer", { input: t.buyerCall.inputTokens, output: t.buyerCall.outputTokens, latency: t.buyerCall.ms, cost: t.buyerCall.costUsd });
  }
  const order = ["Haiku reply (one call)", "Haiku reply (whole turn)", "Jev product pick", "Haiku product pick (same question)", "Simulated buyer (not the bot)"];
  return [...groups.values()].sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label)).map((g) => stats(g.label, g.model, g.xs));
}

// ---- accuracy ----

export type Picker = "wordRules" | "jev" | "haiku";
export const PICKERS: Array<{ id: Picker; name: string }> = [
  { id: "wordRules", name: "Word rules" },
  { id: "jev", name: "Jev" },
  { id: "haiku", name: "Haiku (same question)" },
];

export type Verdict = "right" | "wrong" | "none";

/**
 * The product a picker leaves the chat with this turn, as if it were the one deciding (Jev "On"):
 * its product, the current one on "keep", or the word rules' when it is unsure. The word rules' own
 * value already is that.
 */
export function effective(t: TurnRow, p: Picker): string | null {
  const pr = t.product;
  if (p === "wordRules") return pr.wordRules ?? null;
  const d = pr[p];
  if (d === undefined) return null;
  if (d === "keep") return pr.current ?? null;
  if (d === null) return pr.wordRules ?? null;
  return d;
}

export const verdict = (focus: string, product: string | null): Verdict => (!product ? "none" : namesFocus(focus, product) ? "right" : "wrong");

export interface Tally {
  turns: number;
  right: number;
  wrong: number;
  none: number;
}
const emptyTally = (): Tally => ({ turns: 0, right: 0, wrong: 0, none: 0 });

export interface Accuracy {
  /** Turns where Jev and Haiku were both asked, in scenarios with a known product. */
  compared: number;
  perTurn: Record<Picker, Tally>;
  byLanguage: Record<string, Record<Picker, Tally>>;
  bySuite: Record<string, Record<Picker, Tally>>;
  bySeller: Record<string, Record<Picker, Tally>>;
  /** Per conversation: the first product each picker would have set. */
  firstProduct: Record<Picker, Tally>;
  /** Scenarios without a product (out of scope, adversarial…): turns where a picker chose a product. */
  offTopic: { turns: number; picks: Record<Picker, number> };
  /** Jev's and Haiku's own answers (before any fallback). */
  decisions: Record<"jev" | "haiku", { pick: number; keep: number; unsure: number }>;
  agreement: { bothRight: number; onlyJev: number; onlyHaiku: number; bothWrongOrNone: number };
  examples: { onlyJev: TurnRow[]; onlyHaiku: TurnRow[] };
}

const tallies = () => ({ wordRules: emptyTally(), jev: emptyTally(), haiku: emptyTally() });

export function accuracy(turns: TurnRow[], maxExamples = 10): Accuracy {
  const a: Accuracy = {
    compared: 0,
    perTurn: tallies(),
    byLanguage: {},
    bySuite: {},
    bySeller: {},
    firstProduct: tallies(),
    offTopic: { turns: 0, picks: { wordRules: 0, jev: 0, haiku: 0 } },
    decisions: { jev: { pick: 0, keep: 0, unsure: 0 }, haiku: { pick: 0, keep: 0, unsure: 0 } },
    agreement: { bothRight: 0, onlyJev: 0, onlyHaiku: 0, bothWrongOrNone: 0 },
    examples: { onlyJev: [], onlyHaiku: [] },
  };
  const bump = (t: Tally, v: Verdict) => (t.turns++, t[v]++);
  const asked = turns.filter((t) => t.product.jev !== undefined && t.product.haiku !== undefined);
  for (const t of asked) {
    for (const p of ["jev", "haiku"] as const) {
      const d = t.product[p];
      a.decisions[p][d === null ? "unsure" : d === "keep" ? "keep" : "pick"]++;
    }
    if (!t.focus) {
      a.offTopic.turns++;
      if (t.product.wordRules && t.product.wordRules !== t.product.current) a.offTopic.picks.wordRules++;
      for (const p of ["jev", "haiku"] as const) if (t.product[p] && t.product[p] !== "keep") a.offTopic.picks[p]++;
      continue;
    }
    a.compared++;
    const v = {} as Record<Picker, Verdict>;
    for (const { id } of PICKERS) {
      v[id] = verdict(t.focus, effective(t, id));
      bump(a.perTurn[id], v[id]);
      bump(((a.byLanguage[t.language || "unknown"] ??= tallies()) as Record<Picker, Tally>)[id], v[id]);
      bump(((a.bySuite[t.suite || "unknown"] ??= tallies()) as Record<Picker, Tally>)[id], v[id]);
      bump(((a.bySeller[t.seller] ??= tallies()) as Record<Picker, Tally>)[id], v[id]);
    }
    if (v.jev === "right" && v.haiku === "right") a.agreement.bothRight++;
    else if (v.jev === "right") (a.agreement.onlyJev++, a.examples.onlyJev.length < maxExamples && a.examples.onlyJev.push(t));
    else if (v.haiku === "right") (a.agreement.onlyHaiku++, a.examples.onlyHaiku.length < maxExamples && a.examples.onlyHaiku.push(t));
    else a.agreement.bothWrongOrNone++;
  }
  // First product per conversation (scenarios with a product): the first turn where each picker set one.
  const byConv = new Map<string, TurnRow[]>();
  for (const t of turns) if (t.focus) byConv.set(`${t.seller}|${t.scenarioId}|${t.attempt}`, [...(byConv.get(`${t.seller}|${t.scenarioId}|${t.attempt}`) ?? []), t]);
  for (const list of byConv.values()) {
    list.sort((x, y) => x.turn - y.turn);
    for (const { id } of PICKERS) {
      const first = list.map((t) => effective(t, id)).find((x) => x);
      bump(a.firstProduct[id], verdict(list[0]!.focus, first ?? null));
    }
  }
  return a;
}

// ---- the report ----

const usd = (n: number) => (n === 0 ? "$0" : n < 0.001 ? `$${n.toFixed(6)}` : n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const int = (n: number) => Math.round(n).toLocaleString("en-US");
const ms = (n: number) => `${int(n)} ms`;
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "–");
const row = (cells: Array<string | number>) => `| ${cells.join(" | ")} |`;

function tallyTable(title: string, groups: Record<string, Record<Picker, Tally>>): string[] {
  const out = [`### ${title}`, "", row(["", ...PICKERS.map((p) => `${p.name} right / wrong`), "turns"]), row(["---", ...PICKERS.map(() => "---"), "---"])];
  for (const [k, g] of Object.entries(groups).sort()) out.push(row([k, ...PICKERS.map((p) => `${pct(g[p.id].right, g[p.id].turns)} / ${pct(g[p.id].wrong, g[p.id].turns)}`), g.jev.turns]));
  return [...out, ""];
}

export function renderReport(run: { runId: string; health?: any; buyerModel?: string }, turns: TurnRow[], conversations: ConversationRow[]): string {
  const cs = callStats(turns);
  const acc = accuracy(turns);
  const botCost = turns.reduce((a, t) => a + t.calls.reduce((b, c) => b + (c.costUsd ?? 0), 0), 0);
  const replyCost = turns.reduce((a, t) => a + t.calls.filter((c) => c.kind === "reply").reduce((b, c) => b + (c.costUsd ?? 0), 0), 0);
  const buyerCost = turns.reduce((a, t) => a + t.buyerCall.costUsd, 0);
  const convs = conversations.length;
  const stops = conversations.reduce<Record<string, number>>((m, c) => ((m[c.stop] = (m[c.stop] ?? 0) + 1), m), {});
  const L: string[] = [];
  L.push(`# Simulation report: ${run.runId}`, "");
  L.push(
    `${convs} conversations, ${turns.length} bot turns (${convs ? (turns.length / convs).toFixed(1) : "–"} per conversation). Ended with the summary card: ${stops.summary ?? 0}, buyer ended: ${stops.buyer_end ?? 0}, turn limit: ${stops.max_turns ?? 0}, errors: ${stops.errors ?? 0}.`,
  );
  if (run.health) L.push(`Bot build ${run.health.build?.commit ?? "?"}, reply model ${run.health.model ?? "?"}, Jev ${run.health.jev?.mode ?? "?"} (${run.health.jev?.model ?? "?"}).`);
  L.push("");
  L.push("## Tokens, latency and cost per call", "");
  L.push(row(["Call", "Model", "Calls", "Input tokens mean / p50 / p95", "Output tokens mean / p95", "Cache read (mean)", "Latency mean / p50 / p95", "First token mean / p95", "Cost per call", "Total cost"]));
  L.push(row(Array(10).fill("---")));
  for (const s of cs)
    L.push(
      row([
        s.label,
        s.model,
        int(s.calls),
        `${int(s.input.mean)} / ${int(s.input.p50)} / ${int(s.input.p95)}`,
        `${int(s.output.mean)} / ${int(s.output.p95)}`,
        s.cacheReadMean === null ? "–" : int(s.cacheReadMean),
        `${ms(s.latency.mean)} / ${ms(s.latency.p50)} / ${ms(s.latency.p95)}`,
        s.firstToken ? `${ms(s.firstToken.mean)} / ${ms(s.firstToken.p95)}` : "–",
        usd(s.costMean),
        usd(s.costTotal),
      ]),
    );
  L.push("");
  L.push(
    `Bot cost: ${usd(botCost)} in total (replies ${usd(replyCost)}), ${usd(convs ? botCost / convs : 0)} per conversation, ${usd(turns.length ? (1000 * botCost) / turns.length : 0)} per 1,000 buyer messages. The simulated buyer cost ${usd(buyerCost)} more (not part of the bot).`,
    "",
  );
  L.push("## Product pick: Jev vs Haiku vs word rules", "");
  L.push(
    `Scored on the ${acc.compared} turns where both Jev and Haiku were asked (after login, not a tapped button or closing-step answer) in scenarios with a known product, against the scenario's \`focus_product\`. Each picker's product is what the chat would have if that picker decided: its own pick, the current product on "keep", and the word rules' when it is unsure. The bot itself followed the word rules (Jev in Shadow), so later turns build on their choice.`,
    "",
  );
  L.push(row(["Picker", "Right", "Wrong", "No product", "First product of the chat right / wrong"]), row(Array(5).fill("---")));
  for (const p of PICKERS) {
    const t = acc.perTurn[p.id];
    const f = acc.firstProduct[p.id];
    L.push(row([p.name, pct(t.right, t.turns), pct(t.wrong, t.turns), pct(t.none, t.turns), `${pct(f.right, f.turns)} / ${pct(f.wrong, f.turns)} (${f.turns} chats)`]));
  }
  L.push("");
  L.push(
    `Off-topic scenarios (no product): ${acc.offTopic.turns} turns; a product was chosen by the word rules on ${acc.offTopic.picks.wordRules}, Jev on ${acc.offTopic.picks.jev}, Haiku on ${acc.offTopic.picks.haiku}.`,
    `Own answers: Jev picked ${acc.decisions.jev.pick}, kept ${acc.decisions.jev.keep}, unsure ${acc.decisions.jev.unsure}; Haiku picked ${acc.decisions.haiku.pick}, kept ${acc.decisions.haiku.keep}, unsure ${acc.decisions.haiku.unsure}.`,
    `Agreement on product turns: both right ${acc.agreement.bothRight}, only Jev right ${acc.agreement.onlyJev}, only Haiku right ${acc.agreement.onlyHaiku}, neither ${acc.agreement.bothWrongOrNone}.`,
    "",
  );
  L.push(...tallyTable("By language", acc.byLanguage), ...tallyTable("By suite", acc.bySuite), ...tallyTable("By seller", acc.bySeller));
  const ex = (title: string, list: TurnRow[]) => {
    if (!list.length) return;
    L.push(`### ${title}`, "");
    for (const t of list) L.push(`- [${t.seller} · ${t.language}] "${t.buyer.slice(0, 140)}" → wanted ${t.focus}; Jev ${t.product.jev ?? "unsure"}, Haiku ${t.product.haiku ?? "unsure"}, word rules ${t.product.wordRules ?? "none"}`);
    L.push("");
  };
  ex("Only Jev right", acc.examples.onlyJev);
  ex("Only Haiku right", acc.examples.onlyHaiku);
  return L.join("\n");
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";

export function callsCsv(turns: TurnRow[]): string {
  const rows: unknown[][] = [["seller", "scenario", "attempt", "turn", "language", "suite", "kind", "model", "round", "input_tokens", "cache_read", "cache_write", "output_tokens", "latency_ms", "first_token_ms", "cost_usd", "decision", "error", "trace_id"]];
  for (const t of turns)
    for (const c of t.calls) rows.push([t.seller, t.scenarioId, t.attempt, t.turn, t.language, t.suite, c.kind, c.model, c.round ?? "", c.inputTokens, c.cacheRead ?? "", c.cacheWrite ?? "", c.outputTokens, c.latencyMs, c.firstTokenMs ?? "", c.costUsd ?? "", c.decision ?? "", c.error ?? "", t.traceId ?? ""]);
  return csv(rows);
}

export function accuracyCsv(turns: TurnRow[]): string {
  const rows: unknown[][] = [["seller", "scenario", "attempt", "turn", "language", "suite", "focus", "buyer", "current", "word_rules", "jev", "haiku", "used", "word_rules_verdict", "jev_verdict", "haiku_verdict"]];
  for (const t of turns) {
    if (t.product.jev === undefined) continue;
    const v = (p: Picker) => (t.focus ? verdict(t.focus, effective(t, p)) : "");
    rows.push([t.seller, t.scenarioId, t.attempt, t.turn, t.language, t.suite, t.focus, t.buyer, t.product.current ?? "", t.product.wordRules ?? "", t.product.jev ?? "unsure", t.product.haiku === undefined ? "" : (t.product.haiku ?? "unsure"), t.product.used ?? "", v("wordRules"), v("jev"), v("haiku")]);
  }
  return csv(rows);
}

/** Keeps only the turns of conversations that finished (a cut-off attempt that was rerun is left out). */
export function finishedTurns(turns: TurnRow[], conversations: ConversationRow[]): TurnRow[] {
  const keep = new Set(conversations.map((c) => `${c.seller}|${c.scenarioId}|${c.attempt}`));
  return turns.filter((t) => keep.has(`${t.seller}|${t.scenarioId}|${t.attempt}`));
}
