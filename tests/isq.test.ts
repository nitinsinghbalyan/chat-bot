import { describe, expect, it } from "vitest";
import type { CatalogueEntry } from "../src/crawler.js";
import { markAnswered, markAsked, specQuestionsText, updateCategory, type IsqSource } from "../src/isqTracker.js";
import { deriveIsqs, KbView, specNamesMatch, type SellerKb } from "../src/sellerKb.js";
import { parseMcatSpecs } from "../src/sellerFiles.js";
import type { LeadState } from "../src/session.js";

/** A small export: press brakes split over three categories (two share MCAT 25058), plus shears. */
function kb(): SellerKb {
  const product = (id: string, name: string, cat: string, mcat: string, specs: Array<[string, string]>) => ({
    product_id: id,
    product_url: `https://seller.example/${id}.html`,
    name,
    display_name: "",
    category_id: cat,
    taxonomy: { category_name: "", glmcat_ids: `,${mcat},`, glcat_ids: "" },
    item_code: "",
    description: "",
    specifications: specs.map(([n, v]) => ({ name: n, value: v })),
    brand: "",
    min_order_quantity: "",
    price_unit: "",
    media: null,
  });
  return {
    _version: "3.0",
    seller: { company_name: "Seller", website_url: "", business_summary: "", nature_of_business: "", contact_person: "", contact_designation: "", address: null, phone: "", whatsapp_number: "", factsheet: [], logo_url: "", corporate_video_url: "", corporate_brochure_url: "" },
    company_pages: [],
    photo_gallery: [],
    categories: [
      { category_id: "c1", name: "CNC PRESS BRAKE", url: "", description: "", image_url: "", product_ids: ["1", "2"] },
      { category_id: "c2", name: "Cnc Press Brake Machine", url: "", description: "", image_url: "", product_ids: ["3"] },
      { category_id: "c3", name: "Shearing Machine", url: "", description: "", image_url: "", product_ids: ["4", "5"] },
    ],
    products: [
      product("1", "CNC Press Brake 100 Ton", "c1", "25058", [["Capacity", "100 Ton"], ["Control Axis", "4 AXIS"], ["Usage/Application", "Industrial"]]),
      product("2", "CNC Press Brake 200 Ton", "c1", "25058", [["Capacity", "200 Ton"], ["Control Axis", "5 AXIS"], ["Machine Type", "Press Brake"]]),
      product("3", "Tandem CNC Press Brake", "c2", "25058", [["Capacity", "500 Ton"], ["Control Axis", "8 + 1 AXIS"]]),
      product("4", "Hydraulic Shear 6 mm", "c3", "185336", [["Shearing Thickness", "6 mm"], ["Automation Grade", "Semi-Automatic"]]),
      product("5", "NC Shear 12 mm", "c3", "185336", [["Shearing Thickness", "12 mm"], ["Automation Grade", "Semi Automatic, Automatic"]]),
    ],
  } as unknown as SellerKb;
}

describe("ISQs per category and MCAT", () => {
  it("cleans derived ISQs: no usage or machine type, merged spellings, no bare numbers", () => {
    const isqs = deriveIsqs([
      [["Automation Grade", "Semi-Automatic"], ["Usage/Application", "Industrial"], ["Capacity", "6 00"], ["Capacity", "4 MM"]],
      [["Automation Grade", "Semi Automatic, Automatic"], ["Machine Type", "Shear"], ["Capacity", "6 MM"]],
    ]);
    expect(isqs).toEqual([
      { question: "Automation Grade", options: ["Semi-Automatic", "Automatic"] },
      { question: "Capacity", options: ["4 MM", "6 MM"] },
    ]);
  });

  it("knows each category's MCATs and, without an MCAT file, derives questions from that category's own products", () => {
    const v = new KbView(kb());
    const [a, b, shears] = v.kb.categories;
    expect(v.mcatsOf(a)).toEqual([{ id: "25058", products: 2, name: undefined, inFile: false }]);
    expect(v.mainMcatOf(shears)).toBe("185336");
    expect(v.isqPlan(a)).toMatchObject({ source: "derived", label: "CNC PRESS BRAKE", mcatId: "25058", presentOn: 2 });
    expect(v.isqPlan(a).isqs).toEqual([
      { question: "Capacity", options: ["100 Ton", "200 Ton"] },
      { question: "Control Axis", options: ["4 AXIS", "5 AXIS"] },
    ]);
    // One product gives no choices, so no questions rather than another category's.
    expect(v.isqPlan(b).isqs).toEqual([]);
    expect(v.isqPlan(shears).isqs.map((q) => q.question)).toEqual(["Shearing Thickness", "Automation Grade"]);
  });

  const file = () =>
    parseMcatSpecs([
      {
        mcat_id: 25058,
        mcat_name: "CNC Press Brake",
        specifications: [
          { name: "Bending Length", options: ["2500 mm", "3200 mm"] },
          { name: "Capacity", options: ["300 Ton", "100 Ton", "200 Ton", "500 Ton"] },
          { name: "Control Axis", options: ["3 AXIS", "4 AXIS"] },
        ],
      },
      { mcat_id: 1, mcat_name: "Shearing Machines", specifications: [{ name: "Blade Length", options: ["8 ft", "10 ft"] }, { name: "Max Shearing Thickness", options: ["4 mm", "6 mm", "12 mm"] }] },
      { mcat_id: 2, mcat_name: "Machine", specifications: [{ name: "Colour", options: ["Red", "Blue"] }] },
    ]);

  it("with the MCAT file: asks only the MCAT's specs that the seller's products carry, the seller's options first", () => {
    const m = file();
    if (!m.ok) throw new Error("parse");
    const v = new KbView(kb(), { mcats: m.value });
    const [a, b, shears] = v.kb.categories;
    // By MCAT id 25058: Bending Length is on no product, so it is never asked; the products' values lead the options.
    expect(v.isqPlan(a)).toMatchObject({ source: "mcat", mcat: "CNC Press Brake", label: "CNC PRESS BRAKE · CNC Press Brake", mcatId: "25058", presentOn: 2 });
    expect(v.isqPlan(a).isqs).toEqual([
      { question: "Capacity", options: ["100 Ton", "200 Ton", "300 Ton", "500 Ton"] },
      { question: "Control Axis", options: ["4 AXIS", "3 AXIS"] },
    ]);
    // The same MCAT in another category is checked against that category's products.
    expect(v.isqPlan(b).isqs).toEqual([
      { question: "Capacity", options: ["500 Ton", "300 Ton", "100 Ton", "200 Ton"] },
      { question: "Control Axis", options: ["3 AXIS", "4 AXIS"] },
    ]);
    // No entry for 185336, but "Shearing Machines" equals "Shearing Machine"; "Max Shearing Thickness" covers "Shearing Thickness".
    expect(v.isqPlan(shears)).toMatchObject({ source: "mcat", mcat: "Shearing Machines", isqs: [{ question: "Max Shearing Thickness", options: ["6 mm", "12 mm", "4 mm"] }] });
    expect(v.systemText()).toContain("ISQs (from MCAT CNC Press Brake)");
    expect(v.systemText()).not.toContain("Colour");
  });

  it("asks the buyer's product's MCAT within a mixed category, and falls back to the category's main MCAT", () => {
    const data = kb();
    data.categories[0].product_ids.push("6");
    data.products.push({ ...data.products[0], product_id: "6", product_url: "https://seller.example/6.html", name: "H Frame Press 50 Ton", taxonomy: { category_name: "", glmcat_ids: ",999,", glcat_ids: "" }, specifications: [{ name: "Capacity", value: "50 Ton" }, { name: "Frame Type", value: "H Frame" }] });
    const m = parseMcatSpecs([
      { mcat_id: 25058, mcat_name: "CNC Press Brake", specifications: [{ name: "Capacity", options: ["100 Ton", "200 Ton"] }] },
      { mcat_id: 999, mcat_name: "H Frame Hydraulic Press", specifications: [{ name: "Frame Type", options: ["C Frame", "H Frame"] }, { name: "Capacity", options: ["50 Ton", "100 Ton"] }] },
    ]);
    if (!m.ok) throw new Error("parse");
    const v = new KbView(data, { mcats: m.value });
    const c = v.kb.categories[0];
    expect(v.mcatsOf(c).map((x) => [x.id, x.products])).toEqual([["25058", 2], ["999", 1]]);
    expect(v.isqPlan(c).mcat).toBe("CNC Press Brake");
    expect(v.isqPlan(c, "999")).toMatchObject({ mcat: "H Frame Hydraulic Press", isqs: [{ question: "Frame Type", options: ["H Frame", "C Frame"] }, { question: "Capacity", options: ["50 Ton", "100 Ton"] }] });
    expect(v.isqPlan(c, "777").mcat).toBe("CNC Press Brake");
    // A product MCAT with nothing to ask falls back to the category's main MCAT rather than asking nothing.
    data.products.push({ ...data.products[0], product_id: "7", product_url: "https://seller.example/7.html", name: "Odd Press", taxonomy: { category_name: "", glmcat_ids: ",555,", glcat_ids: "" }, specifications: [] });
    data.categories[0].product_ids.push("7");
    expect(new KbView(data, { mcats: m.value }).isqPlan(data.categories[0], "555").mcat).toBe("CNC Press Brake");
    expect(v.locateEntry({ kind: "product", slug: "6" })).toEqual({ category: "CNC PRESS BRAKE", mcatId: "999" });
    expect(v.systemText()).toContain("Also in this category: H Frame Hydraulic Press (1 product)");
  });

  it("matches spec names loosely but not wildly", () => {
    expect(specNamesMatch("Size/Diameter", "Diameter")).toBe(true);
    expect(specNamesMatch("Thickness (Gauge)", "Gauge")).toBe(true);
    expect(specNamesMatch("No. of Compartments", "Number of Compartments")).toBe(true);
    expect(specNamesMatch("Cutting Thickness", "Cutting Length")).toBe(false);
    expect(specNamesMatch("Colour", "Color")).toBe(false);
  });
});

describe("the chat's machine, picked by the server", () => {
  const m = parseMcatSpecs([
    { mcat_id: 25058, mcat_name: "CNC Press Brake", specifications: [{ name: "Capacity", options: ["100 Ton", "200 Ton", "500 Ton"] }, { name: "Control Axis", options: ["4 AXIS", "5 AXIS"] }] },
  ]);
  if (!m.ok) throw new Error("parse");
  const v = new KbView(kb(), { mcats: m.value });
  const entries = v.catalogueEntries();
  const entry = (title: string) => entries.find((e) => e.title === title)!;
  const src: IsqSource = {
    plan: (name, mcatId) => {
      const c = v.categoryNamed(name);
      return c ? v.isqPlan(c, mcatId) : null;
    },
    locate: (e: CatalogueEntry) => v.locateEntry(e),
    locateText: () => null,
  };
  const lead = (): LeadState => ({ stage: "captured", otpAttempts: 0, otpSends: 1 });

  it("takes the page the buyer is on, then the machine they name, with its MCAT", () => {
    const l = lead();
    expect(updateCategory(l, src, { buyerText: "hi", page: entry("NC Shear 12 mm"), hits: [], ownHits: false })).toBe(true);
    expect(l).toMatchObject({ category: "Shearing Machine", mcatId: "185336" });
    expect(updateCategory(l, src, { buyerText: "I need a CNC press brake", hits: [entry("CNC Press Brake 200 Ton")], ownHits: true })).toBe(true);
    expect(l).toMatchObject({ category: "CNC PRESS BRAKE", mcatId: "25058" });
  });

  it("doesn't switch on an answer, a tapped option or a fallback search", () => {
    const l = { ...lead(), category: "Shearing Machine", mcatId: "185336", lastOptions: ["100 Ton", "200 Ton"] };
    expect(updateCategory(l, src, { buyerText: "6 mm", hits: [entry("CNC Press Brake 100 Ton")], ownHits: true })).toBe(false);
    expect(updateCategory(l, src, { buyerText: "100 Ton", hits: [entry("CNC Press Brake 100 Ton")], ownHits: true })).toBe(false);
    expect(updateCategory(l, src, { buyerText: "cnc press brake", hits: [entry("CNC Press Brake 100 Ton")], ownHits: false })).toBe(false);
    expect(l.category).toBe("Shearing Machine");
  });

  it("never reads a greeting or a vague message as a product, even before one is known", () => {
    const l = lead();
    // The search is prefix and fuzzy, so "hi" can return a Hing product and "price?" anything at all.
    for (const text of ["hi", "Hello", "hii", "price?", "I want to buy"]) {
      expect(updateCategory(l, src, { buyerText: text, hits: [entry("CNC Press Brake 200 Ton")], ownHits: true })).toBe(false);
    }
    expect(l.category).toBeUndefined();
    expect(updateCategory(l, src, { buyerText: "press brake chahiye", hits: [entry("CNC Press Brake 200 Ton")], ownHits: true })).toBe(true);
    expect(l.category).toBe("CNC PRESS BRAKE");
  });

  it("tracks asked ISQs and keeps them while the questions stay the same", () => {
    const l = { ...lead(), category: "CNC PRESS BRAKE", mcatId: "25058" };
    const plan = src.plan("CNC PRESS BRAKE", "25058")!;
    markAsked(l, plan, ["100 Ton", "200 Ton", "500 Ton"]);
    expect(l.askedIsqs).toEqual(["Capacity"]);
    const text = specQuestionsText(plan, l.askedIsqs);
    expect(text).toContain("Product: CNC PRESS BRAKE · CNC Press Brake.");
    expect(text).toContain("1. Capacity? Options: 100 Ton / 200 Ton / 500 Ton");
    expect(text).toContain("Already asked: Capacity.");
    expect(text).toContain("Next: Control Axis.");
    // The same MCAT in another category asks the same questions, so what was asked is kept.
    updateCategory(l, src, { buyerText: "the tandem cnc press brake", hits: [entry("Tandem CNC Press Brake")], ownHits: true });
    expect(l).toMatchObject({ category: "Cnc Press Brake Machine", mcatId: "25058", askedIsqs: ["Capacity"] });
    markAnswered(l, plan, ["control axis"]);
    expect(specQuestionsText(plan, l.askedIsqs)).toContain("All asked");
    // Another machine: its own questions from the start.
    updateCategory(l, src, { buyerText: "nc shear machine 12 mm", hits: [entry("NC Shear 12 mm")], ownHits: true });
    expect(l).toMatchObject({ category: "Shearing Machine", mcatId: "185336", askedIsqs: [] });
  });
});
