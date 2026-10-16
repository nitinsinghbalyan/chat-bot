import { describe, expect, it } from "vitest";
import type { CatalogueEntry } from "../src/crawler.js";
import { markAnswered, markAsked, specQuestionsText, updateCategory, type IsqSource } from "../src/isqTracker.js";
import { deriveIsqs, KbView, type SellerKb } from "../src/sellerKb.js";
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

describe("ISQs per category", () => {
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

  it("pools categories of one MCAT family, so they ask the same questions", () => {
    const v = new KbView(kb());
    const [a, b, shears] = v.kb.categories;
    expect(v.mcatIdOf(a)).toBe("25058");
    expect(v.family(a).map((c) => c.name)).toEqual(["CNC PRESS BRAKE", "Cnc Press Brake Machine"]);
    expect(v.isqPlan(a).isqs).toEqual(v.isqPlan(b).isqs);
    expect(v.isqPlan(a)).toMatchObject({ source: "derived", label: "CNC PRESS BRAKE (with Cnc Press Brake Machine)" });
    expect(v.isqPlan(a).isqs[0]).toEqual({ question: "Capacity", options: ["100 Ton", "200 Ton", "500 Ton"] });
    expect(v.isqPlan(shears).isqs.map((q) => q.question)).toEqual(["Shearing Thickness", "Automation Grade"]);
  });

  it("uses the MCAT file's specs by MCAT id, else an equal name, never a containing one", () => {
    const m = parseMcatSpecs([
      { mcat_id: 25058, mcat_name: "CNC Press Brake", specifications: [{ name: "Bending Length", options: ["2500 mm", "3200 mm"] }] },
      { mcat_id: 1, mcat_name: "Shearing Machines", specifications: [{ name: "Blade Length", options: ["8 ft", "10 ft"] }] },
      { mcat_id: 2, mcat_name: "Machine", specifications: [{ name: "Colour", options: ["Red", "Blue"] }] },
    ]);
    if (!m.ok) throw new Error("parse");
    const v = new KbView(kb(), { mcats: m.value });
    const [a, b, shears] = v.kb.categories;
    expect(v.isqPlan(a)).toMatchObject({ source: "mcat", mcat: "CNC Press Brake", isqs: [{ question: "Bending Length", options: ["2500 mm", "3200 mm"] }] });
    expect(v.isqPlan(b).mcat).toBe("CNC Press Brake");
    // No id match for the shears (185336), but "Shearing Machines" equals "Shearing Machine".
    expect(v.isqPlan(shears)).toMatchObject({ source: "mcat", mcat: "Shearing Machines" });
    expect(v.systemText()).toContain("ISQs (from MCAT CNC Press Brake)");
  });
});

describe("the chat's category, picked by the server", () => {
  const v = new KbView(kb());
  const entries = v.catalogueEntries();
  const entry = (title: string) => entries.find((e) => e.title === title)!;
  const src: IsqSource = {
    plan: (name) => {
      const c = v.categoryNamed(name);
      return c ? v.isqPlan(c) : null;
    },
    categoryOfEntry: (e: CatalogueEntry) => v.categoryOfEntry(e)?.name ?? null,
    categoryForText: () => null,
  };
  const lead = (): LeadState => ({ stage: "captured", otpAttempts: 0, otpSends: 1 });

  it("takes the page the buyer is on, then the machine they name", () => {
    const l = lead();
    expect(updateCategory(l, src, { buyerText: "hi", page: entry("NC Shear 12 mm"), hits: [], ownHits: false })).toBe(true);
    expect(l.category).toBe("Shearing Machine");
    expect(updateCategory(l, src, { buyerText: "I need a CNC press brake", hits: [entry("CNC Press Brake 200 Ton")], ownHits: true })).toBe(true);
    expect(l.category).toBe("CNC PRESS BRAKE");
  });

  it("doesn't switch on an answer, a tapped option or a fallback search", () => {
    const l = { ...lead(), category: "Shearing Machine", lastOptions: ["100 Ton", "200 Ton"] };
    expect(updateCategory(l, src, { buyerText: "6 mm", hits: [entry("CNC Press Brake 100 Ton")], ownHits: true })).toBe(false);
    expect(updateCategory(l, src, { buyerText: "100 Ton", hits: [entry("CNC Press Brake 100 Ton")], ownHits: true })).toBe(false);
    expect(updateCategory(l, src, { buyerText: "cnc press brake", hits: [entry("CNC Press Brake 100 Ton")], ownHits: false })).toBe(false);
    expect(l.category).toBe("Shearing Machine");
  });

  it("tracks asked ISQs and keeps them within one MCAT family", () => {
    const l = { ...lead(), category: "CNC PRESS BRAKE" };
    const plan = src.plan("CNC PRESS BRAKE")!;
    markAsked(l, plan, ["100 Ton", "200 Ton", "500 Ton"]);
    expect(l.askedIsqs).toEqual(["Capacity"]);
    const text = specQuestionsText(plan, l.askedIsqs);
    expect(text).toContain("Machine category: CNC PRESS BRAKE (with Cnc Press Brake Machine).");
    expect(text).toContain("1. Capacity? Options: 100 Ton / 200 Ton / 500 Ton");
    expect(text).toContain("Already asked: Capacity.");
    expect(text).toContain("Next: Control Axis.");
    // Same family: same questions, so what was asked is kept.
    updateCategory(l, src, { buyerText: "the tandem cnc press brake", hits: [entry("Tandem CNC Press Brake")], ownHits: true });
    expect(l).toMatchObject({ category: "Cnc Press Brake Machine", askedIsqs: ["Capacity"] });
    markAnswered(l, plan, ["control axis"]);
    expect(specQuestionsText(plan, l.askedIsqs)).toContain("All asked");
    // Another machine: its own questions from the start.
    updateCategory(l, src, { buyerText: "nc shear machine 12 mm", hits: [entry("NC Shear 12 mm")], ownHits: true });
    expect(l).toMatchObject({ category: "Shearing Machine", askedIsqs: [] });
  });
});
