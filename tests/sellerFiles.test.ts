import { describe, expect, it } from "vitest";
import type { ProductCard } from "../src/kb.js";
import { fillCardIsqs, findMcat, matchingMcats, namesMatch, parseBusinessCardMd, parseMcatSpecs, parseProductCards } from "../src/sellerFiles.js";

describe("business card markdown", () => {
  it("keeps every policy section as handling rules, drops identity facts, strips amounts and terms, and allows the listed contact", () => {
    const md = `# POLICY CARD — Alpha Presses

## Business
- **Name**: Alpha Presses Pvt Ltd
- **GSTIN**: 24AAACA1234F1Z5
- **Bank**: HDFC, account number 123456789
- **Annual turnover**: 5-10 crore
- **Location**: Rajkot, Gujarat
- **Deals in**: Press Brakes, Shearing Machines, Iron Workers
- **IndiaMART listed contact**: 080-4826-4349
We have been manufacturing presses since 1995. We make heavy-duty press brakes.

## GST
GST applicability is conflicted (some quotes include GST while others charge 18% GST extra). Must NOT quote a universal GST stance; defer to the team.

## Pricing basis
Prices start around ₹ 4,50,000 per machine and depend on tonnage. Payment is 50% advance, balance before dispatch. The final quotation comes only from the sales team.

## Availability / lead time
Standard models ship in 15-20 days; confirm per order with the team.

## Must escalate
- Requests for exact delivery dates

## Dropped — insufficient evidence
- **dispatch.from**: fewer than two seller conversations`;
    const r = parseBusinessCardMd(md);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.value.text;
    expect(t).toContain("**Name**: Alpha Presses Pvt Ltd");
    expect(t).toContain("**Location**: Rajkot, Gujarat");
    expect(t).toContain("We make heavy-duty press brakes.");
    expect(t).not.toMatch(/GSTIN|HDFC|turnover|1995|Dropped|dispatch\.from/);
    // Policy sections stay, as rules without figures or payment terms.
    expect(t).toContain("## GST");
    expect(t).toContain("charge [amount] GST extra");
    expect(t).toContain("Must NOT quote a universal GST stance; defer to the team.");
    expect(t).toContain("Prices start around [amount] and depend on tonnage.");
    expect(t).toContain("The final quotation comes only from the sales team.");
    expect(t).not.toMatch(/advance|4,50,000|18%|15-20 days/);
    expect(t).toContain("Standard models ship in [amount]; confirm per order with the team.");
    expect(t).toContain("- Requests for exact delivery dates");
    expect(r.value.sections).toEqual(["Business", "GST", "Pricing basis", "Availability / lead time", "Must escalate"]);
    expect(r.value.dealsIn).toEqual(["Press Brakes", "Shearing Machines", "Iron Workers"]);
    expect(r.value.phones).toEqual(["8048264349"]);
    // 18%, ₹ 4,50,000, the advance-payment sentence, 15-20 days and the "since 1995" sentence.
    expect(r.value.stripped).toBe(5);
    expect(r.warnings[0]).toMatch(/^3 lines left out/);
    expect(r.warnings[1]).toMatch(/^5 values removed/);
  });

  it("refuses an empty or oversized file", () => {
    expect(parseBusinessCardMd("  \n ").ok).toBe(false);
    expect(parseBusinessCardMd("x".repeat(50_001)).ok).toBe(false);
  });
});

describe("MCAT specifications", () => {
  const file = [
    {
      mcat_id: 85047,
      mcat_name: "Hydraulic Ironworker",
      specifications: [
        { name: "Tonnage Capacity", options: ["60 Ton", "90 Ton", "60 ton"] },
        { name: "Brand", options: ["Kishan", "Other"] },
        { name: "Price Range", options: ["1-2 lakh", "2-5 lakh"] },
        { name: "Finance/Loan Requirement", options: ["Yes", "No"] },
        { name: "Usage", options: ["Industrial"] },
      ],
    },
    { mcat_id: 1067, mcat_name: "Concrete Vibrator", specifications: [{ name: "Power Source", options: ["Electric", "Petrol"] }] },
    { mcat_name: "" },
  ];

  it("keeps spec questions with at least two options and drops brand, price and finance fields", () => {
    const r = parseMcatSpecs(file);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[0]).toEqual({ id: "85047", name: "Hydraulic Ironworker", specs: [{ name: "Tonnage Capacity", options: ["60 Ton", "90 Ton"] }] });
    expect(r.summary).toBe("2 MCATs");
    expect(r.warnings).toEqual(["MCAT 3: skipped (no mcat_name).", "4 specifications left out (brand, model, price-like, or fewer than 2 options)."]);
    expect(parseMcatSpecs({ mcats: file }).ok).toBe(true);
    expect(parseMcatSpecs({ nope: 1 }).ok).toBe(false);
  });

  it("matches MCATs to what a seller deals in, by id or by name, never the other way round", () => {
    const r = parseMcatSpecs(file);
    if (!r.ok) throw new Error("parse");
    expect(matchingMcats(r.value, { names: ["Hydraulic Iron Worker"], mcatIds: new Set() }).map((m) => m.name)).toEqual(["Hydraulic Ironworker"]);
    expect(matchingMcats(r.value, { names: ["Press Brake"], mcatIds: new Set(["1067"]) }).map((m) => m.name)).toEqual(["Concrete Vibrator"]);
    expect(findMcat(r.value, ["Shearing Machine"])).toBeUndefined();
  });

  it("compares names ignoring case, plurals and spacing", () => {
    expect(namesMatch("Ironworker Machine", "IRON WORKER MACHINES")).toBe(true);
    expect(namesMatch("Bending Machine", "Metal Sheet Bending Machine")).toBe(true);
    // A seller listing the general term doesn't own every specific kind.
    expect(namesMatch("Bar Bending Machine", "Bending Machine")).toBe(false);
    // One-word terms must match exactly.
    expect(namesMatch("Press", "Hydraulic Press")).toBe(false);
    expect(namesMatch("Presses", "press")).toBe(true);
  });

  it("gives ISQs to product cards that have none, and leaves cards with their own ISQs alone", () => {
    const r = parseMcatSpecs(file);
    if (!r.ok) throw new Error("parse");
    const cards: ProductCard[] = [
      { product_id: "iw", canonical_name: "Ironworker", aliases: ["Hydraulic Iron Worker"], flow: { markdown: "## Ironworker" } },
      { product_id: "pb", canonical_name: "Hydraulic Ironworker Deluxe", flow: { markdown: "## Deluxe\n\n**Qualification questions:**\n\n- capacity: Which capacity?" } },
    ];
    const out = fillCardIsqs(cards, r.value);
    expect(out.filled).toEqual(["Ironworker"]);
    expect(out.cards[0].flow.markdown).toContain("**Qualification questions (from MCAT Hydraulic Ironworker;");
    expect(out.cards[0].flow.markdown).toContain("1. Tonnage Capacity? Options: 60 Ton / 90 Ton");
    expect(out.cards[1]).toBe(cards[1]);
  });
});

describe("product cards file", () => {
  it("keeps valid cards and skips broken or duplicate ones with a note", () => {
    const r = parseProductCards([
      { product_id: "a", canonical_name: "A", flow: { markdown: "## A" } },
      { product_id: "b", canonical_name: "B" },
      { product_id: "a", canonical_name: "A again", flow: { markdown: "## A" } },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((c) => c.product_id)).toEqual(["a"]);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[1]).toContain('product_id "a" used twice');
    expect(parseProductCards([{ product_id: "x" }]).ok).toBe(false);
    expect(parseProductCards({}).ok).toBe(false);
  });
});
