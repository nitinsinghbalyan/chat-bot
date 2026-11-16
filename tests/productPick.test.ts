import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { IsqSource } from "../src/isqTracker.js";
import { JevService, productCandidates, type SystemOneCaller, type SystemOneRequest } from "../src/jev.js";
import { ClaudeProductPicker, modelDecision, type CallRecord, type ModelPick, type ProductPicker, type ProductPicks } from "../src/productPick.js";
import type { LeadState } from "../src/session.js";
import type { ObservationAttrs, TraceSink } from "../src/tracing.js";

const entry = (title: string, category: string) => ({ url: `https://x/${encodeURIComponent(title)}`, kind: "product" as const, slug: title, title, category, price_text: null, specs: {}, description: "", image: null, images: [], details: "", features: [], videos: [], documents: [], breadcrumbs: [], products: [] });
const brake = entry("CNC Press Brake 100 Ton", "Press Brakes");
const shear = entry("Hydraulic Shearing Machine", "Shearing Machines");
const src: IsqSource = {
  plan: (category) => (category ? ({ category, label: category, mcatId: null, source: "derived", isqs: [{ question: `${category} size`, options: ["Small", "Large"] }], presentOn: 1 } as never) : null),
  locate: (e) => ({ category: e.category, mcatId: null, cardId: null }),
  locateText: () => null,
};
const lead = (over: Partial<LeadState> = {}): LeadState => ({ stage: "captured", otpAttempts: 0, otpSends: 1, ...over });
const candidates = productCandidates([brake, shear], src, "need a brake");

describe("the comparison model's decision", () => {
  const input = { buyerText: "x", candidates };
  it("follows Jev's rules: not about a product keeps, low confidence is unsure, otherwise it picks", () => {
    expect(modelDecision(input, { product: "press_brakes", about_product: false, confidence: "high" })).toEqual({ decision: "keep", reason: "not about a product" });
    expect(modelDecision(input, { product: "press_brakes", about_product: true, confidence: "low" })).toEqual({ decision: null, reason: "unsure" });
    expect(modelDecision(input, { product: "none", about_product: true, confidence: "high" })).toEqual({ decision: null, reason: "unsure" });
    expect(modelDecision(input, { product: "shearing_machines", about_product: true, confidence: "medium" }).decision).toMatchObject({ category: "Shearing Machines" });
  });
  it("switches only when the buyer moves to another product", () => {
    const current = { label: "Press Brakes", place: { category: "Press Brakes", mcatId: null, cardId: null } };
    const withCurrent = { ...input, current };
    expect(modelDecision(withCurrent, { product: "press_brakes", about_product: true, other_product: true, confidence: "high" }).reason).toBe("same product");
    expect(modelDecision(withCurrent, { product: "shearing_machines", about_product: true, other_product: false, confidence: "high" }).reason).toBe("still the current product");
    expect(modelDecision(withCurrent, { product: "shearing_machines", about_product: true, other_product: true, confidence: "high" }).reason).toBe("switch");
  });
});

describe("the Claude product picker", () => {
  const client = (reply: () => unknown) => {
    const sent: any[] = [];
    const c = { messages: { create: async (body: unknown) => (sent.push(body), reply()) } } as unknown as Anthropic;
    return { c, sent };
  };
  it("asks the same question as Jev with a structured answer and reads tokens and the decision", async () => {
    const { c, sent } = client(() => ({ model: "claude-haiku-5-5", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ product: "shearing_machines", about_product: true, confidence: "high" }) }], usage: { input_tokens: 800, output_tokens: 30 } }));
    const pick = await new ClaudeProductPicker(c, "claude-haiku-5-5").pick({ buyerText: "metal cutting machine, call 9876543210", candidates });
    expect(pick).toMatchObject({ reason: "pick", choice: "shearing_machines", confidence: "high", model: "claude-haiku-5-5", usage: { input: 800, output: 30 } });
    expect(pick.decision).toMatchObject({ category: "Shearing Machines" });
    const body = sent[0];
    expect(body.output_config.format.schema.properties.product.enum.sort()).toEqual(["none", "press_brakes", "shearing_machines"]);
    expect(body.output_config.format.schema.properties).not.toHaveProperty("other_product");
    expect(body.messages[0].content).toContain("[number]");
    expect(body.messages[0].content).not.toContain("9876543210");
  });
  it("reports errors instead of throwing", async () => {
    const { c } = client(() => {
      throw new Error("overloaded");
    });
    expect(await new ClaudeProductPicker(c, "claude-haiku-5-5").pick({ buyerText: "x", candidates })).toMatchObject({ decision: null, reason: "error", error: "overloaded" });
  });
});

describe("the Jev service on a test chat", () => {
  const jev: SystemOneCaller & { sent: SystemOneRequest[] } = {
    model: "jev-1.14.0",
    sent: [],
    async systemOne(req) {
      this.sent.push(req);
      const key = Object.keys((req.questions.product as { criteria: Record<string, string> }).criteria).find((k) => k.startsWith("shearing"))!;
      return { ok: true, res: { model: "jev-1.14.0", answers: { product: { type: "choice", choice: key, confidence: 0.9, probabilities: {} }, about_product: { type: "noul", noul: 0.95 } }, usage: { input_tokens: 1000, output_tokens: 12 } }, ms: 40 };
    },
  };
  const asked: Array<{ order: string[] }> = [];
  const comparer: ProductPicker = {
    model: "claude-haiku-5-5",
    async pick(input, rng): Promise<ModelPick> {
      const shuffled = [...input.candidates];
      // Record the order the comparison model would see, to check it matches Jev's.
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng!() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      asked.push({ order: shuffled.map((c) => c.key) });
      return { decision: input.candidates[0]!.place, reason: "pick", confidence: "high", ms: 900, usage: { input: 900, output: 25, cacheRead: 0, cacheWrite: 0 }, model: "claude-haiku-5-5" };
    },
  };
  const observations: Array<{ name: string; type: string; attrs: ObservationAttrs[] }> = [];
  const trace: TraceSink = {
    start(name, type, attrs = {}) {
      const o = { name, type, attrs: [attrs] };
      observations.push(o);
      return { update: (a) => void o.attrs.push(a), end() {} };
    },
  };
  const svc = new JevService({ caller: jev, mode: () => "shadow", minConfidence: 0.5, comparer });

  it("asks both, in parallel, with the options in the same order, and records each call with tokens, latency and cost", async () => {
    const calls: CallRecord[] = [];
    const picks: ProductPicks = {};
    expect(await svc.decide({ lead: lead(), src, buyerText: "metal cutting machine", hits: [brake, shear], ownHits: true, trace, compare: true, calls, picks })).toBeUndefined();
    const jevOrder = Object.keys((jev.sent[0]!.questions.product as { criteria: Record<string, string> }).criteria);
    expect(asked[0]!.order).toEqual(jevOrder);
    expect(calls).toEqual([
      expect.objectContaining({ kind: "jev-pick", model: "jev-1.14.0", inputTokens: 1000, outputTokens: 12, latencyMs: 40, decision: "Shearing Machines" }),
      expect.objectContaining({ kind: "haiku-pick", model: "claude-haiku-5-5", inputTokens: 900, outputTokens: 25, latencyMs: 900, decision: "Press Brakes" }),
    ]);
    expect(calls[0]!.costUsd).toBeCloseTo(1000 * 0.042e-6, 12);
    expect(calls[1]!.costUsd).toBeCloseTo(900 * 0.1e-6 + 25 * 0.5e-6, 12);
    expect(picks).toMatchObject({ current: null, jev: "Shearing Machines", haiku: "Press Brakes" });
    // Both are Langfuse generations with usage and cost, so Langfuse shows tokens, latency and cost per call.
    const jevObs = observations.find((o) => o.name === "jev-product-pick")!;
    expect(jevObs.type).toBe("generation");
    expect(jevObs.attrs.at(-1)).toMatchObject({ usageDetails: { input: 1000, output: 12 }, costDetails: { total: expect.any(Number) } });
    expect(observations.find((o) => o.name === "haiku-product-pick")?.type).toBe("generation");
  });

  it("asks only Jev on a real chat", async () => {
    const calls: CallRecord[] = [];
    const before = asked.length;
    await svc.decide({ lead: lead(), src, buyerText: "metal cutting machine", hits: [brake, shear], ownHits: true, compare: false, calls });
    expect(asked).toHaveLength(before);
    expect(calls.map((c) => c.kind)).toEqual(["jev-pick"]);
  });
});
