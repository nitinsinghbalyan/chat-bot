/**
 * The conversation simulator's parts (scripts/simulate.ts runs them): the scenario files, a small
 * Bot API client, the simulated buyer (Claude playing the scenario's persona) and one conversation.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { CallRecord, ProductPicks } from "../../src/productPick.js";
import { costDetails } from "../../src/tracing.js";
import { buyerTurns, numberOf, readCsv } from "./csv.js";

/** One persona brief from a seller's *_Scenarios.json. */
export interface Scenario {
  scenario_id: string;
  scenario: string;
  language: string;
  opening_message?: string;
  focus_product?: string;
  suite?: string;
  buyer_name?: string;
  buyer_city?: string;
  expected_outcome?: string;
}

export interface SellerRun {
  slug: string;
  /** The environment variable that holds this seller's Bot API Test key. */
  keyEnv: string;
  /** Path to the seller's *_Scenarios.json (relative to the config file). */
  scenarios: string;
  /** Path to the seller's *_Bot_Test_Cases.csv (relative to the config file): the scripted buyer's messages. */
  testCases?: string;
}

export interface SimConfig {
  baseUrl: string;
  sellers: SellerRun[];
}

export function loadConfig(file: string): SimConfig {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SimConfig>;
  if (!raw.baseUrl || !Array.isArray(raw.sellers) || !raw.sellers.length) throw new Error(`${file}: needs "baseUrl" and a non-empty "sellers" list`);
  const dir = path.dirname(path.resolve(file));
  return {
    baseUrl: raw.baseUrl.replace(/\/+$/, ""),
    sellers: raw.sellers.map((s, i) => {
      if (!s?.slug || !s.keyEnv || !s.scenarios) throw new Error(`${file}: sellers[${i}] needs "slug", "keyEnv" and "scenarios"`);
      return { slug: s.slug, keyEnv: s.keyEnv, scenarios: path.resolve(dir, s.scenarios), ...(s.testCases ? { testCases: path.resolve(dir, s.testCases) } : {}) };
    }),
  };
}

/** The scripted buyer's messages per scenario number, from the test cases' Buyer_Input (multi-turn scripts split into turns). */
export function loadTestMessages(file: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const r of readCsv(fs.readFileSync(file, "utf8"))) if (r.Buyer_Input?.trim()) out.set(numberOf(r.Test_ID ?? ""), buyerTurns(r.Buyer_Input));
  return out;
}

export function loadScenarios(file: string): Scenario[] {
  const list = JSON.parse(fs.readFileSync(file, "utf8")) as Scenario[];
  if (!Array.isArray(list)) throw new Error(`${file}: expected a list of scenarios`);
  return list.filter((s) => s?.scenario_id && s.scenario);
}

const hash = (t: string) => crypto.createHash("sha1").update(t).digest("hex");
/** The Bot API takes 8–64 letters, digits, - and _. */
export const sessionIdFor = (runId: string, slug: string, scenarioId: string, attempt: number) => `sim_${hash(`${runId}|${slug}|${scenarioId}`).slice(0, 20)}_${attempt}`;
/** A stable, made-up Indian mobile number per scenario (starts with 9). */
export const mobileFor = (scenarioId: string) => `9${(parseInt(hash(scenarioId).slice(0, 12), 16) % 1e9).toString().padStart(9, "0")}`;

// ---- the Bot API ----

export interface BotReply {
  reply: string;
  chips: string[];
  cards: Array<{ type: string; title: string; url: string }>;
  summary?: { rows: Array<{ label: string; value: string }>; note?: string };
  askFor: string | null;
  leadStage: string;
  traceId?: string;
  debug?: { traceId: string | null; calls: CallRecord[]; product: ProductPicks };
}

export interface BotApi {
  details(slug: string, key: string): Promise<{ greeting: string; demoOtp: string; name: string }>;
  chat(slug: string, key: string, body: { sessionId: string; message: string; meta: Record<string, string> }): Promise<BotReply>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The Bot API over HTTP: waits and retries on 409 (busy), 429 (rate limit) and server or network errors. */
export function httpBotApi(baseUrl: string, fetchImpl: typeof fetch = fetch, waitMs = { busy: 2000, limited: 15_000, error: 3000 }): BotApi {
  async function call(url: string, init: RequestInit): Promise<any> {
    for (let attempt = 1; ; attempt++) {
      let status = 0;
      let text = "";
      try {
        const res = await fetchImpl(url, init);
        status = res.status;
        text = await res.text();
        if (res.ok) return JSON.parse(text);
      } catch (err) {
        text = (err as Error).message;
      }
      const retry = status === 409 ? waitMs.busy : status === 429 ? waitMs.limited : status === 0 || status >= 500 ? waitMs.error : 0;
      if (!retry || attempt >= 6) throw new Error(`HTTP ${status || "error"}: ${text.slice(0, 200)}`);
      await sleep(retry * Math.min(attempt, 3));
    }
  }
  return {
    details: (slug, key) => call(`${baseUrl}/api/v1/bots/${slug}`, { headers: { "X-Bot-Key": key } }),
    chat: (slug, key, body) => call(`${baseUrl}/api/v1/bots/${slug}/chat`, { method: "POST", headers: { "X-Bot-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  };
}

// ---- the simulated buyer ----

export interface BuyerTurn {
  text: string;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Writes the buyer's next message from the conversation so far (bot and buyer messages, oldest first) and the bot's last reply. */
export interface Buyer {
  next(history: Array<{ from: "bot" | "buyer"; text: string }>, last?: BotReply | null): Promise<BuyerTurn>;
}

/**
 * A rule-based buyer (no model, no cost): logs in with the test identity, sends the scenario's own
 * test messages in order, then taps the first button the bot shows and answers the closing steps
 * (quantity, firm, city) until the summary card or nothing more to say.
 */
export function scriptedBuyer(s: Scenario, ids: { mobile: string; otp: string }, lines: string[]): Buyer {
  const queue = lines.length ? [...lines] : s.opening_message?.trim() ? [s.opening_message.trim()] : [];
  let sentMobile = false;
  let taps = 0;
  let filler = 0;
  const say = (text: string): BuyerTurn => ({ text, ms: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
  return {
    async next(history, last) {
      if (last?.summary) return say(END);
      const bot = last?.reply ?? history.at(-1)?.text ?? "";
      if (last?.askFor === "otp") return say(ids.otp);
      if (last?.askFor === "name") return say(s.buyer_name?.trim() || "Ramesh");
      if (last?.askFor === "mobile" || !sentMobile) return (sentMobile = true), say(ids.mobile);
      if (queue.length) return say(queue.shift()!);
      if (last?.chips?.length && taps < 10) return taps++, say(last.chips[0]!);
      if (/quantity|how many|kitn[eia]|pieces|units|\bqty\b|kitna chahiye/i.test(bot)) return say("2");
      if (/firm|company( name)?|business name|firm ka naam/i.test(bot)) return say("Test Traders");
      if (/city|deliver|location|shahar|kahan/i.test(bot)) return say(s.buyer_city?.trim() || "Pune");
      if (/individual|business/i.test(bot)) return say("Business");
      return ++filler > 2 ? say(END) : say(filler === 1 ? "Yes, please go ahead." : "That's all I need for now.");
    },
  };
}

export const END = "[END]";

export function buyerBrief(s: Scenario, ids: { mobile: string; otp: string }): string {
  const hinglish = /hinglish|hindi/i.test(s.language);
  return [
    "You are role-playing a buyer who chats with a seller's website chat assistant, to test that assistant. Stay in character the whole time.",
    `<brief>\n${s.scenario}\n</brief>`,
    `Write the way this buyer types in a chat box: short messages, ${hinglish ? "in Hinglish (Hindi written in Latin letters, mixed with English)" : "in plain English"}.`,
    `If the assistant asks: your mobile number is ${ids.mobile}; the OTP is ${ids.otp} (send just the digits); your name is ${s.buyer_name?.trim() || "a common Indian name you choose and keep"}; your city is ${s.buyer_city?.trim() || "an Indian city you choose and keep"}.`,
    s.opening_message?.trim() ? `Your first message is: ${s.opening_message.trim()}` : "",
    "Rules:",
    "- Write only your next message: no quotes, labels, notes or stage directions.",
    "- When the assistant shows buttons, you may tap one by sending its exact text.",
    "- Keep each message under 40 words.",
    `- When your need is met, the assistant has shown your enquiry summary, or the chat can't go further, reply with exactly ${END}.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Claude (Haiku by default) plays the buyer: bot messages are the user turns, the buyer's are the assistant turns. */
export function claudeBuyer(client: Anthropic, model: string, brief: string): Buyer {
  return {
    async next(history) {
      const messages = history.map((m) => ({ role: m.from === "bot" ? ("user" as const) : ("assistant" as const), content: m.text || "(no text)" }));
      const started = Date.now();
      const res = await client.messages.create({ model, max_tokens: 1024, system: brief, messages, output_config: { effort: "low" } }, { timeout: 60_000 });
      const u = { input: res.usage.input_tokens, output: res.usage.output_tokens, cacheRead: res.usage.cache_read_input_tokens ?? 0, cacheWrite: res.usage.cache_creation_input_tokens ?? 0 };
      const text = res.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim()
        .replace(/^["“]|["”]$/g, "");
      return { text: res.stop_reason === "refusal" ? END : text, ms: Date.now() - started, inputTokens: u.input + u.cacheRead + u.cacheWrite, outputTokens: u.output, costUsd: costDetails(res.model || model, u)?.total ?? 0 };
    },
  };
}

/** What the buyer sees of a bot reply: the text, then any buttons, cards and the summary card. */
export function botText(r: Pick<BotReply, "reply" | "chips" | "cards" | "summary">): string {
  const parts = [r.reply.trim()];
  if (r.chips?.length) parts.push(`[Buttons: ${r.chips.join(" | ")}]`);
  if (r.cards?.length) parts.push(`[Shared: ${r.cards.map((c) => `${c.type} "${c.title}"`).join(", ")}]`);
  if (r.summary) parts.push(`[Enquiry summary: ${r.summary.rows.map((x) => `${x.label}: ${x.value}`).join("; ")}]`);
  return parts.filter(Boolean).join("\n");
}

// ---- one conversation ----

export interface TurnRow {
  runId: string;
  seller: string;
  scenarioId: string;
  attempt: number;
  turn: number;
  language: string;
  suite: string;
  focus: string;
  buyer: string;
  buyerCall: Omit<BuyerTurn, "text">;
  reply: string;
  chips: string[];
  askFor: string | null;
  leadStage: string;
  summary: boolean;
  traceId: string | null;
  calls: CallRecord[];
  product: ProductPicks;
  /** Time the bot took to answer, as the simulator saw it (network included). */
  wallMs: number;
  at: string;
}

export interface ConversationRow {
  runId: string;
  seller: string;
  scenarioId: string;
  attempt: number;
  sessionId: string;
  language: string;
  suite: string;
  focus: string;
  turns: number;
  summary: boolean;
  finalProduct: string | null;
  stop: "summary" | "buyer_end" | "max_turns" | "errors";
  error?: string;
  at: string;
}

export interface ConversationOptions {
  runId: string;
  slug: string;
  key: string;
  scenario: Scenario;
  attempt: number;
  api: BotApi;
  buyer: Buyer;
  greeting: string;
  maxTurns: number;
  /** Called after every bot reply, so a cut-off run keeps what it did. */
  onTurn?: (row: TurnRow) => void;
}

export async function runConversation(o: ConversationOptions): Promise<ConversationRow> {
  const s = o.scenario;
  const sessionId = sessionIdFor(o.runId, o.slug, s.scenario_id, o.attempt);
  const history: Array<{ from: "bot" | "buyer"; text: string }> = [{ from: "bot", text: o.greeting }];
  const base = { runId: o.runId, seller: o.slug, scenarioId: s.scenario_id, attempt: o.attempt, language: s.language, suite: s.suite ?? "", focus: s.focus_product?.trim() ?? "" };
  let turns = 0;
  let errors = 0;
  let lastError: string | undefined;
  let finalProduct: string | null = null;
  let summary = false;
  let stop: ConversationRow["stop"] = "max_turns";
  let last: BotReply | null = null;
  while (turns < o.maxTurns) {
    const b = await o.buyer.next(history, last);
    if (!b.text || b.text.includes(END)) {
      stop = "buyer_end";
      break;
    }
    history.push({ from: "buyer", text: b.text });
    const started = Date.now();
    let r: BotReply;
    try {
      r = await o.api.chat(o.slug, o.key, { sessionId, message: b.text.slice(0, 2000), meta: { runId: o.runId, scenarioId: s.scenario_id, label: s.suite ?? "", language: s.language ?? "", expectedProduct: base.focus } });
    } catch (err) {
      lastError = (err as Error).message;
      history.pop();
      if (++errors >= 3) {
        stop = "errors";
        break;
      }
      continue;
    }
    errors = 0;
    turns++;
    last = r;
    const wallMs = Date.now() - started;
    if (r.debug?.product?.used) finalProduct = r.debug.product.used;
    o.onTurn?.({
      ...base,
      turn: turns,
      buyer: b.text,
      buyerCall: { ms: b.ms, inputTokens: b.inputTokens, outputTokens: b.outputTokens, costUsd: b.costUsd },
      reply: r.reply,
      chips: r.chips ?? [],
      askFor: r.askFor ?? null,
      leadStage: r.leadStage,
      summary: !!r.summary,
      traceId: r.debug?.traceId ?? r.traceId ?? null,
      calls: r.debug?.calls ?? [],
      product: r.debug?.product ?? {},
      wallMs,
      at: new Date().toISOString(),
    });
    history.push({ from: "bot", text: botText(r) });
    if (r.summary) {
      summary = true;
      stop = "summary";
      break;
    }
  }
  return { ...base, sessionId, turns, summary, finalProduct, stop, ...(stop === "errors" && lastError ? { error: lastError } : {}), at: new Date().toISOString() };
}

// ---- run folders ----

export const readJsonl = <T>(file: string): T[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as T)
    : [];
export const appendJsonl = (file: string, row: unknown) => fs.appendFileSync(file, `${JSON.stringify(row)}\n`);

/** Scenarios already finished in a run folder, and the next attempt number for each scenario (a cut-off chat is retried as a new one). */
export function resumeState(dir: string): { done: Set<string>; nextAttempt: (seller: string, scenarioId: string) => number } {
  const done = new Set(readJsonl<ConversationRow>(path.join(dir, "conversations.jsonl")).map((c) => `${c.seller}|${c.scenarioId}`));
  const attempts = new Map<string, number>();
  for (const t of readJsonl<TurnRow>(path.join(dir, "turns.jsonl"))) {
    const k = `${t.seller}|${t.scenarioId}`;
    attempts.set(k, Math.max(attempts.get(k) ?? 0, t.attempt));
  }
  return { done, nextAttempt: (seller, scenarioId) => (attempts.get(`${seller}|${scenarioId}`) ?? 0) + 1 };
}
