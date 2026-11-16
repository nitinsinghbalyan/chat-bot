import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { generateBotKey } from "../src/botKeys.js";
import { importedChatId } from "../src/chatImport.js";
import { ChatDb } from "../src/db.js";
import { SellerRegistry } from "../src/sellers.js";
import { SessionStore } from "../src/session.js";

type Scripted = { content: any[]; stop_reason: string };

/** Fake Claude client: replays scripted turns, then answers "OK.". */
function fakeClient(script: Scripted[]) {
  return {
    beta: {
      messages: {
        stream() {
          const next = script.shift() ?? { content: [{ type: "text", text: "OK." }], stop_reason: "end_turn" };
          const events = next.content.flatMap((block, index) =>
            block.type === "text"
              ? [
                  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
                  { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
                  { type: "content_block_stop", index },
                ]
              : [
                  { type: "content_block_start", index, content_block: block },
                  { type: "content_block_stop", index },
                ],
          );
          return {
            async *[Symbol.asyncIterator]() {
              yield* events;
            },
            finalMessage: async () => ({ ...next, model: "claude-haiku-5-5", usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 4000 } }),
          };
        },
      },
    },
  } as unknown as Anthropic;
}

const PASSWORD = "correct-horse-battery";
const ALPHA = "alpha-presses";
const db = new ChatDb(":memory:");
const script: Scripted[] = [
  { content: [{ type: "text", text: "Please share your 10-digit mobile number." }], stop_reason: "end_turn" },
  { content: [{ type: "text", text: "Which tonnage?" }, { type: "tool_use", id: "a", name: "show_options", input: { options: ["60 T", "100 T"] } }], stop_reason: "tool_use" },
];
const keys = { test: generateBotKey(), live: generateBotKey() };
let base = "";
let close: () => void;
const auth = { Authorization: `Basic ${Buffer.from(`a:${PASSWORD}`).toString("base64")}` };

beforeAll(async () => {
  const sellers = SellerRegistry.load(path.join(__dirname, "fixtures", "sellers"), fs.mkdtempSync(path.join(os.tmpdir(), "chats-data-")));
  db.createBotKey(ALPHA, keys.test.hash, keys.test.prefix, "Auditor", "test");
  db.createBotKey(ALPHA, keys.live.hash, keys.live.prefix, "Partner", "live");
  const app = createApp({ client: fakeClient(script), sellers, sessions: new SessionStore(db), db, allowedOrigins: [], adminPassword: PASSWORD });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close?.());

const say = async (message: string, key: string, sessionId: string, meta?: unknown) => {
  const res = await fetch(`${base}/api/v1/bots/${ALPHA}/chat`, { method: "POST", headers: { "Content-Type": "application/json", "X-Bot-Key": key }, body: JSON.stringify({ sessionId, message, meta }) });
  return (await res.json()) as any;
};
const page = async (p: string) => {
  const res = await fetch(`${base}${p}`, { headers: auth });
  return { status: res.status, html: await res.text() };
};

describe("chats log", () => {
  it("records every chat with its source, turns, calls and run details", async () => {
    // A website chat (the platform's own seller site).
    const web = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ seller: ALPHA, sessionId: "web-chat-0001", message: "hello", pageUrl: `${base}/s/${ALPHA}/` }) });
    await web.text();
    // A test chat from the simulator (buyer already verified, so buttons are allowed), and a live Bot API chat.
    await fetch(`${base}/api/v1/bots/${ALPHA}/conversations`, { method: "POST", headers: { "Content-Type": "application/json", "X-Bot-Key": keys.test.key }, body: JSON.stringify({ sessionId: "sim-run-0001", name: "Ramesh", mobile: "9876543210", mobileVerified: true }) });
    await say("need a press brake", keys.test.key, "sim-run-0001", { runId: "run-9", scenarioId: "alpha_tc_01", label: "spec_deep_dive", language: "english", expectedProduct: "Press Brake" });
    await say("hello", keys.live.key, "live-chat-001");

    const all = db.listChats({}, {}).rows;
    expect(all.map((c) => c.source).sort()).toEqual(["api", "test", "website"]);
    const test = all.find((c) => c.source === "test")!;
    expect(test).toMatchObject({ seller: ALPHA, runId: "run-9", scenarioId: "alpha_tc_01", label: "spec_deep_dive", language: "english", expectedProduct: "Press Brake", turns: 1 });
    expect(test.costUsd).toBeGreaterThan(0);
    const [turn] = db.chatTurns(test.chatId);
    expect(turn).toMatchObject({ turn: 1, buyer: "need a press brake", reply: "Which tonnage?", chips: ["60 T", "100 T"] });
    expect(turn!.calls).toEqual([expect.objectContaining({ kind: "reply", model: "claude-haiku-5-5", inputTokens: 100, cacheRead: 4000 })]);
    expect(db.chatCounts()).toEqual({ website: 1, embedded: 0, api: 1, test: 1 });
    expect(db.chatRuns()).toEqual([expect.objectContaining({ runId: "run-9", chats: 1, turns: 1 })]);
    // A mobile number the buyer types is stored masked.
    await say("my number is 98765 43210", keys.test.key, "sim-run-0002");
    const masked = db.listChats({}, {}).rows.find((c) => c.sessionId.endsWith("sim-run-0002"))!;
    expect(db.chatTurns(masked.chatId)[0]!.buyer).toBe("my number is xxxxxx3210");
  });

  it("lists chats with tag, seller, run and search filters, behind the admin login", async () => {
    expect((await fetch(`${base}/admin/chats`)).status).toBe(401);
    const list = await page("/admin/chats");
    expect(list.status).toBe(200);
    expect(list.html).toContain('href="/admin/chats"');
    expect(list.html).toMatch(/Test runs <span class="n">2<\/span>/);
    expect(list.html).toContain("Website");
    const tests = await page("/admin/chats?tag=test");
    expect(tests.html).toContain("alpha_tc_01");
    expect(tests.html).not.toContain("web-chat");
    expect(tests.html).toContain("Import a run from files");
    const run = await page("/admin/chats?run=run-9");
    expect(run.html).toContain("Run <code>run-9</code>");
    expect(run.html).toContain("Tokens, latency and cost per call");
    expect(run.html).toContain("Product pick: word rules vs Jev vs Haiku");
    expect((await page("/admin/chats?q=alpha_tc")).html).toContain("alpha_tc_01");
    expect((await page("/admin/chats?q=nothing-matches")).html).toContain("No chats yet");
    const csv = await fetch(`${base}/admin/chats/run.csv?run=run-9&kind=calls`, { headers: auth });
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect((await csv.text()).split("\n")[0]).toContain("input_tokens");
  });

  it("shows one chat: transcript, buttons, calls and picks", async () => {
    const chat = db.listChats({ runId: "run-9" }).rows[0]!;
    const one = await page(`/admin/chats/${chat.chatId}`);
    expect(one.status).toBe(200);
    expect(one.html).toContain("need a press brake");
    expect(one.html).toContain('<div class="reply-chips"><span>60 T</span><span>100 T</span></div>');
    expect(one.html).toContain("1 model call");
    expect(one.html).toContain("<code>claude-haiku-5-5</code>");
    expect(one.html).toContain("expected product <b>Press Brake</b>");
    expect((await page("/admin/chats/no-such-chat")).status).toBe(404);
  });

  it("imports a simulator run once, from the admin page or with the seller's Test key", async () => {
    const turn = (n: number, extra: object = {}) => ({ runId: "old-run", seller: ALPHA, scenarioId: "alpha_tc_02", attempt: 1, turn: n, language: "hinglish", suite: "product_discovery", focus: "Press Brake", buyer: `msg ${n}`, reply: `reply ${n}`, chips: [], leadStage: "captured", summary: n === 2, traceId: null, calls: [{ kind: "reply", model: "claude-haiku-5-5", inputTokens: 10, outputTokens: 5, cacheRead: 100, costUsd: 0.001 }], product: { used: "Press Brakes" }, at: "2026-11-16T10:00:00.000Z", ...extra });
    const text = [turn(1), turn(2), { seller: ALPHA, scenarioId: "alpha_tc_02", attempt: 1, stop: "summary", turns: 2 }, turn(1, { scenarioId: "cut_off", attempt: 1 })].map((x) => JSON.stringify(x)).join("\n");

    // The admin import needs the login and a same-site request.
    expect((await fetch(`${base}/admin/chats/import`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: text })).status).toBe(401);
    const res = await fetch(`${base}/admin/chats/import`, { method: "POST", headers: { ...auth, Origin: base, "Content-Type": "text/plain" }, body: text });
    // Only finished chats (in conversations.jsonl) are imported.
    expect(await res.json()).toEqual({ chats: 1, turns: 2, skipped: 0, ignored: 1 });
    const imported = db.chat(importedChatId({ runId: "old-run", seller: ALPHA, scenarioId: "alpha_tc_02", attempt: 1 }))!;
    expect(imported).toMatchObject({ source: "test", runId: "old-run", turns: 2, summaryShown: true, product: "Press Brakes" });

    // With a Test key: same data again is skipped; a Live key may not import.
    const viaKey = await fetch(`${base}/api/v1/bots/${ALPHA}/runs/import`, { method: "POST", headers: { "X-Bot-Key": keys.test.key, "Content-Type": "text/plain" }, body: text });
    expect(await viaKey.json()).toEqual({ chats: 0, turns: 0, skipped: 1, ignored: 1 });
    expect((await fetch(`${base}/api/v1/bots/${ALPHA}/runs/import`, { method: "POST", headers: { "X-Bot-Key": keys.live.key, "Content-Type": "text/plain" }, body: text })).status).toBe(403);
    // A run's scenario that was already logged live (run-9 / alpha_tc_01) is not imported again.
    const live = [turn(1, { runId: "run-9", scenarioId: "alpha_tc_01" }), { seller: ALPHA, scenarioId: "alpha_tc_01", attempt: 1, stop: "summary", turns: 1 }].map((x) => JSON.stringify(x)).join("\n");
    const again = await fetch(`${base}/api/v1/bots/${ALPHA}/runs/import`, { method: "POST", headers: { "X-Bot-Key": keys.test.key, "Content-Type": "text/plain" }, body: live });
    expect(await again.json()).toEqual({ chats: 0, turns: 0, skipped: 1, ignored: 0 });
  });
});
