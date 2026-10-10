import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SellerRegistry, validateSellerDir } from "../src/sellers.js";

const FIXTURES = path.join(__dirname, "fixtures", "sellers");
const REAL = path.join(__dirname, "..", "kb", "sellers");
const noData = () => fs.mkdtempSync(path.join(os.tmpdir(), "sellers-data-"));

function copyFixture(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sellers-"));
  fs.cpSync(path.join(FIXTURES, name), path.join(root, name), { recursive: true });
  return path.join(root, name);
}

describe("SellerRegistry", () => {
  const reg = SellerRegistry.load(FIXTURES, noData());

  it("loads every seller folder, sorted by name", () => {
    expect(reg.list().map((s) => s.config.slug)).toEqual(["alpha-presses", "beta-pumps"]);
    expect(reg.get("alpha-presses")!.catalogue.size).toBe(2);
    expect(reg.get("nope")).toBeUndefined();
  });

  it("gives each seller a system prompt with only their own business card", () => {
    const a = reg.get("alpha-presses")!.systemPrompt;
    const b = reg.get("beta-pumps")!.systemPrompt;
    expect(a).toContain("Alpha Presses Pvt Ltd");
    expect(a).not.toContain("Beta Pumps");
    expect(b).toContain("Beta Pumps & Motors");
    expect(b).not.toContain("Alpha Presses");
  });

  it("uses the shared guardrails unless the seller overrides them", () => {
    expect(reg.get("alpha-presses")!.systemPrompt).toContain("1. Price");
    const beta = reg.get("beta-pumps")!.systemPrompt;
    expect(beta).toContain("BETA-ONLY GUARDRAIL");
    expect(beta).not.toContain("2. Freight");
  });

  it("keeps catalogue search within the seller", () => {
    expect(reg.get("alpha-presses")!.catalogue.search("pump")).toEqual([]);
    expect(reg.get("beta-pumps")!.catalogue.search("pump")[0].title).toBe("Openwell Submersible Pump");
  });

  it("allows links to the seller's own site and their listed phone only", () => {
    const kb = reg.get("alpha-presses")!.kb;
    expect(kb.allowedDomains).toEqual(["alphapresses.example"]);
    expect(kb.allowedPhones).toEqual(["9000000001"]);
  });

  it("prefers the runtime catalogue on the data disk over the bundled one", () => {
    const data = noData();
    fs.mkdirSync(path.join(data, "beta-pumps"), { recursive: true });
    fs.writeFileSync(path.join(data, "beta-pumps", "catalogue.json"), JSON.stringify([{ url: "https://betapumps.example/product/new.html", kind: "product", title: "New Pump" }]));
    const r = SellerRegistry.load(FIXTURES, data);
    expect(r.get("beta-pumps")!.catalogue.list().map((e) => e.title)).toEqual(["New Pump"]);
    // Entries written by an older crawler get the new fields filled in.
    expect(r.get("beta-pumps")!.catalogue.list()[0]).toMatchObject({ slug: "new", image: null, products: [], breadcrumbs: [] });
  });

  it("loads the real Jayshree folder", () => {
    const r = SellerRegistry.load(REAL, noData());
    expect(r.get("jayshree-machinetools")!.kb.productCards).toHaveLength(4);
    expect(r.get("jayshree-machinetools")!.systemPrompt).toContain("9. Products Outside The Product Cards");
  });
});

describe("validateSellerDir", () => {
  it("accepts the fixtures", () => {
    expect(validateSellerDir(path.join(FIXTURES, "alpha-presses"))).toEqual([]);
  });

  it("names the file and field for each problem", () => {
    const dir = copyFixture("alpha-presses");
    fs.writeFileSync(path.join(dir, "seller.json"), JSON.stringify({ name: "X", slug: "Other Slug", siteUrl: "not-a-url", color: "red" }));
    fs.writeFileSync(path.join(dir, "product_cards.json"), "{ not json");
    fs.rmSync(path.join(dir, "business_card.json"));
    const problems = validateSellerDir(dir).join("\n");
    expect(problems).toMatch(/seller\.json: slug/);
    expect(problems).toMatch(/seller\.json: siteUrl/);
    expect(problems).toMatch(/seller\.json: color/);
    expect(problems).toMatch(/product_cards\.json: not valid JSON/);
    expect(problems).toMatch(/business_card\.json: missing/);
  });

  it("requires the slug to match the folder name", () => {
    const dir = copyFixture("alpha-presses");
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "seller.json"), "utf8"));
    fs.writeFileSync(path.join(dir, "seller.json"), JSON.stringify({ ...cfg, slug: "alpha-other" }));
    expect(validateSellerDir(dir).join()).toMatch(/must match the folder name/);
  });

  it("refuses to start when any seller is invalid", () => {
    const dir = copyFixture("alpha-presses");
    fs.writeFileSync(path.join(dir, "sitemap.xml"), "<urlset></urlset>");
    expect(() => SellerRegistry.load(path.dirname(dir), noData())).toThrow(/no <loc> URLs/);
  });
});
