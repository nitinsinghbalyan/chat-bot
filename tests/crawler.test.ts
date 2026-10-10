import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { crawl, extractPage, parseSitemap, shouldCrawl, slugFromUrl, titleFromSlug } from "../src/crawler.js";

const fx = (name: string) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const BASE = "https://www.jayshreemachinetools.in";

describe("sitemap", () => {
  it("parses <loc> entries", () => {
    const urls = parseSitemap(fx("sitemap.xml"));
    expect(urls).toHaveLength(6);
    expect(urls[0]).toBe(`${BASE}/`);
  });

  it("skips business-profile pages (Guardrail 7) and the home page", () => {
    expect(shouldCrawl(`${BASE}/`)).toBe(false);
    expect(shouldCrawl(`${BASE}/profile.html`)).toBe(false);
    expect(shouldCrawl(`${BASE}/testimonial.html`)).toBe(false);
    expect(shouldCrawl(`${BASE}/registration-directors-info.html`)).toBe(false);
    expect(shouldCrawl(`${BASE}/cnc-press-brake.html`)).toBe(true);
    expect(shouldCrawl(`${BASE}/product/cnc-press-brake-c8tj6re.html`)).toBe(true);
  });

  it("keeps the real sitemap's product and category pages", () => {
    const urls = parseSitemap(fs.readFileSync(path.join(__dirname, "..", "kb", "sellers", "jayshree-machinetools", "sitemap.xml"), "utf8"));
    expect(urls.length).toBe(179);
    expect(urls.filter(shouldCrawl).length).toBe(174);
  });
});

describe("extractPage", () => {
  it("extracts title, price, specs and category from a product page", () => {
    const e = extractPage(fx("product.html"), `${BASE}/product/cnc-press-brake-c8tj6re.html`);
    expect(e.kind).toBe("product");
    expect(e.title).toBe("CNC Press Brake Machine");
    expect(e.category).toBe("CNC Press Brakes");
    expect(e.price_text).toBe("₹4,50,000");
    expect(e.specs).toEqual({ "Pressing Force": "100 ton", "Working Length": "3125 mm", "Control Type": "CNC Controller" });
    expect(e.description).toContain("sheet bending");
    expect(e.slug).toBe("cnc-press-brake-c8tj6re");
    expect(e.image).toBe("https://cdn.example/cnc-press-brake.jpg");
    expect(e.breadcrumbs).toEqual([{ title: "CNC Press Brake", url: `${BASE}/cnc-press-brake.html` }]);
    expect(e.products).toEqual([]);
  });

  it("drops spec rows the guardrails forbid (GST, delivery, payment, freight)", () => {
    const e = extractPage(fx("product.html"), `${BASE}/product/x.html`);
    expect(Object.keys(e.specs).join(" ")).not.toMatch(/gst|delivery|payment/i);
    const n = extractPage(fx("product_noprice.html"), `${BASE}/product/y.html`);
    expect(n.specs).toEqual({ "Max Sheet Thickness": "8 mm" });
  });

  it("leaves price empty when the page only says 'Get Latest Price'", () => {
    const e = extractPage(fx("product_noprice.html"), `${BASE}/product/y.html`);
    expect(e.price_text).toBeNull();
    expect(e.title).toBe("NC Hydraulic Shearing Machine");
  });

  it("never attributes a price to a category page, and collects its product links", () => {
    const e = extractPage(fx("category.html"), `${BASE}/fiber-laser-cutting-machine.html`);
    expect(e.kind).toBe("category");
    expect(e.price_text).toBeNull();
    expect(e.products).toEqual([
      // The image alt text titles the first link; the second only says "View", so its title comes from the URL.
      { url: `${BASE}/product/fiber-laser-cutting-machine-abc.html`, title: "Fiber Laser 1.5 kW" },
      { url: `${BASE}/product/fiber-laser-3kw-def.html`, title: "Fiber laser 3kw def" },
    ]);
    expect(e.image).toBe("https://cdn.example/laser-category.jpg");
    expect(e.slug).toBe("fiber-laser-cutting-machine");
  });
});

describe("slugs and titles", () => {
  it("derives a URL-safe slug from the page path", () => {
    expect(slugFromUrl(`${BASE}/product/cnc-press-brake-c8tj6re.html`)).toBe("cnc-press-brake-c8tj6re");
    expect(slugFromUrl(`${BASE}/Hydraulic_Press.HTML`)).toBe("hydraulic-press");
    expect(slugFromUrl("not a url")).toBe("");
  });

  it("drops only id-like suffixes when making a title from a slug", () => {
    expect(titleFromSlug("cnc-press-brake-machine-10f24dqbg")).toBe("Cnc press brake machine");
    expect(titleFromSlug("hydraulic-shearing-machine")).toBe("Hydraulic shearing machine");
  });

  it("skips logos when picking an image", () => {
    const e = extractPage('<html><body><img src="/logo.png"><img src="/p/main.jpg"></body></html>', `${BASE}/product/x.html`);
    expect(e.image).toBe(`${BASE}/p/main.jpg`);
  });
});

describe("crawl", () => {
  it("fetches crawlable pages, survives failures and sorts results", async () => {
    const pages: Record<string, string> = {
      [`${BASE}/fiber-laser-cutting-machine.html`]: fx("category.html"),
      [`${BASE}/product/cnc-press-brake-c8tj6re.html`]: fx("product.html"),
      [`${BASE}/product/nc-hydraulic-shearing-machine-x1.html`]: fx("product_noprice.html"),
    };
    const requested: string[] = [];
    const fakeFetch = (async (url: string) => {
      requested.push(url);
      const body = pages[url];
      return new Response(body ?? "not found", { status: body ? 200 : 404 });
    }) as unknown as typeof fetch;

    const entries = await crawl({ urls: parseSitemap(fx("sitemap.xml")), fetchImpl: fakeFetch, delayMs: 0, retryDelayMs: 0 });
    expect(entries.map((e) => e.url)).toEqual(Object.keys(pages).sort());
    expect(requested).not.toContain(`${BASE}/profile.html`);
    expect(requested.filter((u) => u.endsWith("missing-page.html"))).toHaveLength(1); // 404 is not retried
  });
});

describe("crawl when the site is unreachable", () => {
  it("gives up after five straight failures", async () => {
    let calls = 0;
    const failingFetch = (async () => {
      calls++;
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const urls = Array.from({ length: 50 }, (_, i) => `${BASE}/product/p${i}.html`);
    const entries = await crawl({ urls, fetchImpl: failingFetch, delayMs: 0, retryDelayMs: 0, concurrency: 1 });
    expect(entries).toEqual([]);
    expect(calls).toBe(5 * 3); // 5 pages x 3 attempts
  });
});
