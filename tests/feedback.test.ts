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

async function serve(tracing?: Tracing) {
  const sellers = SellerRegistry.load(sellersDir, fs.mkdtempSync(path.join(os.tmpdir(), "fb-data-")));
  const app = createApp({ client, sellers, sessions: new SessionStore(), db: new ChatDb(":memory:"), allowedOrigins: [], tracing });
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
});
