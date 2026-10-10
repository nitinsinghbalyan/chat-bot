import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, csvCell } from "../src/app.js";
import { Catalogue } from "../src/catalogue.js";
import { ChatDb } from "../src/db.js";
import { loadKnowledgeBase } from "../src/kb.js";
import { SessionStore } from "../src/session.js";

/** Fake Claude client: replays scripted turns (text or tool calls). */
function fakeClient(script: Array<{ content: any[]; stop_reason: string }>) {
  return {
    beta: {
      messages: {
        stream() {
          const next = script.shift()!;
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
const db = new ChatDb(":memory:");
let base = "";
let close: () => void;

beforeAll(async () => {
  const kb = loadKnowledgeBase();
  const app = createApp({
    client: fakeClient([
      { content: [{ type: "tool_use", id: "a", name: "send_otp", input: { mobile: "9876543210" } }], stop_reason: "tool_use" },
      { content: [{ type: "text", text: "OTP sent. Please enter it." }], stop_reason: "end_turn" },
      { content: [{ type: "tool_use", id: "b", name: "verify_otp", input: { otp: "12345" } }], stop_reason: "tool_use" },
      { content: [{ type: "text", text: "Verified. Your name?" }], stop_reason: "end_turn" },
      { content: [{ type: "tool_use", id: "c", name: "save_lead", input: { name: "=Ramesh", product: "Press Brake", requirements: "100 ton", quantity: "1 piece", city: "Rajkot" } }], stop_reason: "tool_use" },
      { content: [{ type: "text", text: "Thanks, our team will contact you." }], stop_reason: "end_turn" },
    ]),
    kb,
    catalogue: new Catalogue(),
    systemPrompt: "SYSTEM",
    sessions: new SessionStore(db),
    db,
    allowedOrigins: ["https://www.jayshreemachinetools.in"],
    adminPassword: PASSWORD,
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close?.());

async function chat(message: string, origin = "https://www.jayshreemachinetools.in") {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ sessionId: "app-test-session", message, pageUrl: "https://www.jayshreemachinetools.in/" }),
  });
  return { status: res.status, body: await res.text() };
}

const auth = (pw: string) => ({ Authorization: `Basic ${Buffer.from(`seller:${pw}`).toString("base64")}` });

describe("HTTP app", () => {
  it("rejects other websites", async () => {
    expect((await chat("hi", "https://evil.example")).status).toBe(403);
  });

  it("runs the lead flow over SSE and persists it", async () => {
    expect((await chat("9876543210")).body).toContain('"askFor":"otp"');
    expect((await chat("12345")).body).toContain('"askFor":"name"');
    expect((await chat("Ramesh")).body).toContain("our team will contact you");
    expect(db.listLeads()).toHaveLength(1);
    expect(db.loadSession("app-test-session")?.lead).toMatchObject({ stage: "captured" });
    expect(db.transcript("app-test-session").map((t) => t.role)).toEqual(["buyer", "bot", "buyer", "bot", "buyer", "bot"]);
  });

  it("protects admin pages with the password", async () => {
    expect((await fetch(`${base}/admin/leads`)).status).toBe(401);
    expect((await fetch(`${base}/admin/leads`, { headers: auth("wrong-password!!") })).status).toBe(401);
    const page = await fetch(`${base}/admin/leads`, { headers: auth(PASSWORD) });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("9876543210");
  });

  it("exports leads as CSV with formulas defused", async () => {
    const res = await fetch(`${base}/admin/leads.csv`, { headers: auth(PASSWORD) });
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    const csv = await res.text();
    expect(csv).toContain('"\'=Ramesh","9876543210","Press Brake"');
  });

  it("shows a chat transcript", async () => {
    const res = await fetch(`${base}/admin/transcript/app-test-session`, { headers: auth(PASSWORD) });
    expect(await res.text()).toContain("Thanks, our team will contact you.");
  });
});

describe("csvCell", () => {
  it("quotes and escapes", () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("+91 98765")).toBe("\"'+91 98765\"");
  });
});
