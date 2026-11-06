import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CardIndex, cardQuestions, mustAskAttributes, planFor, specLabel } from "../src/cardQuestions.js";
import { updateCategory, type IsqSource } from "../src/isqTracker.js";
import type { ProductCard } from "../src/kb.js";
import { parseMcatSpecs } from "../src/sellerFiles.js";
import { SellerRegistry } from "../src/sellers.js";
import type { LeadState } from "../src/session.js";

const fixtures = path.join(__dirname, "fixtures");
const ALPHA = "alpha-presses";

/** A card in the real files' shape (product-card-template-v2): attributes with a role, ask_order and values. */
const card = (over: Partial<ProductCard> & { product_id: string; canonical_name: string }): ProductCard => ({ flow: { markdown: `## **${over.canonical_name}**` }, ...over });
const brake = card({
  product_id: "press_brake",
  canonical_name: "Press Brake",
  category: "Press Brakes",
  aliases: ["CNC Press Brake 100 Ton", "Sheet Bending Machine"],
  selling_unit: { unit: "piece" },
  attributes: [
    { key: "brand", role: "ASK", required_for_lead: true, ask_order: 1, values: [{ value: "Kishan" }] },
    { key: "capacity", role: "ASK", required_for_lead: true, ask_order: 3, values: [{ value: "100 Ton" }, { value: "100 ton" }, { value: "60 Ton" }] },
    { key: "control_type", role: "ASK", required_for_lead: true, ask_order: 2, values: [{ value: "CNC" }] },
    { key: "bending_length", role: "ASK", required_for_lead: true, ask_order: 4, values: [] },
    { key: "paint_colour", role: "RARE", required_for_lead: false, values: [{ value: "Blue" }, { value: "Grey" }] },
    { key: "warranty", role: "DEFER", required_for_lead: false, values: [] },
  ],
  questions: [{ attribute: "control_type", question: "Do you need CNC or NC control?", sequence: 2 }],
});
const shear = card({ product_id: "shear", canonical_name: "Shearing Machine", aliases: ["Hydraulic Shear"], attributes: [{ key: "blade_length", role: "RARE", values: [{ value: "8 ft" }] }], selling_unit: { unit: "piece" } });

describe("must-ask specs from the product cards", () => {
  it("takes only ASK specs, in the seller's ask order, never brand or price", () => {
    expect(mustAskAttributes(brake).map((a) => a.key)).toEqual(["control_type", "capacity", "bending_length"]);
    expect(mustAskAttributes(shear)).toEqual([]);
    expect(specLabel("material_grade")).toBe("Material grade");
    expect(specLabel("product_category")).toBe("Product type");
  });

  it("grounds the options in the files: the card's values, then the MCAT file's, then the products'; else an open question", () => {
    const mcat = { id: "888", name: "Press Brake", specs: [{ name: "Control Type", options: ["NC", "CNC", "Hybrid"] }] };
    const qs = cardQuestions(brake, mcat, [[["Bending Length", "2500 mm"]], [["Bending Length", "3200 mm"]]]);
    expect(qs).toEqual([
      // One card value: the MCAT file's options for the same spec fill it; the seller's own phrasing is kept as a hint.
      { question: "Control type", options: ["CNC", "NC", "Hybrid"], from: "card", hint: 'the seller asks "Do you need CNC or NC control?"' },
      // Spellings merged ("100 Ton" = "100 ton").
      { question: "Capacity", options: ["100 Ton", "60 Ton"], from: "card" },
      // No card values and no MCAT spec: the seller's products list it.
      { question: "Bending length", options: ["2500 mm", "3200 mm"], from: "card" },
    ]);
    // Nothing anywhere to make buttons from: asked in words, with the one listed value as a hint.
    const bare = cardQuestions(brake, undefined, []);
    expect(bare[0]).toEqual({ question: "Control type", options: [], from: "card", hint: 'the seller asks "Do you need CNC or NC control?"; the seller lists CNC' });
    expect(bare[2]).toEqual({ question: "Bending length", options: [], from: "card" });
  });
});

describe("finding the buyer's card", () => {
  const index = new CardIndex([brake, shear], new Map([["press_brake", { category: "Press Brakes", mcatId: "888" }], ["shear", { category: "Shears", mcatId: "777" }]]));

  it("by the product's title, else its category and MCAT, else the only card in its category", () => {
    expect(index.forProduct("CNC Press Brake 100 Ton", null, null)).toBe("press_brake");
    expect(index.forProduct("Some Other Brake", "Press Brakes", "888")).toBe("press_brake");
    expect(index.forProduct("Some Other Brake", "Press Brakes", null)).toBe("press_brake");
    expect(index.forProduct("Unknown", "Lathes", null)).toBeNull();
  });

  it("by the buyer's own words, but never from a greeting or a tie", () => {
    expect(index.forText("need a sheet bending machine")).toBe("press_brake");
    expect(index.forText("hydraulic shear chahiye")).toBe("shear");
    expect(index.forText("hi")).toBeNull();
    expect(index.forText("hello, price?")).toBeNull();
  });

  it("lets the tracker pick a card the catalogue can't find", () => {
    const src: IsqSource = {
      plan: (_c, _m, cardId) => (cardId ? ({ category: "Shears", label: "Shearing Machine", mcatId: null, source: "card", isqs: [{ question: "Blade length", options: ["8 ft", "10 ft"] }], presentOn: 0 } as never) : null),
      locate: () => null,
      locateText: () => null,
      locateCard: (t) => (index.forText(t) ? { category: "Shears", mcatId: "777", cardId: index.forText(t) } : null),
    };
    const lead: LeadState = { stage: "captured", otpAttempts: 0, otpSends: 1 };
    expect(updateCategory(lead, src, { buyerText: "hi", hits: [], ownHits: false })).toBe(false);
    expect(updateCategory(lead, src, { buyerText: "hydraulic shear chahiye", hits: [], ownHits: false })).toBe(true);
    expect(lead).toMatchObject({ category: "Shears", mcatId: "777", cardId: "shear" });
  });
});

describe("answers during the closing steps", () => {
  it("doesn't move the chat to another product on a quantity, firm or city reply", () => {
    const plan = { category: "Plates", label: "Compartment Plates", mcatId: null, source: "card", isqs: [{ question: "Shape", options: ["Round", "Square"] }], presentOn: 3 };
    const src: IsqSource = {
      plan: () => plan as never,
      locate: (e) => ({ category: e.category, mcatId: null, cardId: null }),
      locateText: () => null,
    };
    const entry = (title: string, category: string) => ({ url: `https://x/${title}`, kind: "product" as const, slug: title, title, category, price_text: null, specs: {}, description: "", image: null, images: [], details: "", features: [], videos: [], documents: [], breadcrumbs: [], products: [] });
    const lead: LeadState = { stage: "captured", otpAttempts: 0, otpSends: 1, category: "Plates", cardId: "plates", askedIsqs: ["Shape"], details: { product: "Compartment plates" } };
    // Quantity: "pieces" is not a product word.
    expect(updateCategory(lead, src, { buyerText: "500 pieces", hits: [entry("6 Pieces Dinner Set", "Dinner Sets")], ownHits: true })).toBe(false);
    lead.details = { ...lead.details, quantity: "500 pieces", buyerType: "business" };
    // Firm name: one shared word with a product title is not enough now.
    expect(updateCategory(lead, src, { buyerText: "Awadh Canteen Services", hits: [entry("Canteen Thali", "Thali")], ownHits: true })).toBe(false);
    expect(lead.category).toBe("Plates");
    // Naming another product outright still switches.
    expect(updateCategory(lead, src, { buyerText: "also need a canteen thali set", hits: [entry("Canteen Thali", "Thali")], ownHits: true })).toBe(true);
    expect(lead.category).toBe("Thali");
  });
});

describe("the plan for a chat: card first, then the MCAT file, then the products", () => {
  const registry = () => {
    const reg = SellerRegistry.load(path.join(fixtures, "sellers"), fs.mkdtempSync(path.join(os.tmpdir(), "cards-")));
    reg.setUploadedKb(ALPHA, JSON.parse(fs.readFileSync(path.join(fixtures, "kb", "alpha-kb.json"), "utf8")));
    const mcat = parseMcatSpecs([{ mcat_id: 888, mcat_name: "Press Brakes", specifications: [{ name: "Bending Length", options: ["2500 mm", "3200 mm"] }, { name: "Capacity", options: ["60 Ton", "100 Ton", "200 Ton"] }] }]);
    if (!mcat.ok) throw new Error("parse");
    const at = "2026-11-06T00:00:00Z";
    reg.setSellerFile(ALPHA, "mcat", { value: mcat.value, uploadedAt: at, summary: "", warnings: [] });
    return { reg, at };
  };

  it("asks the card's must-ask specs when the buyer's product has a card", () => {
    const { reg, at } = registry();
    reg.setSellerFile(ALPHA, "product-cards", { value: [brake, shear], uploadedAt: at, summary: "", warnings: [] });
    const s = reg.get(ALPHA)!;
    expect(s.cardIndex?.size).toBe(2);
    const view = s.uploaded!.view;
    const cardId = s.cardIndex!.forProduct("CNC Press Brake 100 Ton", "Press Brakes", null);
    expect(cardId).toBe("press_brake");
    const plan = planFor(view, s.cardIndex, "Press Brakes", null, cardId)!;
    expect(plan).toMatchObject({ source: "card", label: "Press Brake", card: { id: "press_brake", name: "Press Brake" }, unit: "piece" });
    // Control type has one card value and no MCAT spec, so the seller's products fill it (CNC, NC).
    expect(plan.isqs.map((q) => [q.question, q.options])).toEqual([
      ["Control type", ["CNC", "NC"]],
      ["Capacity", ["100 Ton", "60 Ton"]],
      ["Bending length", ["2500 mm", "3200 mm"]],
    ]);
    // The mapping report lists each card's questions and flags the cards without any.
    const cards = s.mapping!.cards;
    expect(cards.find((c) => c.name === "Press Brake")?.questions.map((q) => q.question)).toEqual(["Control type", "Capacity", "Bending length"]);
    expect(s.mapping!.flags.join(" ")).toContain("1 of 2 product cards have no must-ask specs");
  });

  it("falls back to the MCAT file's specs when the card has none, keeping the card's selling unit", () => {
    const { reg, at } = registry();
    const noAsk = { ...brake, attributes: brake.attributes!.map((a) => ({ ...a, role: "RARE", required_for_lead: false })) };
    reg.setSellerFile(ALPHA, "product-cards", { value: [noAsk], uploadedAt: at, summary: "", warnings: [] });
    const s = reg.get(ALPHA)!;
    const plan = planFor(s.uploaded!.view, s.cardIndex, "Press Brakes", null, "press_brake")!;
    expect(plan).toMatchObject({ source: "mcat", mcat: "Press Brakes", unit: "piece" });
    expect(plan.isqs.map((q) => q.question)).toEqual(["Bending Length", "Capacity"]);
    // No card at all: the same category plan.
    expect(planFor(s.uploaded!.view, s.cardIndex, "Press Brakes", null, null)?.source).toBe("mcat");
  });

  it("keeps the seller policy card in the system prompt as handling rules", async () => {
    const { reg, at } = registry();
    const { parseSellerFile } = await import("../src/sellers.js");
    const md = parseSellerFile("business-card", "## Dispatch\n- Dispatch in 7 days after payment.\n## Must escalate\n- Bulk orders over 100 pieces go to the owner.");
    if (!md.ok) throw new Error("parse");
    reg.setSellerFile(ALPHA, "business-card", { value: md.value, uploadedAt: at, summary: "", warnings: [] });
    const sys = reg.get(ALPHA)!.systemPrompt;
    expect(sys).toContain("## Seller policy card (how to handle these topics)");
    expect(sys).toContain("Bulk orders over 100 pieces go to the owner.");
  });
});
