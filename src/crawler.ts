/**
 * Builds the SELLER CATALOGUE (RAG) by crawling the pages listed in kb/sitemap.xml.
 *
 * Run with `npm run crawl`. Needs outbound HTTPS access to the seller's site, so run it
 * where the bot is deployed (or anywhere with internet) and commit/ship kb/catalogue.json.
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import * as cheerio from "cheerio";
import { paths } from "./config.js";

export interface CatalogueEntry {
  url: string;
  kind: "product" | "category";
  title: string;
  category: string;
  price_text: string | null;
  specs: Record<string, string>;
  description: string;
  related_links: string[];
}

/** Pages that describe the business rather than products. Skipped because of Guardrail 7. */
const SKIP_PATHS = [/\/profile\.html$/, /\/testimonial\.html$/, /\/registration-directors-info\.html$/, /\/sitemap\.html$/, /\/$/];

/** Spec rows on topics the guardrails forbid the bot to state (G2, G5, G6, G7, G8). */
const FORBIDDEN_SPEC_KEYS =
  /gst|tax|freight|transport|shipping|delivery|dispatch|lead\s*time|payment|turnover|revenue|established|employees|staff|bank|upi|stock|availability/i;

const USER_AGENT = "SellerEnquiryBot-Crawler/0.1 (+catalogue refresh for on-site assistant)";

export function parseSitemap(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
}

export function shouldCrawl(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  return !SKIP_PATHS.some((re) => re.test(pathname));
}

const clean = (s: string | undefined | null): string => (s ?? "").replace(/\s+/g, " ").trim();

const PRICE_RE = /(?:₹|Rs\.?|INR)\s*[\d,]+(?:\.\d+)?\s*(?:Lakh|Lac|Crore|Cr|Thousand|K)?(?:\s*(?:\/|per)\s*[A-Za-z]+(?:\s[A-Za-z]+)?)?/i;

function extractPriceFromText(text: string): string | null {
  const m = text.match(PRICE_RE);
  return m ? clean(m[0]) : null;
}

function jsonLdProducts($: cheerio.CheerioAPI): Array<Record<string, any>> {
  const found: Array<Record<string, any>> = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      const items = Array.isArray(data) ? data : data["@graph"] ? data["@graph"] : [data];
      for (const item of items) if (item && item["@type"] === "Product") found.push(item);
    } catch {
      // ignore malformed JSON-LD
    }
  });
  return found;
}

function priceFromJsonLd(product: Record<string, any> | undefined): string | null {
  const offers = product?.offers;
  const offer = Array.isArray(offers) ? offers[0] : offers;
  const price = offer?.price ?? offer?.lowPrice;
  if (price === undefined || price === null || price === "") return null;
  const currency = offer?.priceCurrency === "INR" || !offer?.priceCurrency ? "₹" : `${offer.priceCurrency} `;
  return `${currency}${Number(price).toLocaleString("en-IN")}`;
}

export function extractPage(html: string, url: string): CatalogueEntry {
  const $ = cheerio.load(html);
  $("script:not([type='application/ld+json']), style, noscript, iframe, header nav, footer").remove();

  const ld = jsonLdProducts($)[0];
  const title = clean(ld?.name) || clean($("h1").first().text()) || clean($("title").text());
  const kind: CatalogueEntry["kind"] = /\/product\//.test(new URL(url).pathname) ? "product" : "category";

  const specs: Record<string, string> = {};
  const addSpec = (k: string, v: string) => {
    const key = clean(k).replace(/:$/, "");
    const value = clean(v);
    if (!key || !value || key.length > 60 || value.length > 200) return;
    if (FORBIDDEN_SPEC_KEYS.test(key)) return;
    if (!(key in specs)) specs[key] = value;
  };
  $("table tr").each((_, tr) => {
    const cells = $(tr).find("th, td");
    if (cells.length === 2) addSpec($(cells[0]).text(), $(cells[1]).text());
  });
  $("dl").each((_, dl) => {
    $(dl)
      .find("dt")
      .each((__, dt) => addSpec($(dt).text(), $(dt).next("dd").text()));
  });

  // Category pages list many machines, so a price there can't be attributed to one product.
  let priceText = kind === "product" ? priceFromJsonLd(ld) : null;
  if (!priceText && kind === "product") {
    const priceNode = $('[class*="price" i], [id*="price" i], [itemprop="price"]').first();
    priceText = extractPriceFromText(clean(priceNode.text()));
  }

  const description =
    clean(ld?.description) ||
    clean($('meta[name="description"]').attr("content")) ||
    clean($("p").first().text());

  const crumbs = $('[class*="breadcrumb" i] a, nav[aria-label="breadcrumb" i] a')
    .map((_, a) => clean($(a).text()))
    .get()
    .filter((t) => t && !/^home$/i.test(t));
  const category = clean(ld?.category) || crumbs[crumbs.length - 1] || (kind === "category" ? title : "");

  const host = new URL(url).hostname;
  const related = new Set<string>();
  $("a[href]").each((_, a) => {
    try {
      const href = new URL($(a).attr("href")!, url);
      if (href.hostname === host && /\/product\//.test(href.pathname) && href.href !== url) related.add(href.origin + href.pathname);
    } catch {
      // ignore bad href
    }
  });

  return {
    url,
    kind,
    title,
    category,
    price_text: priceText,
    specs,
    description: description.slice(0, 600),
    related_links: kind === "category" ? [...related].slice(0, 30) : [],
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url: string, fetchImpl: typeof fetch, retryDelayMs: number, attempts = 3): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html" } });
      if (res.status === 404) throw Object.assign(new Error(`404 ${url}`), { permanent: true });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if ((err as { permanent?: boolean }).permanent) break;
      if (i < attempts - 1) await sleep(retryDelayMs * 2 ** i);
    }
  }
  throw lastErr;
}

export interface CrawlOptions {
  urls: string[];
  fetchImpl?: typeof fetch;
  concurrency?: number;
  delayMs?: number;
  /** Base backoff between retries of one page (doubles each attempt). */
  retryDelayMs?: number;
  log?: (msg: string) => void;
}

export async function crawl(opts: CrawlOptions): Promise<CatalogueEntry[]> {
  const { fetchImpl = fetch, concurrency = 2, delayMs = 500, retryDelayMs = 1000, log = () => {} } = opts;
  const queue = opts.urls.filter(shouldCrawl);
  const results: CatalogueEntry[] = [];
  let failures = 0;

  async function worker() {
    for (let url = queue.shift(); url; url = queue.shift()) {
      try {
        const html = await fetchWithRetry(url, fetchImpl, retryDelayMs);
        results.push(extractPage(html, url));
        log(`ok   ${url}`);
      } catch (err) {
        failures++;
        log(`fail ${url}: ${(err as Error).message}`);
        // If the site is unreachable from here, stop early instead of retrying every page.
        if (results.length === 0 && failures >= 5) {
          log("site looks unreachable; aborting crawl");
          queue.length = 0;
        }
      }
      await sleep(delayMs);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  log(`crawled ${results.length} pages, ${failures} failed`);
  return results.sort((a, b) => a.url.localeCompare(b.url));
}

/** Crawl the sitemap and write kb/catalogue.json. Keeps the old catalogue if nothing could be fetched. */
export async function refreshCatalogue(log: (msg: string) => void = console.log): Promise<CatalogueEntry[] | null> {
  const urls = parseSitemap(fs.readFileSync(paths.sitemap, "utf8"));
  const entries = await crawl({ urls, log });
  if (entries.length === 0) {
    log("crawl produced no pages; keeping existing catalogue");
    return null;
  }
  fs.writeFileSync(paths.catalogue, JSON.stringify(entries, null, 2) + "\n");
  log(`wrote ${entries.length} entries to ${paths.catalogue}`);
  return entries;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  refreshCatalogue().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
