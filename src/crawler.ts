/**
 * Builds a seller's SELLER CATALOGUE (RAG) by crawling the pages in their sitemap.xml.
 * The same entries feed the bot's retrieval and the seller's generated mini-website.
 *
 * Run with `npm run crawl` (all sellers) or `npm run crawl -- <slug>`. Needs outbound HTTPS
 * access to the sellers' sites, so run it where the bot is deployed or anywhere with internet.
 */
import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";

export interface PageLink {
  url: string;
  title: string;
}

export interface CatalogueEntry {
  url: string;
  kind: "product" | "category";
  /** URL-safe id derived from the page path, used for the generated site's URLs. */
  slug: string;
  title: string;
  category: string;
  price_text: string | null;
  specs: Record<string, string>;
  description: string;
  /** Main product/category image on the seller's site (linked, not copied). */
  image: string | null;
  /** Breadcrumb trail from the seller's site, excluding "Home". */
  breadcrumbs: PageLink[];
  /** On category pages: the products listed there. */
  products: PageLink[];
}

/** Turns "/product/cnc-press-brake-c8tj6re.html" into "cnc-press-brake-c8tj6re". */
export function slugFromUrl(url: string): string {
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    return "";
  }
  const last = pathname.split("/").filter(Boolean).pop() ?? "";
  return last
    .replace(/\.(html?|php|aspx?)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

/** "cnc-press-brake-machine-10f24dqbg" -> "Cnc press brake machine" (drops a trailing id that contains a digit). */
export function titleFromSlug(slug: string): string {
  const words = slug.replace(/-(?=[a-z0-9]*\d)[a-z0-9]{6,}$/, "").replace(/-/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const GENERIC_LINK_TEXT = /^(view|view details|view more|more|more details|details|read more|get (latest )?price|get (a )?quote|enquire( now)?|send enquiry|contact (us|supplier)|click here|yes,? i am interested)$/i;
const NOT_A_PRODUCT_IMAGE = /logo|icon|sprite|banner|placeholder|blank|loader|spacer|whatsapp|facebook|twitter|linkedin|youtube|instagram/i;

function absolute(src: string | undefined | null, base: string): string | null {
  if (!src || src.startsWith("data:")) return null;
  try {
    const u = new URL(src, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function imageFromJsonLd(product: Record<string, any> | undefined): string | undefined {
  const img = product?.image;
  if (!img) return undefined;
  if (typeof img === "string") return img;
  if (Array.isArray(img)) return typeof img[0] === "string" ? img[0] : img[0]?.url;
  return img.url;
}

function pickImage($: cheerio.CheerioAPI, ld: Record<string, any> | undefined, url: string): string | null {
  const candidates = [
    imageFromJsonLd(ld),
    $('meta[property="og:image"]').attr("content"),
    $('[itemprop="image"]').attr("src") ?? $('[itemprop="image"]').attr("content"),
    ...$("main img, #main img, .product img, [class*='product' i] img, img")
      .map((_, img) => $(img).attr("data-src") || $(img).attr("src"))
      .get(),
  ];
  for (const c of candidates) {
    const abs = absolute(c, url);
    if (abs && !NOT_A_PRODUCT_IMAGE.test(abs)) return abs;
  }
  return null;
}

export function extractPage(html: string, url: string): CatalogueEntry {
  const $ = cheerio.load(html);
  const ld = jsonLdProducts($)[0];
  const image = pickImage($, ld, url);
  $("script:not([type='application/ld+json']), style, noscript, iframe, header nav, footer").remove();

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

  const breadcrumbs: PageLink[] = [];
  $('[class*="breadcrumb" i] a, nav[aria-label="breadcrumb" i] a').each((_, a) => {
    const t = clean($(a).text());
    const href = absolute($(a).attr("href"), url);
    if (t && href && !/^home$/i.test(t) && !breadcrumbs.some((b) => b.url === href)) breadcrumbs.push({ title: t, url: href });
  });
  const category = clean(ld?.category) || breadcrumbs[breadcrumbs.length - 1]?.title || (kind === "category" ? title : "");

  // Product links on this page, titled by the best anchor text (or image alt) seen for each URL.
  const host = new URL(url).hostname;
  const productTitles = new Map<string, string>();
  $("a[href]").each((_, a) => {
    let href: URL;
    try {
      href = new URL($(a).attr("href")!, url);
    } catch {
      return;
    }
    if (href.hostname !== host || !/\/product\//.test(href.pathname)) return;
    const key = href.origin + href.pathname;
    if (key === url) return;
    const text = clean($(a).attr("title")) || clean($(a).text()) || clean($(a).find("img").attr("alt"));
    const useful = text && !GENERIC_LINK_TEXT.test(text) && text.length <= 120 ? text : "";
    const prev = productTitles.get(key);
    if (prev === undefined || (!prev && useful) || (useful && useful.length > prev.length)) productTitles.set(key, useful);
  });

  return {
    url,
    kind,
    slug: slugFromUrl(url),
    title,
    category,
    price_text: priceText,
    specs,
    description: description.slice(0, 600),
    image,
    breadcrumbs,
    products:
      kind === "category"
        ? [...productTitles].slice(0, 60).map(([u, t]) => ({ url: u, title: t || titleFromSlug(slugFromUrl(u)) }))
        : [],
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

/**
 * Crawl a seller's sitemap and write their catalogue. Keeps the old catalogue (returns null)
 * if nothing could be fetched, e.g. when the site is unreachable.
 */
export async function refreshCatalogue(opts: {
  sitemapFile: string;
  outFile: string;
  log?: (msg: string) => void;
  fetchImpl?: typeof fetch;
}): Promise<CatalogueEntry[] | null> {
  const log = opts.log ?? console.log;
  const urls = parseSitemap(fs.readFileSync(opts.sitemapFile, "utf8"));
  const entries = await crawl({ urls, log, fetchImpl: opts.fetchImpl });
  if (entries.length === 0) {
    log("crawl produced no pages; keeping existing catalogue");
    return null;
  }
  fs.mkdirSync(path.dirname(opts.outFile), { recursive: true });
  fs.writeFileSync(opts.outFile, JSON.stringify(entries, null, 2) + "\n");
  log(`wrote ${entries.length} entries to ${opts.outFile}`);
  return entries;
}
