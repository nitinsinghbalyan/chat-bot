import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { ChatDb } from "../src/db.js";
import { SellerRegistry } from "../src/sellers.js";
import { SessionStore } from "../src/session.js";
import type { Score, Tracing } from "../src/tracing.js";

/** Always answers "OK." */
const client = {
  beta: {
    messages: {
      stream() {
        const content = [{ type: "text", text: "OK." }];
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
            yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK." } };
            yield { type: "content_block_stop", index: 0 };
          },
          finalMessage: async () => ({ content, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }),
        };
      },
    },
  },
} as unknown as Anthropic;

/** A Tracing that hands out sequential trace ids and records traces, observations and scores. */
function fakeTracing() {
  const traces: Array<{ name: string; ctx: any; root: any }> = [];
  const observations: string[] = [];
  const scores: Score[] = [];
  let n = 0;
  const tracing: Tracing = {
    enabled: true,
    status: { state: "ok", host: "langfuse.example.com", message: "Langfuse accepted the keys.", version: "3.120.0", exports: 2, spansExported: 14, exportErrors: 0, lastExportAt: "2026-10-15T05:00:00Z", lastExportOk: true },
    testConnection: async () => {
      const r = {
        at: "2026-10-15T05:01:00Z",
        ok: false,
        verdict: "Langfuse accepted the upload but hasn't stored it.",
        steps: [{ label: "Stored in Langfuse", ok: false, detail: "Not returned by the API after 20s (last answer HTTP 404)" }],
        traceUrl: "https://langfuse.example.com/project/p1/traces/abc",
      };
      tracing.status.lastTest = r;
      return r;
    },
    start: (name) => (observations.push(name), { update() {}, end() {} }),
    async trace(name, ctx, fn) {
      const traceId = (++n).toString(16).padStart(32, "0");
      const root: any = { traceId, attrs: {} };
      traces.push({ name, ctx, root });
      return fn({ traceId, update: (a) => Object.assign(root.attrs, a), end() {} });
    },
    score: (s) => void scores.push(s),
    flush: async () => {},
  };
  return { tracing, traces, observations, scores };
}

const sellersDir = path.join(__dirname, "fixtures", "sellers");
const ALPHA = "alpha-presses";

const ADMIN_PW = "admin-pass-1234";
async function serve(tracing?: Tracing) {
  const sellers = SellerRegistry.load(sellersDir, fs.mkdtempSync(path.join(os.tmpdir(), "fb-data-")));
  const app = createApp({ client, sellers, sessions: new SessionStore(), db: new ChatDb(":memory:"), allowedOrigins: [], tracing, adminPassword: ADMIN_PW });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

const chat = (base: string, sessionId: string, message: string) =>
  fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ seller: ALPHA, sessionId, message, pageUrl: `${base}/s/${ALPHA}/` }),
  }).then((r) => r.text());
const feedback = (base: string, body: unknown) =>
  fetch(`${base}/api/feedback`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify(body) });

describe("tracing off (no Langfuse keys)", () => {
  let s: Awaited<ReturnType<typeof serve>>;
  beforeAll(async () => (s = await serve()));
  afterAll(() => s.close());

  it("sends no trace event and turns feedback off", async () => {
    expect(await chat(s.base, "off-session-1", "hello")).not.toContain("event: trace");
    expect(await (await fetch(`${s.base}/api/sellers/${ALPHA}`)).json()).toMatchObject({ feedback: false });
    expect((await feedback(s.base, { seller: ALPHA, sessionId: "off-session-1", traceId: "0".repeat(32), value: 1 })).status).toBe(404);
  });
});

describe("tracing on", () => {
  const t = fakeTracing();
  let s: Awaited<ReturnType<typeof serve>>;
  beforeAll(async () => (s = await serve(t.tracing)));
  afterAll(() => s.close());

  it("opens one trace per buyer message, grouped by chat, and tells the widget its id", async () => {
    const body = await chat(s.base, "on-session-1", "need press brake, call 9876543210");
    const traceId = body.match(/event: trace\ndata: \{"traceId":"([0-9a-f]{32})"\}/)?.[1];
    expect(traceId).toBe(t.traces[0].root.traceId);
    const tr = t.traces[0];
    expect(tr.name).toBe("chat-turn");
    expect(tr.ctx).toMatchObject({ sessionId: `${ALPHA}:on-session-1`, tags: [ALPHA, "on-platform"], metadata: { seller: ALPHA, leadStageBefore: "none", turn: 1 } });
    expect(tr.ctx.metadata.prompt).toMatchObject({ commonPrompt: "v1", knowledgeBase: "KB folder" });
    expect(tr.root.attrs.output).toMatchObject({ reply: "OK." });
    expect(t.observations).toContain("catalogue-search");
    expect(await (await fetch(`${s.base}/api/sellers/${ALPHA}`)).json()).toMatchObject({ feedback: true });
  });

  it("records buyer feedback only for replies in the buyer's own chat", async () => {
    const own = t.traces[0].root.traceId;
    expect((await feedback(s.base, { seller: ALPHA, sessionId: "on-session-1", traceId: own, value: -1 })).status).toBe(204);
    expect(t.scores.at(-1)).toMatchObject({ traceId: own, name: "buyer_feedback", value: -1, id: `${own}-buyer-feedback` });
    // Another chat can't rate it; bad values are refused.
    expect((await feedback(s.base, { seller: ALPHA, sessionId: "other-session-9", traceId: own, value: 1 })).status).toBe(403);
    expect((await feedback(s.base, { seller: ALPHA, sessionId: "on-session-1", traceId: own, value: 5 })).status).toBe(400);
    expect((await feedback(s.base, { seller: ALPHA, sessionId: "on-session-1", traceId: "nothex", value: 1 })).status).toBe(400);
  });

  it("keeps a running chat cost as one Langfuse session score", async () => {
    const before = t.scores.length;
    await chat(s.base, "cost-session-1", "hello");
    await chat(s.base, "cost-session-1", "need a press brake");
    const costs = t.scores.slice(before).filter((x) => x.name === "chat_cost_usd");
    expect(costs).toHaveLength(2);
    // Scored on the session (not a trace), with the same id each time so the value is replaced.
    expect(costs[0]).toMatchObject({ sessionId: `${ALPHA}:cost-session-1`, dataType: "NUMERIC" });
    expect(costs[0].traceId).toBeUndefined();
    expect(costs[1].id).toBe(costs[0].id);
    expect(costs[0].id).toMatch(/^chat-cost-[0-9a-f]{32}$/);
    // The fake model uses 1 input + 1 output token per call at the default model's price.
    expect(costs[0].value).toBeCloseTo(0.000012, 9);
    expect(costs[1].value).toBeCloseTo(0.000024, 9);
    expect(costs[1].comment).toBe("2 buyer messages, 4 tokens");
    const last = t.traces.at(-1)!.root.attrs.metadata;
    expect(last).toMatchObject({ chatTurns: 2, chatTokens: 4 });
    expect(last.turnCostUsd).toBeCloseTo(0.000012, 9);
    expect(last.chatCostUsd).toBeCloseTo(0.000024, 9);
    // Another chat starts from zero.
    await chat(s.base, "cost-session-2", "hello");
    expect(t.scores.filter((x) => x.name === "chat_cost_usd").at(-1)).toMatchObject({ sessionId: `${ALPHA}:cost-session-2`, comment: "1 buyer message, 2 tokens" });
  });

  it("shows uploads on /health and runs the Langfuse test from admin", async () => {
    const health = await (await fetch(`${s.base}/health`)).json();
    expect(health.tracing).toEqual({ state: "ok", host: "langfuse.example.com", version: "3.120.0", exports: 2, spansExported: 14, exportErrors: 0, lastExportAt: "2026-10-15T05:00:00Z", lastExportOk: true });
    const auth = { Authorization: `Basic ${Buffer.from(`a:${ADMIN_PW}`).toString("base64")}` };
    // Admin only, and only from admin's own pages.
    expect((await fetch(`${s.base}/admin/tracing/test`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${s.base}/admin/tracing/test`, { method: "POST", headers: { ...auth, Origin: "https://evil.example" } })).status).toBe(403);
    const r = await fetch(`${s.base}/admin/tracing/test`, { method: "POST", headers: { ...auth, Origin: s.base }, redirect: "manual" });
    expect(r.status).toBe(303);
    const page = await (await fetch(`${s.base}/admin`, { headers: auth })).text();
    expect(page).toContain("Langfuse tracing is on (langfuse.example.com, Langfuse 3.120.0)");
    expect(page).toContain("Test Langfuse");
    expect(page).toContain("hasn&#39;t stored it");
    expect(page).toContain("Not returned by the API after 20s (last answer HTTP 404)");
    expect(page).toContain('href="https://langfuse.example.com/project/p1/traces/abc"');
  });
});
