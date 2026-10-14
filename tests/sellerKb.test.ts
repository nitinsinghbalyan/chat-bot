import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanText, KbView, SELLER_KB_TEMPLATE, validateSellerKb } from "../src/sellerKb.js";
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

  it("names the field of each problem", () => {
    const bad = raw();
    bad.products[1].name = "";
    delete bad.seller.company_name;
    const r = validateSellerKb(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain("seller.company_name: Invalid input: expected string, received undefined");
      expect(r.errors.some((e) => e.startsWith("products[1].name:"))).toBe(true);
    }
    const dup = raw();
    dup.products[1].product_id = 501;
    const d = validateSellerKb(dup);
    expect(!d.ok && d.errors[0]).toBe("products[1].product_id: 501 is also used by products[0]");
    expect(validateSellerKb({ products: [] }).ok).toBe(false);
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
