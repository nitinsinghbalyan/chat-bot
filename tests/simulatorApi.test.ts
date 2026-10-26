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
import { describeLeadStatus } from "../src/tools.js";
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
const start = async (slug: string, body: Record<string, unknown>, key?: string) => {
  const res = await fetch(`${base}/api/v1/bots/${slug}/conversations`, { method: "POST", headers: { "Content-Type": "application/json", ...(key ? { "X-Bot-Key": key } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};
const text = (t: string): Scripted => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const tool = (id: string, name: string, input: unknown): Scripted => ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" });

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
      sellerId: null,
      greeting: "Welcome to Alpha Presses. I can tell you about our products, share photos and brochures, and pass your enquiry to our team.",
      demoOtp: "12345",
      keyKind: "test",
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
    // No kind chosen: a test key, as every key was before kinds existed.
    expect(stored.kind).toBe("test");
    expect(html).toContain("New test API key");
    expect(db.findBotKey(hashBotKey(key!))?.id).toBe(stored.id);
    expect(JSON.stringify(db.listBotKeys(BETA))).not.toContain(key!);

    const admin = await (await fetch(`${base}/admin`, { headers: auth })).text();
    expect(admin).not.toContain(key!);
    // The key option is reachable from the seller row itself and jumps to the keys card on the seller page.
    const betaRow = admin.split('class="srow"').find((part) => part.includes(`id="seller-${BETA}"`))!;
    expect(betaRow).toContain(`href="/admin/sellers/${BETA}#keys"`);
    expect(betaRow).toContain(`data-keys="${BETA}"`);
    expect(betaRow).toMatch(/\d+ API keys?/);
    expect(admin).toContain("Build <code>");
    const sellerPage = await (await fetch(`${base}/admin/sellers/${BETA}`, { headers: auth })).text();
    expect(sellerPage).toContain("Bot API");
    expect(sellerPage).toContain('id="keys"');
    expect(sellerPage).toContain('name="kind" value="live"');
    expect(sellerPage).toContain(`${stored.prefix}…`);
    expect(sellerPage).toContain("2 active keys");
    expect(sellerPage).not.toContain(key!);

    expect((await say(BETA, "hi", { key })).status).toBe(200);
    const revoke = await fetch(`${base}/admin/sellers/${BETA}/keys/${stored.id}/revoke`, { method: "POST", headers: { ...auth, Origin: base }, redirect: "manual" });
    expect(revoke.status).toBe(303);
    expect(revoke.headers.get("location")).toBe(`/admin/sellers/${BETA}?key=revoked#keys`);
    expect((await say(BETA, "hi", { key })).status).toBe(401);
  });

  it("a live key opens a conversation with a verified buyer, saves a real lead and traces it as api", async () => {
    const page = await fetch(`${base}/admin/sellers/${ALPHA}/keys`, { method: "POST", headers: { ...auth, Origin: base, "Content-Type": "application/x-www-form-urlencoded" }, body: "label=IndiaMART&kind=live" });
    const html = await page.text();
    const live = html.match(/sa_live_[0-9a-f]{32}/)![0];
    expect(html).toContain("New live API key");
    expect(db.listBotKeys(ALPHA).find((k) => k.label === "IndiaMART")?.kind).toBe("live");
    expect((await fetch(`${base}/api/v1/bots/${ALPHA}`, { headers: { "X-Bot-Key": live } }).then((r) => r.json())) as any).toMatchObject({ keyKind: "live" });

    const opened = await start(ALPHA, { sessionId: "im-buyer-0001", name: "Rahul", mobile: "+91 98765 43210", mobileVerified: true, buyerId: "65857057" }, live);
    expect(opened).toMatchObject({
      status: 200,
      body: { sessionId: "im-buyer-0001", leadStage: "captured", askFor: null, buyer: { name: "Rahul", mobile: "xxxxxx3210", buyerId: "65857057" }, test: false },
    });
    expect(opened.body.greeting).toContain("Welcome to Alpha Presses");
    // Opening it again is refused once the chat has started, not before.
    expect((await start(ALPHA, { sessionId: "im-buyer-0001", name: "Rahul" }, live)).status).toBe(200);

    // The bot never asks for contact details: it goes straight to the product and saves with the known name.
    script.push(tool("d", "save_lead", { name: "", product: "Press Brake", requirements: "", quantity: "", city: "", specs: [], complete: false }), text("Which capacity do you need?"));
    const first = await say(ALPHA, "I need a press brake", { key: live, sessionId: "im-buyer-0001" });
    expect(first).toMatchObject({ status: 200, body: { reply: "Which capacity do you need?", leadStage: "captured", askFor: null, test: false } });
    expect(traces.at(-1)).toMatchObject({ tags: [ALPHA, "api"], metadata: { source: "api", buyerId: "65857057" } });
    expect(traces.at(-1).metadata).not.toHaveProperty("runId");
    expect((await start(ALPHA, { sessionId: "im-buyer-0001" }, live)).status).toBe(409);

    // A real lead (not a test one), with the platform's buyer id, apart from browser and simulator chats.
    const lead = db.listLeads(10, ALPHA).find((l) => l.name === "Rahul")!;
    expect(lead).toMatchObject({ mobile: "9876543210", buyerId: "65857057", product: "Press Brake", sessionId: `${ALPHA}:api-im-buyer-0001` });
    expect(lead.test).toBeUndefined();
    const leads = await (await fetch(`${base}/admin/leads`, { headers: auth })).text();
    expect(leads).toContain("Rahul");
    expect(leads).toContain("Buyer id 65857057");
    expect(await (await fetch(`${base}/admin/leads.csv`, { headers: auth })).text()).toMatch(/"Rahul".*,"65857057",/);
  });

  it("an unverified mobile goes straight to the OTP step", async () => {
    const key = keys.alpha.key;
    expect(await start(ALPHA, { sessionId: "im-buyer-0002", mobile: "9876543211" }, key)).toMatchObject({ status: 200, body: { leadStage: "otp_sent", askFor: "otp", buyer: { mobile: "xxxxxx3211" }, test: true } });
    script.push(tool("e", "verify_otp", { otp: "12345" }), text("Verified. Your name?"));
    expect((await say(ALPHA, "12345", { key, sessionId: "im-buyer-0002" })).body).toMatchObject({ leadStage: "verified", askFor: "name" });
  });

  it("a name alone is kept for the lead while the mobile is verified in the chat", async () => {
    const key = keys.alpha.key;
    expect(await start(ALPHA, { sessionId: "im-buyer-0003", name: "Sita" }, key)).toMatchObject({ status: 200, body: { leadStage: "none", askFor: "mobile", buyer: { name: "Sita" } } });
    script.push(tool("f", "send_otp", { mobile: "9876543212" }), text("OTP sent."));
    expect((await say(ALPHA, "9876543212", { key, sessionId: "im-buyer-0003" })).body).toMatchObject({ leadStage: "otp_sent" });
    script.push(tool("g", "verify_otp", { otp: "12345" }), text("Verified."));
    expect((await say(ALPHA, "12345", { key, sessionId: "im-buyer-0003" })).body).toMatchObject({ leadStage: "verified" });
    // The model may leave the name empty when the status says it is known.
    script.push(tool("h", "save_lead", { name: "", product: "", requirements: "", quantity: "", city: "", specs: [], complete: false }), text("Saved. Which product do you need?"));
    expect((await say(ALPHA, "ok", { key, sessionId: "im-buyer-0003" })).body).toMatchObject({ leadStage: "captured" });
    expect(db.listLeads(10, ALPHA, { includeTest: true }).find((l) => l.sessionId === `${ALPHA}:sim-im-buyer-0003`)).toMatchObject({ name: "Sita", mobile: "9876543212", test: true });
  });

  it("tells the bot what is already known", () => {
    expect(describeLeadStatus({ stage: "none", name: "Sita", otpAttempts: 0, otpSends: 0 })).toContain("name (Sita) is already known");
    expect(describeLeadStatus({ stage: "verified", name: "Sita", mobile: "9876543212", otpAttempts: 0, otpSends: 0 })).toContain("call save_lead straight away with that name");
    expect(describeLeadStatus({ stage: "captured", name: "Rahul", mobile: "9876543210", saved: false, otpAttempts: 0, otpSends: 0 })).toContain("already identified by the platform");
    expect(describeLeadStatus({ stage: "captured", name: "Rahul", mobile: "9876543210", saved: true, otpAttempts: 0, otpSends: 0 })).toContain("Enquiry saved for Rahul");
  });

  it("rejects bad input and a seller id that is not this bot's", async () => {
    const key = keys.alpha.key;
    expect((await start(ALPHA, { sessionId: "im-buyer-0004", mobile: "12345" }, key)).status).toBe(400);
    expect((await start(ALPHA, { sessionId: "im-buyer-0004", name: "R" }, key)).status).toBe(400);
    expect((await start(ALPHA, { sessionId: "bad id" }, key)).status).toBe(400);
    expect((await start(ALPHA, {})).status).toBe(401);
    expect((await start("nobody", {}, key)).status).toBe(404);
    expect((await start(ALPHA, {}, keys.beta.key)).status).toBe(403);
    // Without an uploaded export the seller id is unknown, so any sellerId passes.
    expect((await start(ALPHA, { sessionId: "im-buyer-0004", sellerId: "999" }, key)).status).toBe(200);
    const kbJson = fs.readFileSync(path.join(__dirname, "fixtures", "kb", "alpha-kb.json"), "utf8");
    expect((await fetch(`${base}/admin/sellers/${ALPHA}/kb`, { method: "POST", headers: { ...auth, Origin: base, "Content-Type": "application/json" }, body: kbJson })).status).toBe(200);
    expect(((await fetch(`${base}/api/v1/bots/${ALPHA}`, { headers: { "X-Bot-Key": key } }).then((r) => r.json())) as any).sellerId).toBe("1");
    const wrong = await start(ALPHA, { sessionId: "im-buyer-0005", sellerId: "999" }, key);
    expect(wrong).toMatchObject({ status: 409, body: { error: "sellerId 999 does not match this bot (seller 1)" } });
    expect((await start(ALPHA, { sessionId: "im-buyer-0005", sellerId: 1 }, key)).status).toBe(200);
  });
});
