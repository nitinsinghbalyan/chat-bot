import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Catalogue, formatCatalogueHits } from "../src/catalogue.js";
import { cleanText, KbView, PROMPT_BUDGET, SELLER_KB_TEMPLATE, validateSellerKb } from "../src/sellerKb.js";
import { SellerRegistry } from "../src/sellers.js";
import { shareMedia } from "../src/shareMedia.js";

const raw = () => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "kb", "alpha-kb.json"), "utf8"));
const FIXTURE_SELLERS = path.join(__dirname, "fixtures", "sellers");

function loaded() {
  const r = validateSellerKb(raw());
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r;
}

describe("validateSellerKb", () => {
  it("accepts the export format and the downloadable template", () => {
    const r = loaded();
    expect(r.summary).toMatchObject({ company: "Alpha Presses Pvt Ltd", products: 2, categories: 1 });
    expect(validateSellerKb(SELLER_KB_TEMPLATE).ok).toBe(true);
  });

  it("refuses only unusable files, naming the field", () => {
    const noName = raw();
    delete noName.seller.company_name;
    const r = validateSellerKb(noName);
    expect(!r.ok && r.errors).toContain("seller.company_name: Invalid input: expected string, received undefined");
    expect(validateSellerKb({ seller: { company_name: "X Ltd" }, products: [] }).ok).toBe(false);
    const allBad = raw();
    allBad.products.forEach((p: any) => { p.name = ""; p.display_name = ""; });
    const b = validateSellerKb(allBad);
    expect(!b.ok && b.errors[0]).toBe("products: no usable products (each needs a name)");
  });

  it("repairs blank ids and names and skips duplicates instead of rejecting the file", () => {
    const messy = raw();
    messy.categories[0].category_id = ""; // the production failure: categories[45].category_id was ""
    messy.categories.push({ category_id: null, name: "", url: "", product_ids: [] });
    messy.products[1].product_id = "";
    messy.products.push({ ...messy.products[0], name: "", display_name: "Copy of CNC" }); // duplicate id 501
    messy.products.push({ product_id: 900, name: "", display_name: "" });
    const r = validateSellerKb(messy);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        "categories[0].category_id (Press Brakes): empty; generated one",
        "categories[1]: no name, skipped",
        "products[1].product_id (NC Press Brake): empty; generated one",
        "products[2].product_id (Copy of CNC): 501 is used by an earlier product; skipped this one",
        "products[3]: no name or display_name, skipped",
      ]),
    );
    expect(r.summary).toMatchObject({ products: 2, categories: 1 });
    // The repaired category still lists both products: one via product_ids, the other via its taxonomy name.
    const view = new KbView(r.kb);
    expect(view.productsIn(r.kb.categories[0]).map((p) => p.name)).toEqual(["CNC Press Brake", "NC Press Brake"]);
  });
});

/** An export far over the prompt budget: 4,000 products with long descriptions in 40 categories. */
function hugeKb(products = 4000) {
  const kb = raw();
  kb.categories = Array.from({ length: 40 }, (_, c) => ({ category_id: 100 + c, name: `Machine Family ${c}`, url: `https://www.alphapresses.example/family-${c}.html`, product_ids: [] }));
  kb.products = Array.from({ length: products }, (_, i) => ({
    product_id: 10_000 + i,
    product_url: `https://www.alphapresses.example/product/machine-model-${i}.html`,
    name: `Machine Model ${i}`,
    category_id: 100 + (i % 40),
    description: `Machine Model ${i} is a heavy duty unit built for ${i % 2 ? "steel" : "aluminium"} work. `.repeat(12),
    specifications: [
      { name: "Capacity", value: `${(i % 9) + 1}0 Ton` },
      { name: "Bed Length", value: `${(i % 4) + 2} m` },
    ],
  }));
  return kb;
}

describe("large catalogues", () => {
  it("imports an export over the prompt budget with an index instead of refusing it", () => {
    const r = validateSellerKb(hugeKb());
    if (!r.ok) throw new Error(r.errors.join("\n"));
    expect(r.summary.products).toBe(4000);
    expect(r.warnings[0]).toMatch(/^Large catalogue \(4000 products/);
    const view = new KbView(r.kb);
    const plan = view.promptPlan();
    expect(plan.mode).not.toBe("full");
    expect(plan.fullChars).toBeGreaterThan(PROMPT_BUDGET);
    const text = view.systemText();
    expect(text.length).toBeLessThanOrEqual(PROMPT_BUDGET);
    expect(text).toContain("full details");
    expect(text).toContain("### Machine Family 39");
    expect(text).toMatch(/1\. Capacity\? Options: /);
    expect(text).not.toContain("heavy duty unit");
  });

  it("lists every product when the index fits", () => {
    const r = validateSellerKb(hugeKb(1200));
    if (!r.ok) throw new Error(r.errors.join("\n"));
    const view = new KbView(r.kb);
    expect(view.promptPlan().mode).toBe("index");
    expect(view.systemText()).toContain("Machine Model 1199 (machine-model-1199)");
  });

  it("finds a product's details per message through the catalogue search", () => {
    const r = validateSellerKb(hugeKb());
    if (!r.ok) throw new Error(r.errors.join("\n"));
    const cat = new Catalogue(new KbView(r.kb).catalogueEntries());
    const hits = cat.search("Machine Model 3721");
    expect(hits[0]?.slug).toBe("machine-model-3721");
    const text = formatCatalogueHits(hits.slice(0, 1));
    expect(text).toContain("ID: machine-model-3721");
    expect(text).toContain("Capacity: 50 Ton");
    expect(text).toContain("Description: Machine Model 3721 is a heavy duty unit");
    expect(text.match(/heavy duty unit/g)?.length).toBe(12);
    expect(text).not.toContain("Details:");
  });

  it("keeps a normal export in full", () => {
    expect(new KbView(loaded().kb).promptPlan().mode).toBe("full");
  });
});

describe("what the bot is told", () => {
  const view = new KbView(loaded().kb);
  const text = view.systemText();

  it("keeps company facts, products, specs and media counts", () => {
    expect(text).toContain("Company CEO: A. Sharma");
    expect(text).toContain("Location: Rajkot, Gujarat, India (address: Plot 12 GIDC, Metoda, 360021)");
    expect(text).toContain("Our machines are built in our own Rajkot factory.");
    expect(text).toContain("## CNC Press Brake 100 Ton\nProduct id: cnc-press-brake-a1b2c3d");
    expect(text).toContain("Specifications: Control Type: CNC; Capacity: 100 Ton; Country of Origin: Made in India");
    expect(text).toContain("Media: 2 photos, 2 videos, 1 brochure");
    expect(text).toContain("+0.03 mm accuracy");
  });

  it("never passes on prices, delivery, payment, GST, tenure, turnover, staff, banks or other numbers", () => {
    expect(text).not.toMatch(/4,50,000|450000|1 MONTH|Cash|GST|1995|employees|turnover|forty percent|HDFC|9876543210|Delivery within/i);
    expect(text).not.toContain("Profile");
  });

  it("derives ISQs with options from the category's specifications", () => {
    const isqs = view.isqs(loaded().kb.categories[0]);
    expect(isqs).toEqual([
      { question: "Control Type", options: ["CNC", "NC"] },
      { question: "Capacity", options: ["100 Ton", "60 Ton"] },
    ]);
    expect(text).toContain("1. Control Type? Options: CNC / NC");
  });

  it("drops forbidden sentences but keeps decimals intact", () => {
    expect(cleanText("Accuracy is 0.03 mm. Operating since 1995. Freight is extra.")).toBe("Accuracy is 0.03 mm.");
  });
});

describe("registry and share_media", () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "kb-data-"));
  const reg = SellerRegistry.load(FIXTURE_SELLERS, data);
  reg.setUploadedKb("alpha-presses", loaded().kb);
  const alpha = reg.get("alpha-presses")!;

  it("makes the upload the bot's knowledge and keeps the site's contact", () => {
    expect(alpha.systemPrompt).toContain("Product id: cnc-press-brake-a1b2c3d");
    expect(alpha.kb.businessCard.listed_contact).toBe("+91-9000000001");
    expect(alpha.kb.allowedPhones).toEqual(["919000000001"]);
    reg.setUploadedKb("alpha-presses", null);
    expect(alpha.systemPrompt).not.toContain("Product id: cnc-press-brake-a1b2c3d");
    reg.setUploadedKb("alpha-presses", loaded().kb);
  });

  it("builds photo, video, PDF and related-product cards from the KB", () => {
    const r = shareMedia(alpha, ["cnc-press-brake-a1b2c3d"], ["image", "video", "document"], true);
    expect(r.isError).toBe(false);
    expect(r.cards.map((c) => c.type)).toEqual(["image", "image", "video", "video", "document", "product"]);
    expect(r.cards[2]).toMatchObject({ url: "https://www.youtube.com/watch?v=PRODVID0001", thumb: "https://i.ytimg.com/vi/PRODVID0001/hqdefault.jpg" });
    expect(r.cards[3]).toMatchObject({ url: "https://www.youtube.com/watch?v=TAGGEDVID01", embed: "https://www.youtube-nocookie.com/embed/TAGGEDVID01?autoplay=1" });
    expect(r.cards[5]).toMatchObject({ type: "product", title: "NC Press Brake" });
    expect(r.content).toContain("shared 2 photos, 2 videos, 1 brochure, 1 related product");
  });

  it("links product cards to this site when the buyer is on it, and reports what is missing", () => {
    const r = shareMedia(alpha, ["cnc-press-brake-a1b2c3d", "nc-press-brake-z9y8x7w"], ["product", "video"], false, { siteOrigin: "https://bots.example" });
    expect(r.cards[0]).toMatchObject({ type: "product", url: "https://bots.example/s/alpha-presses/p/cnc-press-brake-a1b2c3d" });
    expect(r.content).toContain("NC Press Brake: shared its product card. Not available: videos.");
  });

  it("shares company media and rejects unknown ids", () => {
    const r = shareMedia(alpha, ["company"], ["image", "video", "document"], false);
    expect(r.cards.map((c) => c.title)).toEqual(["Factory", "Corporate video", "Company brochure (PDF)"]);
    const bad = shareMedia(alpha, ["no-such-thing"], ["image"], false);
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("Unknown id: no-such-thing");
  });
});

describe("admin-added sellers and the website catalogue", () => {
  it("reloads an admin-added seller from the data folder after a restart", () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "kb-admin-"));
    const dir = path.join(data, "gamma-machines");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "seller.json"), JSON.stringify({ name: "Gamma Machines", slug: "gamma-machines", siteUrl: "https://www.gamma.example/" }));
    fs.writeFileSync(path.join(dir, "seller_kb.json"), JSON.stringify(raw()));
    const reg = SellerRegistry.load(FIXTURE_SELLERS, data);
    const g = reg.get("gamma-machines")!;
    expect(g.source).toBe("admin");
    expect(g.catalogue.get("product", "cnc-press-brake-a1b2c3d")?.price_text).toBe("₹ 4,50,000/Piece");
    expect(g.systemPrompt).toContain("Product id: nc-press-brake-z9y8x7w");
    expect(reg.crawlUrls(g)).toContain("https://www.alphapresses.example/product/cnc-press-brake-a1b2c3d.html");
    // Repo sellers are still there, and a broken admin folder is skipped rather than failing startup.
    fs.mkdirSync(path.join(data, "broken"));
    fs.writeFileSync(path.join(data, "broken", "seller.json"), "{");
    expect(SellerRegistry.load(FIXTURE_SELLERS, data).list().map((s) => s.config.slug)).toEqual(["alpha-presses", "beta-pumps", "gamma-machines"]);
  });

  it("builds the website from the JSON first and fills gaps from the crawl", () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "kb-merge-"));
    const reg = SellerRegistry.load(FIXTURE_SELLERS, data);
    const alpha = reg.get("alpha-presses")!;
    // Without a JSON: only the committed crawl (1 category, 1 product).
    expect(alpha.catalogue.list("product").map((p) => p.slug)).toEqual(["cnc-press-brake-a1b2c3d"]);
    reg.setUploadedKb("alpha-presses", loaded().kb);
    const products = alpha.catalogue.list("product");
    expect(products.map((p) => p.slug).sort()).toEqual(["cnc-press-brake-a1b2c3d", "nc-press-brake-z9y8x7w"]);
    const cnc = alpha.catalogue.get("product", "cnc-press-brake-a1b2c3d")!;
    expect(cnc.title).toBe("CNC Press Brake 100 Ton"); // from the JSON
    expect(cnc.images).toContain("https://img.alphapresses.example/cnc-side.jpg");
    expect(alpha.catalogue.categoryOf(cnc)?.title).toBe("Press Brakes");
    // A crawled page the JSON doesn't have is kept.
    reg.setCrawled("alpha-presses", [...alpha.crawled, { ...alpha.crawled[1], url: "https://www.alphapresses.example/product/extra-q1q1q1q.html", slug: "extra-q1q1q1q", title: "Extra Machine" }]);
    expect(alpha.catalogue.get("product", "extra-q1q1q1q")?.title).toBe("Extra Machine");
    reg.setUploadedKb("alpha-presses", null);
    expect(alpha.catalogue.get("product", "nc-press-brake-z9y8x7w")).toBeNull();
  });
});
