import { describe, expect, it } from "vitest";
import { Catalogue, formatCatalogueHits } from "../src/catalogue.js";
import type { CatalogueEntry } from "../src/crawler.js";

const entry = (over: Partial<CatalogueEntry>): CatalogueEntry => ({
  url: "https://www.jayshreemachinetools.in/x.html",
  kind: "product",
  title: "",
  category: "",
  price_text: null,
  specs: {},
  description: "",
  related_links: [],
  ...over,
});

const cat = new Catalogue([
  entry({ url: "https://www.jayshreemachinetools.in/product/cnc-press-brake.html", title: "CNC Press Brake Machine", category: "CNC Press Brakes", price_text: "₹4,50,000", specs: { "Pressing Force": "100 ton" } }),
  entry({ url: "https://www.jayshreemachinetools.in/product/nc-shear.html", title: "NC Hydraulic Shearing Machine", category: "Hydraulic Shearing Machine", specs: { "Max Sheet Thickness": "8 mm" } }),
  entry({ url: "https://www.jayshreemachinetools.in/product/fiber-laser.html", title: "Fiber Laser Cutting Machine", category: "Fiber Laser Cutting Machine", description: "1.5 kW fiber laser" }),
]);

describe("Catalogue", () => {
  it("finds the best match first", () => {
    expect(cat.search("press brake price")[0].title).toBe("CNC Press Brake Machine");
    expect(cat.search("shearing machine 8mm")[0].title).toBe("NC Hydraulic Shearing Machine");
    expect(cat.search("laser cutter")[0].title).toBe("Fiber Laser Cutting Machine");
  });

  it("tolerates small typos", () => {
    expect(cat.search("sheering mashine")[0]?.title).toBe("NC Hydraulic Shearing Machine");
  });

  it("returns nothing for unrelated queries or an empty catalogue", () => {
    expect(cat.search("road roller")).toEqual([]);
    expect(new Catalogue().search("press brake")).toEqual([]);
  });

  it("formats hits for the prompt", () => {
    const text = formatCatalogueHits(cat.search("press brake"));
    expect(text).toContain("Listed starting price: ₹4,50,000");
    expect(text).toContain("Link: https://www.jayshreemachinetools.in/product/cnc-press-brake.html");
    expect(formatCatalogueHits([])).toBe("No matching catalogue entry.");
  });
});
