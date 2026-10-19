import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { generateBotKey, hashBotKey } from "../src/botKeys.js";
import { ChatDb } from "../src/db.js";
import { SellerRegistry } from "../src/sellers.js";
import { SessionStore } from "../src/session.js";
import { noTracing, type Tracing } from "../src/tracing.js";

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
            finalMessage: async () => ({ ...next, usage: { input_tokens: 1, output_tokens: 1 } }),
          };
        },
      },
    },
  } as unknown as Anthropic;
}

const PASSWORD = "correct-horse-battery";
const ALPHA = "alpha-presses";
const BETA = "beta-pumps";
const db = new ChatDb(":memory:");
const script: Scripted[] = [
  { content: [{ type: "text", text: "Please share your 10-digit mobile number." }], stop_reason: "end_turn" },
  { content: [{ type: "tool_use", id: "a", name: "send_otp", input: { mobile: "9876543210" } }], stop_reason: "tool_use" },
  { content: [{ type: "text", text: "OTP sent. Please enter it." }], stop_reason: "end_turn" },
  { content: [{ type: "tool_use", id: "b", name: "verify_otp", input: { otp: "12345" } }], stop_reason: "tool_use" },
  { content: [{ type: "text", text: "Verified. Your name?" }], stop_reason: "end_turn" },
  { content: [{ type: "tool_use", id: "c", name: "save_lead", input: { name: "Ramesh", product: "Press Brake", requirements: "100 ton", quantity: "1 piece", city: "Rajkot" } }], stop_reason: "tool_use" },
  { content: [{ type: "text", text: "Thanks, our team will contact you." }], stop_reason: "end_turn" },
];
let base = "";
let close: () => void;
const traces: any[] = [];
const tracing: Tracing = { ...noTracing, trace: (name, ctx, fn) => (traces.push(ctx), noTracing.trace(name, ctx, fn)) };
const keys = { alpha: generateBotKey(), beta: generateBotKey(), revoked: generateBotKey() };

beforeAll(async () => {
  const sellers = SellerRegistry.load(path.join(__dirname, "fixtures", "sellers"), fs.mkdtempSync(path.join(os.tmpdir(), "sim-data-")));
  db.createBotKey(ALPHA, keys.alpha.hash, keys.alpha.prefix, "Auditor");
  db.createBotKey(BETA, keys.beta.hash, keys.beta.prefix, "");
  db.revokeBotKey(ALPHA, db.createBotKey(ALPHA, keys.revoked.hash, keys.revoked.prefix, "old"));
  const app = createApp({ client: fakeClient(script), sellers, sessions: new SessionStore(db), db, allowedOrigins: [], adminPassword: PASSWORD, tracing });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close?.());

const say = async (slug: string, message: string, opts: { key?: string; sessionId?: string; meta?: unknown } = {}) => {
  const res = await fetch(`${base}/api/v1/bots/${slug}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(opts.key ? { "X-Bot-Key": opts.key } : {}) },
    body: JSON.stringify({ sessionId: opts.sessionId ?? "sim-run-0001", message, meta: opts.meta }),
  });
  return { status: res.status, body: (await res.json()) as any };
};
const auth = { Authorization: `Basic ${Buffer.from(`a:${PASSWORD}`).toString("base64")}` };

describe("simulator API", () => {
  it("needs a valid, active key for that bot", async () => {
    expect((await say(ALPHA, "hi")).status).toBe(401);
    expect((await say(ALPHA, "hi", { key: "sa_live_00000000000000000000000000000000" })).status).toBe(401);
    expect((await say(ALPHA, "hi", { key: keys.revoked.key })).status).toBe(401);
    const wrong = await say(ALPHA, "hi", { key: keys.beta.key });
    expect(wrong).toMatchObject({ status: 403, body: { error: "This X-Bot-Key does not match the bot slug" } });
    expect((await say("nobody", "hi", { key: keys.alpha.key })).status).toBe(404);
    expect((await say(ALPHA, "", { key: keys.alpha.key })).status).toBe(400);
  });

  it("describes the bot: name, the fixed welcome and the demo OTP", async () => {
    const res = await fetch(`${base}/api/v1/bots/${ALPHA}`, { headers: { "X-Bot-Key": keys.alpha.key } });
    expect(await res.json()).toEqual({
      slug: ALPHA,
      name: "Alpha Presses",
      greeting: "Welcome to Alpha Presses. I can tell you about our products, share photos and brochures, and pass your enquiry to our team.",
      demoOtp: "12345",
    });
    // Callable from a browser on any site, since the key is the auth.
    const pre = await fetch(`${base}/api/v1/bots/${ALPHA}/chat`, { method: "OPTIONS", headers: { Origin: "https://auditor.example", "Access-Control-Request-Headers": "x-bot-key" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("X-Bot-Key");
  });

  it("runs the journey as JSON turns and saves the lead as a test lead", async () => {
    const key = keys.alpha.key;
    const first = await say(ALPHA, "do you make press brakes?", { key, meta: { runId: "run-7", scenarioId: "lead_capture-3" } });
    expect(first).toMatchObject({ status: 200, body: { sessionId: "sim-run-0001", reply: "Please share your 10-digit mobile number.", leadStage: "none", test: true, chips: [], cards: [] } });
    // Traced like any chat, tagged so simulated chats can be filtered out in Langfuse.
    expect(traces.at(-1)).toMatchObject({ tags: [ALPHA, "eval", "simulator"], metadata: { source: "simulator", runId: "run-7", scenarioId: "lead_capture-3" } });
    expect(traces.at(-1).sessionId).toMatch(new RegExp(`^${ALPHA}:[0-9a-f-]{36}$`));
    expect((await say(ALPHA, "9876543210", { key })).body).toMatchObject({ askFor: "otp", leadStage: "otp_sent" });
    expect((await say(ALPHA, "12345", { key })).body).toMatchObject({ askFor: "name", leadStage: "verified" });
    expect((await say(ALPHA, "Ramesh", { key })).body).toMatchObject({ reply: "Thanks, our team will contact you.", leadStage: "captured" });

    // Saved, marked as a test, apart from browser chats, and left out of real lead counts.
    expect(db.listLeads(10, ALPHA)).toHaveLength(0);
    expect(db.listLeads(10, ALPHA, { includeTest: true })).toEqual([expect.objectContaining({ name: "Ramesh", test: true, sessionId: `${ALPHA}:sim-sim-run-0001` })]);
    expect(db.leadCounts()[ALPHA]).toBeUndefined();
    expect(db.transcript(`${ALPHA}:sim-sim-run-0001`)).toHaveLength(8);

    const leads = await (await fetch(`${base}/admin/leads`, { headers: auth })).text();
    expect(leads).not.toContain("Ramesh");
    expect(leads).toContain("Show test chats (1)");
    const withTest = await (await fetch(`${base}/admin/leads?test=1`, { headers: auth })).text();
    expect(withTest).toMatch(/Ramesh <span class="badge info">Test<\/span>/);
    const csv = await (await fetch(`${base}/admin/leads.csv?test=1`, { headers: auth })).text();
    expect(csv).toMatch(/Ramesh.*,test\r\n/);
    expect(await (await fetch(`${base}/admin/leads.csv`, { headers: auth })).text()).not.toContain("Ramesh");
  });

  it("lets several conversations run in parallel on one key", async () => {
    const replies = await Promise.all([1, 2, 3, 4].map((n) => say(ALPHA, "hello", { key: keys.alpha.key, sessionId: `parallel-${n}-run` })));
    expect(replies.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(new Set(replies.map((r) => r.body.sessionId)).size).toBe(4);
  });

  it("admin: generates a key shown once, stores only its hash, and revokes it", async () => {
    const page = await fetch(`${base}/admin/sellers/${BETA}/keys`, { method: "POST", headers: { ...auth, Origin: base, "Content-Type": "application/x-www-form-urlencoded" }, body: "label=Auditor" });
    const html = await page.text();
    const key = html.match(/sa_live_[0-9a-f]{32}/)?.[0];
    expect(key).toBeTruthy();
    expect(page.headers.get("cache-control")).toBe("no-store");
    const stored = db.listBotKeys(BETA).find((k) => k.label === "Auditor")!;
    expect(stored.prefix).toBe(key!.slice(0, 14));
    expect(db.findBotKey(hashBotKey(key!))?.id).toBe(stored.id);
    expect(JSON.stringify(db.listBotKeys(BETA))).not.toContain(key!);

    const admin = await (await fetch(`${base}/admin`, { headers: auth })).text();
    expect(admin).toContain("Simulator API");
    expect(admin).toContain(`${stored.prefix}…`);
    expect(admin).not.toContain(key!);
    // The key option is reachable from the seller row itself, and the block has an anchor the button jumps to.
    const betaRow = admin.split('class="srow"').find((part) => part.includes(`id="seller-${BETA}"`))!;
    expect(betaRow).toContain(`data-keys="${BETA}"`);
    expect(betaRow).toContain(`id="keys-${BETA}"`);
    expect(betaRow).toMatch(/\d+ simulator keys?/);
    expect(betaRow.indexOf('id="keys-')).toBeLessThan(betaRow.indexOf("Extra files"));
    expect(admin).toContain("Build <code>");

    expect((await say(BETA, "hi", { key })).status).toBe(200);
    const revoke = await fetch(`${base}/admin/sellers/${BETA}/keys/${stored.id}/revoke`, { method: "POST", headers: { ...auth, Origin: base }, redirect: "manual" });
    expect(revoke.status).toBe(303);
    expect((await say(BETA, "hi", { key })).status).toBe(401);
  });
});
