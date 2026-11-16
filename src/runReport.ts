/**
 * Measuring the bot from its chats: per call type (Haiku replies, Jev pick, Haiku asked the same
 * question, a simulated buyer) tokens, latency and cost; and how often each product picker (word
 * rules, Jev, Haiku) chose the expected product. Used by the admin Chats page and the simulator's
 * report (scripts/sim-report.ts), so both always agree.
 */
import type { CallRecord, ProductPicks } from "./productPick.js";
import { namesFocus } from "./productMatch.js";

/** One buyer turn with its model calls and each picker's product (a chats-log row or a simulator turns.jsonl row). */
export interface RunTurn {
  seller: string;
  scenarioId: string;
  attempt: number;
  turn: number;
  language: string;
  suite: string;
  /** The scenario's product; empty when the chat is about none (off-topic) or not a test. */
  focus: string;
  buyer: string;
  /** The simulated buyer's own call (simulator runs only). */
  buyerCall?: { ms: number; inputTokens: number; outputTokens: number; costUsd: number };
  traceId?: string | null;
  calls: CallRecord[];
  product: ProductPicks;
}

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
export function callStats(turns: RunTurn[]): CallStats[] {
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
    if (t.buyerCall) add("Simulated buyer (not the bot)", "buyer", { input: t.buyerCall.inputTokens, output: t.buyerCall.outputTokens, latency: t.buyerCall.ms, cost: t.buyerCall.costUsd });
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
export function effective(t: RunTurn, p: Picker): string | null {
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
  examples: { onlyJev: RunTurn[]; onlyHaiku: RunTurn[] };
}

const tallies = () => ({ wordRules: emptyTally(), jev: emptyTally(), haiku: emptyTally() });

export function accuracy(turns: RunTurn[], maxExamples = 10): Accuracy {
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
  const byConv = new Map<string, RunTurn[]>();
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

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";

export function callsCsv(turns: RunTurn[]): string {
  const rows: unknown[][] = [["seller", "scenario", "attempt", "turn", "language", "suite", "kind", "model", "round", "input_tokens", "cache_read", "cache_write", "output_tokens", "latency_ms", "first_token_ms", "cost_usd", "decision", "error", "trace_id"]];
  for (const t of turns)
    for (const c of t.calls) rows.push([t.seller, t.scenarioId, t.attempt, t.turn, t.language, t.suite, c.kind, c.model, c.round ?? "", c.inputTokens, c.cacheRead ?? "", c.cacheWrite ?? "", c.outputTokens, c.latencyMs, c.firstTokenMs ?? "", c.costUsd ?? "", c.decision ?? "", c.error ?? "", t.traceId ?? ""]);
  return csv(rows);
}

export function accuracyCsv(turns: RunTurn[]): string {
  const rows: unknown[][] = [["seller", "scenario", "attempt", "turn", "language", "suite", "focus", "buyer", "current", "word_rules", "jev", "haiku", "used", "word_rules_verdict", "jev_verdict", "haiku_verdict"]];
  for (const t of turns) {
    if (t.product.jev === undefined) continue;
    const v = (p: Picker) => (t.focus ? verdict(t.focus, effective(t, p)) : "");
    rows.push([t.seller, t.scenarioId, t.attempt, t.turn, t.language, t.suite, t.focus, t.buyer, t.product.current ?? "", t.product.wordRules ?? "", t.product.jev ?? "unsure", t.product.haiku === undefined ? "" : (t.product.haiku ?? "unsure"), t.product.used ?? "", v("wordRules"), v("jev"), v("haiku")]);
  }
  return csv(rows);
}

