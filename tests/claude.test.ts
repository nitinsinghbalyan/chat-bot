import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { Catalogue } from "../src/catalogue.js";
import { FALLBACK_REPLY, runTurn, type ChatDeps } from "../src/claude.js";
import { REPLACEMENTS } from "../src/guardrails.js";
import path from "node:path";
import { loadKnowledgeBase } from "../src/kb.js";

const JAYSHREE = path.join(__dirname, "..", "kb", "sellers", "jayshree-machinetools");
import { SessionStore } from "../src/session.js";
import type { Lead } from "../src/tools.js";

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };
interface Scripted {
  content: Block[];
  stop_reason: string;
}

/** A stand-in for client.beta.messages.stream that replays scripted responses. */
function fakeClient(script: Array<Scripted | Error>) {
  const requests: any[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: any) {
          requests.push(structuredClone(params));
          const next = script.shift();
          if (!next) throw new Error("script exhausted");
          if (next instanceof Error) throw next;
          const events: any[] = [];
          next.content.forEach((block, index) => {
            events.push({ type: "content_block_start", index, content_block: block.type === "text" ? { type: "text", text: "" } : block });
            if (block.type === "text") for (const piece of block.text.match(/.{1,9}/gs) ?? []) events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: piece } });
            events.push({ type: "content_block_stop", index });
          });
          return {
            async *[Symbol.asyncIterator]() {
              yield* events;
            },
            finalMessage: async () => ({
              content: next.content,
              stop_reason: next.stop_reason,
              usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 },
            }),
          };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, requests };
}

const kb = loadKnowledgeBase(JAYSHREE);
const catalogue = new Catalogue([
  {
    url: "https://www.jayshreemachinetools.in/product/cnc-press-brake.html",
    kind: "product",
    title: "CNC Press Brake Machine",
    category: "CNC Press Brakes",
    price_text: "₹4,50,000",
    specs: { "Pressing Force": "100 ton" },
    description: "",
    related_links: [],
  },
]);

function deps(script: Array<Scripted | Error>, leads: Lead[] = []) {
  const { client, requests } = fakeClient(script);
  const d: ChatDeps = { client, kb, catalogue, systemPrompt: "SYSTEM", saveLead: (l) => leads.push(l), model: "claude-sonnet-5-5" };
  return { d, requests };
}

const text = (t: string): Scripted => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });

describe("runTurn", () => {
  it("streams a grounded answer and sends a cache-friendly request", async () => {
    const session = new SessionStore().get("jayshree-machinetools", "s-basic-0001");
    const { d, requests } = deps([text("Yes, we make CNC press brakes. Our team confirms prices. What thickness do you bend?")]);
    let streamed = "";
    const r = await runTurn(session, "do you make press brake? price?", d, { onText: (t) => (streamed += t) });

    expect(streamed).toBe(r.text);
    expect(r.text).toContain("Our team confirms prices.");
    expect(r.interventions).toEqual([]);
    const req = requests[0];
    expect(req.system).toEqual([{ type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } }]);
    expect(req.tool_choice).toEqual({ type: "auto" });
    expect(req.tools.map((t: any) => t.name)).toEqual(["send_otp", "verify_otp", "save_lead", "show_options", "share_media"]);
    expect(req.output_config).toEqual({ effort: "low" });
    expect(req.fallbacks).toBe("default");
    expect(req.betas).toEqual(["server-side-fallback-2026-07-01"]);
    const userText = req.messages[0].content[0].text as string;
    // Guardrail 1: the model never sees catalogue prices.
    expect(userText).toContain("Price: confirmed by our team on enquiry");
    expect(userText).not.toContain("4,50,000");
    expect(userText).toContain("<buyer_message>\ndo you make press brake? price?\n</buyer_message>");
    expect(session.messages).toHaveLength(2);
    expect(session.turns).toBe(1);
  });

  it("runs the OTP tool loop and tells the widget to ask for the OTP", async () => {
    const session = new SessionStore().get("jayshree-machinetools", "s-tools-0001");
    const { d, requests } = deps([
      { content: [{ type: "tool_use", id: "tu_1", name: "send_otp", input: { mobile: "9876543210" } }], stop_reason: "tool_use" },
      text("We've sent an OTP to your mobile. Please enter it here."),
    ]);
    const r = await runTurn(session, "9876543210", d);
    expect(r.askFor).toBe("otp");
    expect(session.lead.stage).toBe("otp_sent");
    const toolResultMsg = requests[1].messages.at(-1);
    expect(toolResultMsg.role).toBe("user");
    expect(toolResultMsg.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu_1", is_error: false });
    // user, assistant(tool_use), user(tool_result), assistant(text)
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("completes the whole lead flow across turns", async () => {
    const session = new SessionStore().get("jayshree-machinetools", "s-lead-00001");
    const leads: Lead[] = [];
    const { d } = deps(
      [
        { content: [{ type: "tool_use", id: "a", name: "send_otp", input: { mobile: "9876543210" } }], stop_reason: "tool_use" },
        text("OTP sent. Please enter it."),
        { content: [{ type: "tool_use", id: "b", name: "verify_otp", input: { otp: "12345" } }], stop_reason: "tool_use" },
        text("Verified, thank you. May I have your name?"),
        { content: [{ type: "tool_use", id: "c", name: "save_lead", input: { name: "Ramesh", product: "CNC Press Brake", requirements: "100 ton", quantity: "1 piece", city: "" } }], stop_reason: "tool_use" },
        text("Thanks Ramesh, our team will contact you."),
      ],
      leads,
    );
    expect((await runTurn(session, "9876543210", d)).askFor).toBe("otp");
    expect((await runTurn(session, "12345", d)).askFor).toBe("name");
    expect((await runTurn(session, "Ramesh", d)).askFor).toBeNull();
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ mobile: "9876543210", name: "Ramesh" });
  });

  it("replaces guardrail-breaking sentences and tells the model next turn", async () => {
    const session = new SessionStore().get("jayshree-machinetools", "s-guard-0001");
    const { d, requests } = deps([text("Freight is included. GST is 18% extra. Which size do you need?"), text("Sure.")]);
    const r = await runTurn(session, "is freight included?", d);
    expect(r.text).toBe(`${REPLACEMENTS.G2_freight} ${REPLACEMENTS.G8_tax} Which size do you need?`);
    expect(r.interventions.map((i) => i.rule)).toEqual(["G2_freight", "G8_tax"]);
    // History keeps the model's own words (append-only); the correction goes in the next user turn.
    expect(JSON.stringify(session.messages[1].content)).toContain("Freight is included.");
    await runTurn(session, "3 meter", d);
    const next = requests[1].messages.at(-1).content[0].text as string;
    expect(next).toMatch(/^<operator_note>[\s\S]*G2_freight, G8_tax/);
    expect(session.pendingNotes).toEqual([]);
  });

  it("drops a price that is not in the catalogue", async () => {
    const session = new SessionStore().get("jayshree-machinetools", "s-price-0001");
    const { d } = deps([text("A road roller costs about ₹8,00,000.")]);
    const r = await runTurn(session, "road roller price", d);
    expect(r.text).not.toContain("8,00,000");
    expect(r.text).toContain(REPLACEMENTS.G1_price);
  });

  it("does not keep a refused turn or run its tools", async () => {
    const session = new SessionStore().get("jayshree-machinetools", "s-refuse-001");
    const { d } = deps([{ content: [{ type: "tool_use", id: "x", name: "send_otp", input: { mobile: "9876543210" } }], stop_reason: "refusal" }]);
    const r = await runTurn(session, "something odd", d);
    expect(r.text).toMatch(/can't help with that/);
    expect(session.lead.stage).toBe("none");
    expect(session.messages).toHaveLength(0);
  });

  it("falls back politely on API errors without corrupting history", async () => {
    const session = new SessionStore().get("jayshree-machinetools", "s-error-0001");
    const err = new Anthropic.APIConnectionError({ message: "boom" });
    const { d } = deps([err]);
    const r = await runTurn(session, "hello", d);
    expect(r.text).toBe(FALLBACK_REPLY);
    expect(session.messages).toHaveLength(0);
  });
});

describe("never states prices", () => {
  it("replaces a price even when the catalogue lists it", async () => {
    const session = new SessionStore().get("jayshree-machinetools", "s-noprice-0001");
    const { d } = deps([text("The CNC press brake starts at ₹4,50,000 per piece. Which bending length do you need?")]);
    const r = await runTurn(session, "cnc press brake price", d);
    expect(r.text).not.toContain("4,50,000");
    expect(r.text).toContain(REPLACEMENTS.G1_price);
  });
});

describe("chips and media", () => {
  const tool = (id: string, name: string, input: unknown): Scripted => ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" });

  it("returns ISQ options as reply buttons", async () => {
    const session = new SessionStore().get("jayshree-machinetools", "s-chips-0001");
    const { d, requests } = deps([
      { content: [{ type: "text", text: "Which control type do you need?" }, { type: "tool_use", id: "c1", name: "show_options", input: { options: ["CNC", "NC", "cnc"] } }], stop_reason: "tool_use" },
      { content: [], stop_reason: "end_turn" },
    ]);
    const r = await runTurn(session, "I need a press brake", d);
    expect(r.chips).toEqual(["CNC", "NC"]);
    expect(r.text).toBe("Which control type do you need?");
    // Question + buttons is a whole reply: one Claude call, so the chips show at once.
    expect(requests).toHaveLength(1);
    expect(session.messages.at(-1)).toMatchObject({ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", is_error: false }] });
    // The buyer's answer joins that tool-result message, so turns still alternate.
    await runTurn(session, "CNC", d);
    const sent = requests[1].messages;
    expect(sent.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(sent.at(-1).content.map((b: any) => b.type)).toEqual(["tool_result", "text"]);
    expect(sent.at(-1).content[1].text).toContain("CNC");
  });

  it("never shows buttons while collecting the OTP", async () => {
    const session = new SessionStore().get("jayshree-machinetools", "s-chips-0002");
    session.lead.stage = "otp_sent";
    session.lead.mobile = "9876543210";
    const { d, requests } = deps([tool("c1", "show_options", { options: ["A", "B"] }), text("Please enter the OTP.")]);
    const r = await runTurn(session, "ok", d);
    expect(r.chips).toEqual([]);
    expect(requests[1].messages.at(-1).content[0].is_error).toBe(true);
  });

  it("passes share_media to the seller's resolver and returns the cards", async () => {
    const session = new SessionStore().get("jayshree-machinetools", "s-media-0001");
    const calls: unknown[] = [];
    const { d } = deps([tool("m1", "share_media", { product_ids: ["cnc-press-brake"], kinds: ["image", "video"], include_related: false }), text("Here are photos of the CNC press brake.")]);
    d.shareMedia = (ids, kinds, related) => {
      calls.push({ ids, kinds, related });
      return { cards: [{ type: "image", title: "CNC Press Brake", url: "https://img.example/a.jpg", thumb: "https://img.example/a.jpg" }], content: "shared 1 photo", isError: false };
    };
    const r = await runTurn(session, "show me photos", d);
    expect(calls).toEqual([{ ids: ["cnc-press-brake"], kinds: ["image", "video"], related: false }]);
    expect(r.cards).toHaveLength(1);
    expect(r.text).toBe("Here are photos of the CNC press brake.");
  });
});

describe("tracing", () => {
  /** A TraceSink that records what runTurn reports, with the masking the Langfuse processor applies. */
  function recorder() {
    const obs: Array<{ name: string; type: string; attrs: any; ended: boolean }> = [];
    const trace = {
      start(name: string, type: string, attrs: any = {}) {
        const o = { name, type, attrs: { ...attrs }, ended: false };
        obs.push(o);
        return { update: (a: any) => Object.assign(o.attrs, a), end: () => void (o.ended = true) };
      },
    };
    return { trace, obs };
  }

  it("records the search, each Claude call and each tool call, with usage, cost and the OTP kept out", async () => {
    const session = new SessionStore().get("jayshree-machinetools", "s-trace-0001");
    const leads: Lead[] = [];
    const { d } = deps(
      [
        { content: [{ type: "tool_use", id: "t1", name: "send_otp", input: { mobile: "9876543210" } }], stop_reason: "tool_use" },
        text("OTP sent. Please enter it."),
        { content: [{ type: "tool_use", id: "t2", name: "verify_otp", input: { otp: "12345" } }], stop_reason: "tool_use" },
        text("Verified. Your name?"),
      ],
      leads,
    );
    const r1 = recorder();
    await runTurn(session, "cnc press brake, my number 9876543210", { ...d, trace: r1.trace });
    expect(r1.obs.map((o) => `${o.type}:${o.name}`)).toEqual(["retriever:catalogue-search", "generation:claude round 1", "tool:send_otp", "generation:claude round 2"]);
    expect(r1.obs.every((o) => o.ended)).toBe(true);
    expect(r1.obs[0].attrs.output[0]).toMatchObject({ title: "CNC Press Brake Machine", kind: "product" });
    const gen = r1.obs[1].attrs;
    expect(gen.model).toBe("claude-sonnet-5-5");
    expect(gen.usageDetails).toMatchObject({ input: 100, output: 20, cache_read_input_tokens: 80 });
    expect(gen.costDetails.total).toBeCloseTo((100 * 2 + 20 * 10 + 80 * 0.2) / 1e6);
    expect(gen.metadata).toMatchObject({ stop_reason: "tool_use", fallback: false });
    // Round 2's input is just the tool result, not the whole history or system prompt.
    expect(JSON.stringify(r1.obs[3].attrs.input)).toContain("tool_result");
    expect(JSON.stringify(r1.obs[3].attrs.input)).not.toContain("SYSTEM");

    const r2 = recorder();
    await runTurn(session, "12345", { ...d, trace: r2.trace });
    const all = JSON.stringify(r2.obs);
    expect(all).not.toContain("12345");
    expect(r2.obs.find((o) => o.name === "verify_otp")!.attrs.input).toEqual({ otp: "•••••" });
  });

  it("marks a failed Claude call as an error and reports the canned reply", async () => {
    const session = new SessionStore().get("jayshree-machinetools", "s-trace-0002");
    const { d } = deps([new Error("network down")]);
    const r = recorder();
    const result = await runTurn(session, "hello", { ...d, trace: r.trace });
    expect(result.fallbackReply).toBe(true);
    const gen = r.obs.find((o) => o.type === "generation")!;
    expect(gen).toMatchObject({ ended: true, attrs: { level: "ERROR" } });
    expect(gen.attrs.statusMessage).toContain("network down");
  });

  it("records guardrail edits and lead events", async () => {
    const session = new SessionStore().get("jayshree-machinetools", "s-trace-0003");
    session.lead = { stage: "verified", mobile: "9876543210", otpAttempts: 0, otpSends: 1 };
    const { d } = deps([
      { content: [{ type: "tool_use", id: "t3", name: "save_lead", input: { name: "Ramesh", product: "Press Brake", requirements: "", quantity: "", city: "" } }], stop_reason: "tool_use" },
      text("Thanks Ramesh. The price is ₹4,50,000. Which control type do you need?"),
    ]);
    const r = recorder();
    const result = await runTurn(session, "Ramesh", { ...d, trace: r.trace });
    expect(result.leadEvents).toEqual(["captured"]);
    const g = r.obs.find((o) => o.type === "guardrail")!;
    expect(g.attrs).toMatchObject({ level: "WARNING", statusMessage: "G1_price" });
  });
});

describe("chat cost and enquiry summary", () => {
  it("adds up the cost of every Claude call in the turn", async () => {
    const session = new SessionStore().get("jayshree-machinetools", "s-cost-00001");
    const { d } = deps([{ content: [{ type: "tool_use", id: "o1", name: "show_options", input: { options: ["MS", "SS"] } }], stop_reason: "tool_use" }, text("Which material?")]);
    const r = await runTurn(session, "press brake", d);
    // Each fake call: 100 input, 20 output, 80 cache-read tokens at $2 / $10 / $0.20 per million.
    expect(r.costKnown).toBe(true);
    expect(r.costUsd).toBeCloseTo(2 * 0.000416, 12);
  });

  it("flags a turn whose model has no known price", async () => {
    const session = new SessionStore().get("jayshree-machinetools", "s-cost-00002");
    const { d } = deps([text("Hello.")]);
    const r = await runTurn(session, "hi", { ...d, model: "claude-unknown-9" });
    expect(r).toMatchObject({ costUsd: 0, costKnown: false });
  });

  it("passes the summary card from save_lead through to the chat", async () => {
    const session = new SessionStore().get("jayshree-machinetools", "s-sum-000001");
    session.lead = { stage: "captured", mobile: "9876543210", name: "Ramesh", otpAttempts: 0, otpSends: 1 };
    const leads: Lead[] = [];
    const input = { name: "Ramesh", product: "CNC Press Brake", specs: [{ label: "Material", value: "Mild steel" }], requirements: "", quantity: "1", city: "Rajkot", complete: true };
    const { d } = deps(
      [
        { content: [{ type: "tool_use", id: "s1", name: "save_lead", input }], stop_reason: "tool_use" },
        { content: [{ type: "text", text: "Here's your enquiry; our team will contact you. Anything to change?" }, { type: "tool_use", id: "s2", name: "show_options", input: { options: ["All correct", "Change a detail"] } }], stop_reason: "tool_use" },
        text(""),
      ],
      leads,
    );
    const r = await runTurn(session, "6 mm", d);
    expect(r.summary?.rows[0]).toEqual({ label: "Product", value: "CNC Press Brake" });
    expect(r.summary?.note).toContain("xxxxxx3210");
    expect(r.chips).toEqual(["All correct", "Change a detail"]);
    expect(r.leadEvents).toEqual(["updated"]);
    expect(leads[0]).toMatchObject({ update: true, requirements: "Material: Mild steel" });
  });

  it("withholds the summary through the chat loop while a spec question is still unasked", async () => {
    const session = new SessionStore().get("herbaveda", "s-guard-00001");
    session.lead = { stage: "captured", mobile: "9876543210", name: "Nitin", otpAttempts: 0, otpSends: 1 };
    const plan = { category: "Hing", label: "Hing · Hing", mcatId: "21046", source: "mcat", isqs: [{ question: "Physical Form", options: ["Granules / Lumps", "Powder"] }], presentOn: 7 };
    const isqs = { plan: () => plan as never, locate: () => null, locateText: () => ({ category: "Hing", mcatId: "21046" }) };
    const leads: Lead[] = [];
    const base = { name: "Nitin", product: "Hing", specs: [], requirements: "", quantity: "", city: "", complete: true };
    // The model jumps to complete; the tool result sends it back to the question, which it then asks with buttons.
    const first = deps(
      [
        { content: [{ type: "tool_use", id: "g1", name: "save_lead", input: base }], stop_reason: "tool_use" },
        { content: [{ type: "text", text: "Which form of hing do you need?" }, { type: "tool_use", id: "g2", name: "show_options", input: { options: ["Granules / Lumps", "Powder"] } }], stop_reason: "tool_use" },
      ],
      leads,
    );
    const r1 = await runTurn(session, "I need hing", { ...first.d, isqs });
    expect(r1.summary).toBeUndefined();
    expect(r1.chips).toEqual(["Granules / Lumps", "Powder"]);
    expect(session.lead).toMatchObject({ category: "Hing", mcatId: "21046", askedIsqs: ["Physical Form"] });
    expect(session.lead.summarized).toBeUndefined();
    expect(leads).toHaveLength(1);
    // After the answer the same call goes through and the card is shown.
    const second = deps(
      [
        { content: [{ type: "tool_use", id: "g3", name: "save_lead", input: { ...base, specs: [{ label: "Physical Form", value: "Powder" }] } }], stop_reason: "tool_use" },
        { content: [{ type: "text", text: "Our team will contact you. Anything to change?" }, { type: "tool_use", id: "g4", name: "show_options", input: { options: ["All correct", "Change a detail"] } }], stop_reason: "tool_use" },
      ],
      leads,
    );
    const r2 = await runTurn(session, "Powder", { ...second.d, isqs });
    expect(r2.summary?.rows).toContainEqual({ label: "Physical Form", value: "Powder" });
    expect(session.lead.summarized).toBe(true);
  });
});
