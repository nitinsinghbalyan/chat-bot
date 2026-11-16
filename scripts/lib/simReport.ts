/**
 * The simulation report as Markdown (scripts/sim-report.ts). The maths is in src/runReport.ts, shared
 * with the admin Chats page.
 */
import { accuracy, callStats, PICKERS, type Picker, type RunTurn, type Tally } from "../../src/runReport.js";
import type { ConversationRow, TurnRow } from "./sim.js";

export * from "../../src/runReport.js";

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
  const ex = (title: string, list: RunTurn[]) => {
    if (!list.length) return;
    L.push(`### ${title}`, "");
    for (const t of list) L.push(`- [${t.seller} · ${t.language}] "${t.buyer.slice(0, 140)}" → wanted ${t.focus}; Jev ${t.product.jev ?? "unsure"}, Haiku ${t.product.haiku ?? "unsure"}, word rules ${t.product.wordRules ?? "none"}`);
    L.push("");
  };
  ex("Only Jev right", acc.examples.onlyJev);
  ex("Only Haiku right", acc.examples.onlyHaiku);
  return L.join("\n");
}

/** Keeps only the turns of conversations that finished (a cut-off attempt that was rerun is left out). */
export function finishedTurns(turns: TurnRow[], conversations: ConversationRow[]): TurnRow[] {
  const keep = new Set(conversations.map((c) => `${c.seller}|${c.scenarioId}|${c.attempt}`));
  return turns.filter((t) => keep.has(`${t.seller}|${t.scenarioId}|${t.attempt}`));
}
