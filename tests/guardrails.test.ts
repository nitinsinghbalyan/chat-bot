import { describe, expect, it } from "vitest";
import { checkInput, checkSentence, extractAmounts, OutputFilter, RateLimiter, REPLACEMENTS, type OutputContext } from "../src/guardrails.js";

const ctx: OutputContext = {
  allowedPrices: ["₹4,50,000"],
  allowedPhones: ["8048264349"],
  allowedDomains: ["jayshreemachinetools.in"],
};

describe("checkInput", () => {
  it("rejects empty, non-string and over-long messages", () => {
    expect(checkInput("   ").ok).toBe(false);
    expect(checkInput(42).ok).toBe(false);
    expect(checkInput("a".repeat(1001)).ok).toBe(false);
  });

  it("keeps ordinary enquiries and mobile numbers intact", () => {
    const r = checkInput("Need 100 ton press brake, 3 meter. My number is 9876543210");
    expect(r.ok).toBe(true);
    expect(r.redacted).toEqual([]);
    expect(r.text).toContain("9876543210");
  });

  it.each([
    ["UPI ID", "pay to ramesh.k@okaxis please"],
    ["GSTIN", "our GSTIN is 24AAACJ1234F1Z5"],
    ["PAN", "PAN ABCDE1234F"],
    ["Aadhaar number", "aadhar 2345 6789 0123"],
    ["card number", "card 4111 1111 1111 1111"],
    ["IFSC", "IFSC HDFC0001234"],
    ["bank account number", "account no 123456789012"],
  ])("redacts %s (Guardrail 5)", (kind, text) => {
    const r = checkInput(text);
    expect(r.ok).toBe(true);
    expect(r.redacted).toContain(kind);
  });

  it("does not treat an email address as a UPI ID", () => {
    expect(checkInput("mail me at buyer@example.com").redacted).toEqual([]);
  });
});

describe("extractAmounts", () => {
  it("parses rupee formats", () => {
    expect(extractAmounts("₹ 4,50,000 / Piece")).toEqual([450000]);
    expect(extractAmounts("Rs. 4.5 lakh")).toEqual([450000]);
    expect(extractAmounts("around 18 lakh")).toEqual([1800000]);
    expect(extractAmounts("INR 1.2 crore")).toEqual([12000000]);
    expect(extractAmounts("costs 3,50,000")).toEqual([350000]);
  });

  it("ignores specs that are not money", () => {
    expect(extractAmounts("100 ton, 3125 mm, 1.5 kW, 8 mm MS")).toEqual([]);
  });
});

describe("checkSentence", () => {
  it.each([
    ["The starting price is ₹4,50,000 per piece.", null],
    ["The starting price is around Rs 4.5 lakh.", null],
    ["A similar machine would be about ₹6,00,000.", "G1_price"],
    ["It costs 7 lakh.", "G1_price"],
    ["Freight is extra.", "G2_freight"],
    ["We offer free shipping across India.", "G2_freight"],
    ["You can call us at 9123456789.", "G3_contact"],
    ["Our listed contact number is 8048264349.", null],
    ["Email sales@example.com for details.", "G3_contact"],
    ["See https://www.jayshreemachinetools.in/cnc-press-brake.html for details.", null],
    ["Message us on https://wa.me/919999999999", "G3_contact"],
    ["Kishan machines are in stock.", "G4_stock"],
    ["We can't confirm whether it is in stock.", null],
    ["Please share your UPI ID to book the order.", "G5_payment"],
    ["You don't need to share bank details here.", null],
    ["We can dispatch within 7 days.", "G6_delivery"],
    ["Delivery usually takes 2-3 weeks.", "G6_delivery"],
    ["We provide door delivery.", "G6_delivery"],
    ["GST is 18% extra.", "G8_tax"],
    ["The price is inclusive of GST.", "G8_tax"],
    ["What sheet thickness do you need?", null],
  ])("%s -> %s", (sentence, rule) => {
    expect(checkSentence(sentence, ctx)).toBe(rule);
  });
});

describe("OutputFilter", () => {
  function run(chunks: string[]) {
    const f = new OutputFilter(ctx);
    const out = chunks.map((c) => f.push(c)).join("") + f.flush();
    return { out, f };
  }

  it("passes safe text through unchanged across arbitrary chunking", () => {
    const text = "We make CNC press brakes. The starting price is Rs. 4,50,000 per piece. What thickness do you need?";
    const { out, f } = run(text.match(/.{1,7}/gs)!);
    expect(out).toBe(text);
    expect(f.interventions).toEqual([]);
  });

  it("replaces only the offending sentence", () => {
    const { out, f } = run(["Yes, we make it. ", "Freight is included in the price. ", "Which size do you need?"]);
    expect(out).toBe(`Yes, we make it. ${REPLACEMENTS.G2_freight} Which size do you need?`);
    expect(f.interventions.map((i) => i.rule)).toEqual(["G2_freight"]);
  });

  it("does not split 'Rs.' away from the amount", () => {
    const { out } = run(["It starts at Rs. ", "9,99,000 per piece."]);
    expect(out).toBe(REPLACEMENTS.G1_price + " ");
  });

  it("emits a replacement once per rule", () => {
    const { out } = run(["GST is 18%. Tax is extra. Anything else?"]);
    expect(out).toBe(`${REPLACEMENTS.G8_tax} Anything else?`);
  });
});

describe("RateLimiter", () => {
  it("blocks after the limit within the window", () => {
    const rl = new RateLimiter(2, 1000);
    expect(rl.allow("a", 0)).toBe(true);
    expect(rl.allow("a", 10)).toBe(true);
    expect(rl.allow("a", 20)).toBe(false);
    expect(rl.allow("a", 1500)).toBe(true);
  });
});
