import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { namesFocus } from "../scripts/lib/productMatch.js";
import { appendJsonl, botText, buyerBrief, END, loadConfig, mobileFor, resumeState, runConversation, sessionIdFor, type BotApi, type BotReply, type Buyer, type TurnRow } from "../scripts/lib/sim.js";
import { accuracy, callStats, effective, finishedTurns, percentile, renderReport, accuracyCsv, callsCsv } from "../scripts/lib/simReport.js";

const scenario = { scenario_id: "jsm_tc_07_discovery", scenario: "Buyer wants to bend sheets.", language: "hinglish", focus_product: "Press Brakes", suite: "product_discovery", buyer_city: "Raipur" };

/** A scripted buyer: sends the lines in order, then [END]. */
const scriptedBuyer = (lines: string[]): Buyer & { seen: string[][] } => {
  const seen: string[][] = [];
  return {
    seen,
    async next(history) {
      seen.push(history.map((h) => `${h.from}: ${h.text}`));
      return { text: lines.shift() ?? END, ms: 5, inputTokens: 100, outputTokens: 10, costUsd: 0.00001 };
    },
  };
};

const reply = (over: Partial<BotReply> = {}): BotReply => ({ reply: "OK.", chips: [], cards: [], askFor: null, leadStage: "captured", ...over });

describe("simulator: one conversation", () => {
  it("plays the buyer against the bot, records every turn and stops at the summary card", async () => {
    const sent: any[] = [];
    const replies = [
      reply({ reply: "OTP sent.", askFor: "otp", leadStage: "otp_sent" }),
      reply({ reply: "Which thickness?", chips: ["Up to 6 mm", "Above 6 mm"], debug: { traceId: "t2", calls: [{ kind: "jev-pick", model: "jev-1.14.0", inputTokens: 900, outputTokens: 40, latencyMs: 230, costUsd: 0.00004, decision: "Press Brakes" }], product: { current: null, wordRules: null, jev: "Press Brakes", haiku: "Press Brakes", used: null } } }),
      reply({ reply: "Done.", summary: { rows: [{ label: "Product", value: "Press Brake" }] }, debug: { traceId: "t3", calls: [], product: { used: "Press Brakes" } } }),
      reply({ reply: "never reached" }),
    ];
    const api: BotApi = {
      details: async () => ({ greeting: "Welcome! Your mobile?", demoOtp: "12345", name: "X" }),
      chat: async (_slug, _key, body) => (sent.push(body), replies.shift()!),
    };
    const buyer = scriptedBuyer(["9876543210", "sheet bending machine chahiye", "Up to 6 mm", "anything else"]);
    const rows: TurnRow[] = [];
    const conv = await runConversation({ runId: "run-1", slug: "jsm", key: "k", scenario, attempt: 1, api, buyer, greeting: "Welcome! Your mobile?", maxTurns: 10, onTurn: (r) => rows.push(r) });

    expect(conv).toMatchObject({ turns: 3, summary: true, stop: "summary", finalProduct: "Press Brakes", focus: "Press Brakes", sessionId: sessionIdFor("run-1", "jsm", scenario.scenario_id, 1) });
    expect(sent.map((b) => b.message)).toEqual(["9876543210", "sheet bending machine chahiye", "Up to 6 mm"]);
    expect(sent[0].meta).toEqual({ runId: "run-1", scenarioId: scenario.scenario_id, label: "product_discovery", expectedProduct: "Press Brakes" });
    expect(new Set(sent.map((b) => b.sessionId)).size).toBe(1);
    expect(rows[1]).toMatchObject({ turn: 2, traceId: "t2", calls: [expect.objectContaining({ kind: "jev-pick" })], product: { jev: "Press Brakes" }, buyerCall: { inputTokens: 100 } });
    // The buyer sees the buttons the bot showed.
    expect(buyer.seen[2]!.at(-1)).toBe("bot: Which thickness?\n[Buttons: Up to 6 mm | Above 6 mm]");
  });

  it("stops when the buyer is done, and after three failed sends in a row", async () => {
    const api: BotApi = { details: async () => ({ greeting: "Hi", demoOtp: "12345", name: "X" }), chat: async () => reply() };
    expect(await runConversation({ runId: "r", slug: "s", key: "k", scenario, attempt: 1, api, buyer: scriptedBuyer([]), greeting: "Hi", maxTurns: 5 })).toMatchObject({ turns: 0, stop: "buyer_end" });
    const failing: BotApi = { ...api, chat: async () => Promise.reject(new Error("HTTP 500: boom")) };
    expect(await runConversation({ runId: "r", slug: "s", key: "k", scenario, attempt: 1, api: failing, buyer: scriptedBuyer(["a", "b", "c", "d"]), greeting: "Hi", maxTurns: 5 })).toMatchObject({ turns: 0, stop: "errors", error: "HTTP 500: boom" });
    expect(await runConversation({ runId: "r", slug: "s", key: "k", scenario, attempt: 1, api, buyer: scriptedBuyer(["a", "b", "c"]), greeting: "Hi", maxTurns: 2 })).toMatchObject({ turns: 2, stop: "max_turns" });
  });

  it("gives the buyer its brief, a fixed test identity and the OTP", () => {
    const brief = buyerBrief({ ...scenario, opening_message: "press brake chahiye" }, { mobile: mobileFor(scenario.scenario_id), otp: "12345" });
    expect(brief).toContain("Buyer wants to bend sheets.");
    expect(brief).toContain("Hinglish");
    expect(brief).toContain("the OTP is 12345");
    expect(brief).toContain("your city is Raipur");
    expect(brief).toContain("Your first message is: press brake chahiye");
    expect(mobileFor(scenario.scenario_id)).toMatch(/^9\d{9}$/);
    expect(mobileFor(scenario.scenario_id)).toBe(mobileFor(scenario.scenario_id));
    expect(sessionIdFor("2026-11-17-10-00", "jayshree-machinetools", "jsm_tc_01_price", 2)).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(botText(reply({ reply: "Here.", cards: [{ type: "product", title: "Press Brake", url: "u" }], summary: { rows: [{ label: "City", value: "Raipur" }] } }))).toBe('Here.\n[Shared: product "Press Brake"]\n[Enquiry summary: City: Raipur]');
  });

  it("reads the config (paths relative to it) and resumes a run", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-"));
    fs.writeFileSync(path.join(dir, "sim.config.json"), JSON.stringify({ baseUrl: "https://bot.example/", sellers: [{ slug: "jsm", keyEnv: "KEY_JSM", scenarios: "files/JSM_Scenarios.json" }] }));
    expect(loadConfig(path.join(dir, "sim.config.json"))).toEqual({ baseUrl: "https://bot.example", sellers: [{ slug: "jsm", keyEnv: "KEY_JSM", scenarios: path.join(dir, "files/JSM_Scenarios.json") }] });
    fs.writeFileSync(path.join(dir, "bad.json"), JSON.stringify({ baseUrl: "x", sellers: [{ slug: "jsm" }] }));
    expect(() => loadConfig(path.join(dir, "bad.json"))).toThrow(/keyEnv/);

    appendJsonl(path.join(dir, "turns.jsonl"), { seller: "jsm", scenarioId: "a", attempt: 1 });
    appendJsonl(path.join(dir, "turns.jsonl"), { seller: "jsm", scenarioId: "b", attempt: 2 });
    appendJsonl(path.join(dir, "conversations.jsonl"), { seller: "jsm", scenarioId: "a", attempt: 1 });
    const r = resumeState(dir);
    expect(r.done.has("jsm|a")).toBe(true);
    expect(r.done.has("jsm|b")).toBe(false);
    expect(r.nextAttempt("jsm", "b")).toBe(3);
    expect(r.nextAttempt("jsm", "c")).toBe(1);
  });
});

const turn = (over: Partial<TurnRow>): TurnRow => ({
  runId: "r",
  seller: "jsm",
  scenarioId: "s1",
  attempt: 1,
  turn: 1,
  language: "english",
  suite: "product_discovery",
  focus: "Press Brakes",
  buyer: "need a bending machine",
  buyerCall: { ms: 800, inputTokens: 300, outputTokens: 20, costUsd: 0.00004 },
  reply: "OK",
  chips: [],
  askFor: null,
  leadStage: "captured",
  summary: false,
  traceId: "t",
  calls: [],
  product: {},
  wallMs: 3000,
  at: "",
  ...over,
});

describe("simulation report", () => {
  it("adds up tokens, latency and cost per call type", () => {
    const turns = [
      turn({
        calls: [
          { kind: "jev-pick", model: "jev-1.14.0", inputTokens: 1000, outputTokens: 40, latencyMs: 200, costUsd: 0.000042 },
          { kind: "haiku-pick", model: "claude-haiku-5-5", inputTokens: 1500, outputTokens: 30, latencyMs: 1000, costUsd: 0.000165 },
          { kind: "reply", model: "claude-haiku-5-5", round: 1, inputTokens: 2000, outputTokens: 100, cacheRead: 40000, cacheWrite: 0, latencyMs: 2000, firstTokenMs: 1500, costUsd: 0.00065 },
          { kind: "reply", model: "claude-haiku-5-5", round: 2, inputTokens: 300, outputTokens: 50, cacheRead: 42000, cacheWrite: 0, latencyMs: 1000, firstTokenMs: 700, costUsd: 0.0005 },
        ],
      }),
    ];
    const s = callStats(turns);
    expect(s.map((x) => [x.label, x.calls])).toEqual([
      ["Haiku reply (one call)", 2],
      ["Haiku reply (whole turn)", 1],
      ["Jev product pick", 1],
      ["Haiku product pick (same question)", 1],
      ["Simulated buyer (not the bot)", 1],
    ]);
    const whole = s.find((x) => x.label === "Haiku reply (whole turn)")!;
    expect(whole.input.mean).toBe(2000 + 40000 + 300 + 42000);
    expect(whole.latency.mean).toBe(3000);
    expect(whole.firstToken?.mean).toBe(1500);
    expect(whole.costTotal).toBeCloseTo(0.00115);
    expect(s.find((x) => x.label === "Jev product pick")!.costMean).toBeCloseTo(0.000042);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
  });

  it("scores each picker's product as if it decided: keep is the current product, unsure falls back to the word rules", () => {
    const t = turn({ product: { current: "Shearing Machines", wordRules: "Shearing Machines", jev: "keep", haiku: null, used: "Shearing Machines" } });
    expect(effective(t, "jev")).toBe("Shearing Machines");
    expect(effective(t, "haiku")).toBe("Shearing Machines");
    expect(effective(turn({ product: { wordRules: null, jev: "Press Brakes", haiku: "CNC Press Brakes" } }), "haiku")).toBe("CNC Press Brakes");
    expect(namesFocus("Press Brakes", "Hydraulic Press Brake Machine")).toBe(true);

    const turns = [
      turn({ scenarioId: "s1", turn: 1, product: { current: null, wordRules: null, jev: "Press Brakes", haiku: null } }),
      turn({ scenarioId: "s2", turn: 1, language: "hinglish", product: { current: null, wordRules: "Shearing Machines", jev: "Shearing Machines", haiku: "Press Brakes" } }),
      turn({ scenarioId: "s3", focus: "", suite: "out_of_scope", product: { current: null, wordRules: "Press Brakes", jev: "keep", haiku: "Press Brakes" } }),
      // Jev not asked (login step): left out.
      turn({ scenarioId: "s4", product: { used: null } }),
    ];
    const a = accuracy(turns);
    expect(a.compared).toBe(2);
    expect(a.perTurn.jev).toEqual({ turns: 2, right: 1, wrong: 1, none: 0 });
    expect(a.perTurn.haiku).toEqual({ turns: 2, right: 1, wrong: 0, none: 1 });
    expect(a.perTurn.wordRules).toEqual({ turns: 2, right: 0, wrong: 1, none: 1 });
    expect(a.agreement).toEqual({ bothRight: 0, onlyJev: 1, onlyHaiku: 1, bothWrongOrNone: 0 });
    expect(a.offTopic).toEqual({ turns: 1, picks: { wordRules: 1, jev: 0, haiku: 1 } });
    expect(a.decisions.jev).toEqual({ pick: 2, keep: 1, unsure: 0 });
    expect(a.byLanguage.hinglish!.haiku.right).toBe(1);
    expect(a.firstProduct.jev).toEqual({ turns: 3, right: 1, wrong: 1, none: 1 });

    const md = renderReport({ runId: "r" }, turns, [{ seller: "jsm", scenarioId: "s1", stop: "summary" } as never]);
    expect(md).toContain("## Tokens, latency and cost per call");
    expect(md).toContain("| Jev | 50% | 50% | 0% |");
    expect(accuracyCsv(turns).split("\n")[0]).toContain("jev_verdict");
    expect(callsCsv(turns).split("\n")).toHaveLength(2);
    expect(finishedTurns(turns, [{ seller: "jsm", scenarioId: "s1", attempt: 1 } as never])).toHaveLength(1);
  });
});
