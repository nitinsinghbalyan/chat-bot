/**
 * The seller knowledge base JSON that admins upload on /admin (the "BotPress" export, version
 * 3.0: seller, company_pages, photo_gallery, categories, products). When a seller has one, it is
 * the bot's main source: it replaces the BUSINESS CARD and PRODUCT CARDS from the KB folder,
 * while crawled website pages stay an extra source.
 *
 * The export carries data the guardrails keep out of chat (prices, delivery and payment terms,
 * turnover, staff numbers, year of establishment, GST and bank details, ratings). Those fields
 * are never read, and sentences about them are dropped from free text, so the bot never sees them.
 */
import { z } from "zod";
import { FORBIDDEN_SPEC_KEYS, slugFromUrl, splitSentences, stripForbidden } from "./crawler.js";
import type { CatalogueEntry } from "./crawler.js";
import type { BusinessCard, KnowledgeBase, ProductCard } from "./kb.js";
import { httpUrl, videoInfo, type MediaCard } from "./media.js";

const MAX_PROMPT_CHARS = 400_000;

/** Text fields in the export are sometimes null, numbers, booleans or lists. */
const str = z
  .unknown()
  .optional()
  .transform((v): string => {
    if (v == null) return "";
    if (Array.isArray(v)) return v.map((x) => (x == null || typeof x === "object" ? "" : String(x))).filter(Boolean).join(", ");
    if (typeof v === "object") return "";
    return String(v).trim();
  });
/** Ids are sometimes numbers, sometimes strings, sometimes blank; blanks are repaired after parsing. */
const id = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v == null ? "" : String(v).trim()));
const list = <T extends z.ZodTypeAny>(item: T) =>
  z
    .array(item)
    .nullish()
    .transform((v) => v ?? []);

const taggedProduct = z.looseObject({ DISPLAY_ID: id });

const galleryItem = z.looseObject({
  image_url: str,
  video_url: str,
  title: str,
  caption: str,
  sub_type: str,
  tagged_products: list(taggedProduct),
});

const pageSection = z.looseObject({ title: str, text: str });

const companyPage = z.looseObject({
  page_type: str,
  title: str,
  url: str,
  text: str,
  sections: list(pageSection),
});

const category = z.looseObject({
  category_id: id,
  name: str,
  url: str,
  description: str,
  image_url: str,
  product_ids: list(id).transform((ids) => ids.filter(Boolean)),
});

const productVideo = z.looseObject({ url: str, thumbnail_url: str, title: str });
const documentRef = z.union([z.string(), z.looseObject({ url: str, title: str })]).transform((d) => (typeof d === "string" ? { url: d.trim(), title: "" } : d));

const product = z.looseObject({
  product_id: id,
  product_url: str,
  name: str,
  display_name: str,
  category_id: id,
  taxonomy: z.looseObject({ category_name: str }).nullish(),
  item_code: str,
  description: str,
  specifications: list(z.looseObject({ name: str, value: str })),
  brand: str,
  min_order_quantity: str,
  price_unit: str,
  media: z
    .looseObject({
      main_image_url: str,
      gallery_image_urls: list(z.string()),
      videos: list(productVideo),
      document_urls: list(documentRef),
    })
    .nullish(),
});

const factsheetRow = z.looseObject({ section: str, name: str, value: str });

const seller = z.looseObject({
  company_name: z.string().trim().min(2, "must be the company name"),
  website_url: str,
  business_summary: str,
  nature_of_business: str,
  contact_person: str,
  contact_designation: str,
  address: z
    .looseObject({ line1: str, locality: str, city: str, state: str, pincode: str, country: str })
    .nullish(),
  phone: str,
  whatsapp_number: str,
  factsheet: list(factsheetRow),
  logo_url: str,
  corporate_video_url: str,
  corporate_brochure_url: str,
});

export const sellerKbSchema = z.looseObject({
  _version: str,
  seller,
  company_pages: list(companyPage),
  photo_gallery: list(galleryItem),
  categories: list(category),
  products: z.array(product).min(1, "must list at least one product").max(2000, "at most 2000 products"),
});

export type SellerKb = z.infer<typeof sellerKbSchema>;
type KbProduct = SellerKb["products"][number];

/** A small example in the same format, for the "Download template" link. */
export const SELLER_KB_TEMPLATE = {
  _version: "3.0",
  seller: {
    company_name: "Example Machine Tools Pvt Ltd",
    website_url: "https://www.example.com/",
    business_summary: "We manufacture hydraulic and CNC press brakes and shearing machines for sheet metal fabricators.",
    nature_of_business: "Manufacturer",
    contact_person: "A. Sharma",
    contact_designation: "Owner",
    address: { line1: "Plot 12, GIDC Metoda", locality: "Metoda", city: "Rajkot", state: "Gujarat", pincode: "360021", country: "India" },
    phone: "+91-9000000000",
    whatsapp_number: "",
    factsheet: [
      { section: "Basic Information", name: "Company CEO", value: "A. Sharma" },
      { section: "Basic Information", name: "Standards & Quality Certifications", value: "ISO 9001:2015" },
    ],
    logo_url: "https://www.example.com/logo.png",
    corporate_video_url: "https://www.youtube.com/watch?v=VIDEO_ID",
    corporate_brochure_url: "https://www.example.com/catalogue.pdf",
  },
  company_pages: [{ page_type: "about", title: "About Us", url: "https://www.example.com/about-us.html", text: "We build press brakes and shearing machines in our own factory.", sections: [] }],
  photo_gallery: [
    {
      image_url: "https://www.example.com/images/factory.jpg",
      video_url: "",
      title: "Our factory",
      caption: "",
      sub_type: "IMAGE",
      tagged_products: [],
    },
  ],
  categories: [
    {
      category_id: 1001,
      name: "CNC Press Brake",
      url: "https://www.example.com/cnc-press-brake.html",
      description: "CNC press brakes for sheet bending.",
      image_url: "https://www.example.com/images/cnc-press-brake.jpg",
      product_ids: [5001],
    },
  ],
  products: [
    {
      product_id: 5001,
      product_url: "https://www.example.com/product/cnc-press-brake-100-ton.html",
      name: "CNC Press Brake",
      display_name: "100 Ton CNC Press Brake",
      category_id: 1001,
      taxonomy: { category_name: "CNC Press Brake" },
      item_code: "CNC-100",
      description: "CNC hydraulic press brake with a Delem controller.",
      specifications: [
        { name: "Bending capacity", value: "100 Ton" },
        { name: "Bending length", value: "3200 mm" },
        { name: "Control Type", value: "CNC" },
      ],
      brand: "Example",
      min_order_quantity: "1",
      price_unit: "Piece",
      media: {
        main_image_url: "https://www.example.com/images/cnc-press-brake.jpg",
        gallery_image_urls: ["https://www.example.com/images/cnc-press-brake-side.jpg"],
        videos: [{ url: "https://www.youtube.com/watch?v=VIDEO_ID", thumbnail_url: "", title: "CNC press brake in operation" }],
        document_urls: ["https://www.example.com/brochures/cnc-press-brake.pdf"],
      },
    },
  ],
};

export type KbValidation = { ok: true; kb: SellerKb; warnings: string[]; summary: KbSummary } | { ok: false; errors: string[] };

export interface KbSummary {
  company: string;
  products: number;
  categories: number;
  images: number;
  videos: number;
  documents: number;
}

const pathOf = (p: PropertyKey[]) =>
  p.reduce<string>((acc, k) => (typeof k === "number" ? `${acc}[${k}]` : acc ? `${acc}.${String(k)}` : String(k)), "") || "(root)";

/** Validates an uploaded KB. Errors name the field, e.g. "products[2].name: must not be empty". */
export function validateSellerKb(input: unknown): KbValidation {
  const parsed = sellerKbSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.slice(0, 50).map((i) => `${pathOf(i.path)}: ${i.message}`) };
  const kb = parsed.data;
  const warnings: string[] = [];
  if (kb._version && kb._version !== "3.0") warnings.push(`_version is "${kb._version}"; this importer was built for version 3.0`);
  const fixes = repairKb(kb);
  if (kb.products.length === 0) return { ok: false, errors: ["products: no usable products (each needs a name)", ...fixes.slice(0, 20)] };
  warnings.push(...fixes);
  const seen = new Set(kb.products.map((p) => p.product_id));
  kb.products.forEach((p, i) => {
    if (p.product_url && !httpUrl(p.product_url)) warnings.push(`products[${i}].product_url: not a valid URL, ignored`);
  });
  for (const [i, c] of kb.categories.entries()) {
    const missing = c.product_ids.filter((pid) => !seen.has(pid));
    if (missing.length) warnings.push(`categories[${i}] (${c.name}): ${missing.length} product id(s) not found in products, ignored`);
  }
  const view = new KbView(kb);
  const size = view.systemText().length;
  if (size > MAX_PROMPT_CHARS) {
    return { ok: false, errors: [`The knowledge base is too large for the assistant (${size.toLocaleString()} characters of text; the limit is ${MAX_PROMPT_CHARS.toLocaleString()}).`] };
  }
  warnings.push("Prices, delivery and payment terms, turnover, staff numbers, year of establishment, GST, bank and rating details are not used by the bot (guardrails).");
  return { ok: true, kb, warnings, summary: view.summary() };
}

/**
 * Fixes gaps that real exports have (blank ids or names, duplicates) instead of rejecting the
 * whole file. Returns one note per fix, naming the field, for the admin to review.
 */
function repairKb(kb: SellerKb): string[] {
  const notes: string[] = [];
  const keptCategories: SellerKb["categories"] = [];
  const categoryIds = new Set<string>();
  kb.categories.forEach((c, i) => {
    if (!c.name) {
      notes.push(`categories[${i}]: no name, skipped`);
      return;
    }
    if (!c.category_id) {
      c.category_id = `auto-c-${i}`;
      notes.push(`categories[${i}].category_id (${c.name}): empty; generated one`);
    } else if (categoryIds.has(c.category_id)) {
      notes.push(`categories[${i}].category_id (${c.name}): ${c.category_id} is used twice; generated a new one`);
      c.category_id = `auto-c-${i}`;
    }
    categoryIds.add(c.category_id);
    keptCategories.push(c);
  });
  kb.categories = keptCategories;

  const keptProducts: SellerKb["products"] = [];
  const productIds = new Set<string>();
  kb.products.forEach((p, i) => {
    if (!p.name) p.name = p.display_name;
    if (!p.name) {
      notes.push(`products[${i}]: no name or display_name, skipped`);
      return;
    }
    if (!p.product_id) {
      p.product_id = `auto-p-${i}`;
      notes.push(`products[${i}].product_id (${p.name}): empty; generated one`);
    } else if (productIds.has(p.product_id)) {
      notes.push(`products[${i}].product_id (${p.name}): ${p.product_id} is used by an earlier product; skipped this one`);
      return;
    }
    productIds.add(p.product_id);
    keptProducts.push(p);
  });
  kb.products = keptProducts;
  return notes;
}

// ---------------------------------------------------------------------------
// Guardrail filters for free text in the export
// ---------------------------------------------------------------------------

/** Guardrail 7 topics: tenure, earnings, export share, staff and customer counts. */
const DISCLOSURE_TEXT =
  /\b(established|founded|incorporated|inception|since\s+(19|20)\d\d|in\s+the\s+year\s+(19|20)\d\d|(19|20)\d\d\s+onwards|\d+\s*\+?\s*years?|decades?|turnover|revenue|crore|lakh|export(s|ing)?\s+(up\s+to|about|around|nearly|over)|percent|%|employees?|workforce\s+of|staff\s+of|\d+\s*\+?\s*(clients|customers)|happy\s+customers|member\s+since|prices?|pricing|quotation)\b/i;

/** Drops sentences the bot may not repeat: forbidden topics (G2, G5, G6, G8), contacts (G3) and G7. */
export function cleanText(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((para) => stripForbidden(para.replace(/\s+/g, " ")))
    .map((para) =>
      splitSentences(para)
        .map((s) => s.trim())
        .filter((s) => s && !DISCLOSURE_TEXT.test(s))
        .join(" "),
    )
    .filter(Boolean)
    .join("\n\n");
}

const SPEC_NOT_ASKED = /country\s+of\s+origin|brand|make|model|item\s*code|^size$/i;
const PRICE_KEY = /price|rate|cost|mrp|discount/i;
/** Factsheet rows that are verified company details (Guardrail 7 allows these). Everything else is skipped. */
const FACTSHEET_ALLOWED = new Set([
  "nature of business",
  "additional business",
  "company ceo",
  "registered address",
  "legal status of firm",
  "industry",
  "standards & quality certifications",
  "provide after sales support",
  "primary competitive advantage",
  "quality measures / testing facilities",
  "contract manufacturing",
  "sampling policy",
  "building infrastructure",
  "location type",
]);
/** Company pages with product or capability content. Profile, insights, team, jobs, news and testimonials are skipped (Guardrail 7). */
const PAGES_ALLOWED = new Set(["home", "about", "why_us", "other", "quality", "infrastructure", "certificates"]);

const digits = (s: string) => s.replace(/\D/g, "");
function hostOf(u: string | undefined): string | null {
  const h = httpUrl(u);
  return h ? new URL(h).hostname.replace(/^www\./, "") : null;
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

interface Isq {
  question: string;
  options: string[];
}

/** Read-only view over an uploaded KB: rendering for the prompt, ISQs and media lookups. */
export class KbView {
  readonly kb: SellerKb;
  private byId = new Map<string, KbProduct>();
  private bySlug = new Map<string, KbProduct>();
  private categoryOfProduct = new Map<string, SellerKb["categories"][number]>();

  constructor(kb: SellerKb) {
    this.kb = kb;
    for (const p of kb.products) {
      this.byId.set(p.product_id, p);
      this.bySlug.set(this.slug(p), p);
    }
    // A product's category: listed in the category's product_ids, else by category_id, else by taxonomy name.
    for (const c of kb.categories) for (const pid of c.product_ids) if (!this.categoryOfProduct.has(pid)) this.categoryOfProduct.set(pid, c);
    const byName = new Map(kb.categories.map((c) => [c.name.toLowerCase(), c]));
    for (const p of kb.products) {
      if (this.categoryOfProduct.has(p.product_id)) continue;
      const c = (p.category_id && kb.categories.find((c) => c.category_id === p.category_id)) || byName.get((p.taxonomy?.category_name ?? "").toLowerCase());
      if (c) this.categoryOfProduct.set(p.product_id, c);
    }
    for (const p of kb.products) {
      const c = this.categoryOfProduct.get(p.product_id);
      if (!c) continue;
      const list = this.inCategory.get(c) ?? [];
      list.push(p);
      this.inCategory.set(c, list);
    }
  }

  private inCategory = new Map<SellerKb["categories"][number], KbProduct[]>();

  /** The id the bot uses for a product: the slug of its page URL (same as the crawled page), else "p-<id>". */
  slug(p: KbProduct): string {
    return slugFromUrl(p.product_url) || `p-${p.product_id}`;
  }

  title(p: KbProduct): string {
    return p.display_name || p.name;
  }

  product(slug: string): KbProduct | undefined {
    return this.bySlug.get(slug);
  }

  categoryOf(p: KbProduct) {
    return this.categoryOfProduct.get(p.product_id);
  }

  /** The category's products: its product_ids in order, then any others linked to it by id or name. */
  productsIn(c: SellerKb["categories"][number]): KbProduct[] {
    const listed = c.product_ids.map((pid) => this.byId.get(pid)).filter((p): p is KbProduct => !!p);
    const rest = (this.inCategory.get(c) ?? []).filter((p) => !listed.includes(p));
    return [...listed, ...rest];
  }

  specs(p: KbProduct): Array<[string, string]> {
    return p.specifications.filter((s) => s.name && s.value && !FORBIDDEN_SPEC_KEYS.test(s.name) && !PRICE_KEY.test(s.name)).map((s) => [s.name, s.value]);
  }

  /** ISQs for a category: attributes whose values differ across its products, with those values as options. */
  isqs(c: SellerKb["categories"][number]): Isq[] {
    const stats = new Map<string, { label: string; count: number; values: Map<string, { label: string; n: number }> }>();
    for (const p of this.productsIn(c)) {
      for (const [name, value] of this.specs(p)) {
        if (SPEC_NOT_ASKED.test(name)) continue;
        const key = name.toLowerCase().replace(/\s+/g, " ");
        const s = stats.get(key) ?? { label: name, count: 0, values: new Map<string, { label: string; n: number }>() };
        s.count++;
        for (const v of value.split(/\s*,\s*/)) {
          if (!v || v.length > 40) continue;
          // "Mild Steel" and "MILD STEEL" are one option; keep the first spelling seen.
          const k = v.toLowerCase();
          const prev = s.values.get(k);
          s.values.set(k, { label: prev?.label ?? v, n: (prev?.n ?? 0) + 1 });
        }
        stats.set(key, s);
      }
    }
    return [...stats.values()]
      .filter((s) => s.values.size >= 2)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map((s) => ({
        question: s.label,
        options: [...s.values.values()]
          .sort((a, b) => b.n - a.n)
          .slice(0, 8)
          .map((v) => v.label),
      }));
  }

  // ---- media ----

  private tagged(p: KbProduct, kind: "IMAGE" | "VIDEO") {
    return this.kb.photo_gallery.filter((g) => g.sub_type.toUpperCase() === kind && g.tagged_products.some((t) => t.DISPLAY_ID === p.product_id));
  }

  images(p: KbProduct): MediaCard[] {
    const urls = [p.media?.main_image_url, ...(p.media?.gallery_image_urls ?? []), ...this.tagged(p, "IMAGE").map((g) => g.image_url)];
    const seen = new Set<string>();
    const out: MediaCard[] = [];
    for (const u of urls) {
      const h = httpUrl(u ?? "");
      if (!h || seen.has(h)) continue;
      seen.add(h);
      out.push({ type: "image", title: this.title(p), url: h, thumb: h });
    }
    return out;
  }

  videos(p: KbProduct): MediaCard[] {
    const items = [
      ...(p.media?.videos ?? []).map((v) => ({ url: v.url, thumb: v.thumbnail_url, title: v.title })),
      ...this.tagged(p, "VIDEO").map((g) => ({ url: g.video_url, thumb: g.image_url, title: /^video$/i.test(g.title) ? "" : g.title })),
    ];
    return dedupeVideos(items, `${this.title(p)} video`);
  }

  documents(p: KbProduct): MediaCard[] {
    const out: MediaCard[] = [];
    for (const d of p.media?.document_urls ?? []) {
      const h = httpUrl(d.url);
      if (h && !out.some((o) => o.url === h)) out.push({ type: "document", title: d.title || `${this.title(p)} brochure (PDF)`, url: h });
    }
    return out;
  }

  /** Company-wide photos, videos and brochures (gallery items not tagged to a product). */
  companyMedia(): { images: MediaCard[]; videos: MediaCard[]; documents: MediaCard[] } {
    const s = this.kb.seller;
    const untagged = this.kb.photo_gallery.filter((g) => g.tagged_products.length === 0);
    const images: MediaCard[] = [];
    for (const g of untagged.filter((g) => g.sub_type.toUpperCase() === "IMAGE")) {
      const h = httpUrl(g.image_url);
      if (h && !images.some((i) => i.url === h)) images.push({ type: "image", title: g.title || s.company_name, url: h, thumb: h });
    }
    const videos = dedupeVideos(
      [
        ...(s.corporate_video_url ? [{ url: s.corporate_video_url, thumb: "", title: "Corporate video" }] : []),
        ...untagged.filter((g) => g.sub_type.toUpperCase() === "VIDEO").map((g) => ({ url: g.video_url, thumb: g.image_url, title: /^video$/i.test(g.title) ? "" : g.title })),
      ],
      `${s.company_name} video`,
    );
    const brochure = httpUrl(s.corporate_brochure_url);
    const documents: MediaCard[] = brochure ? [{ type: "document", title: "Company brochure (PDF)", url: brochure }] : [];
    return { images, videos, documents };
  }

  summary(): KbSummary {
    const company = this.companyMedia();
    let images = company.images.length;
    let videos = company.videos.length;
    let documents = company.documents.length;
    for (const p of this.kb.products) {
      images += this.images(p).length;
      videos += this.videos(p).length;
      documents += this.documents(p).length;
    }
    return { company: this.kb.seller.company_name, products: this.kb.products.length, categories: this.kb.categories.length, images, videos, documents };
  }

  // ---- the website catalogue ----

  /** Product and category page URLs, for crawling sellers that have no sitemap. */
  pageUrls(): string[] {
    const urls = [...this.kb.categories.map((c) => c.url), ...this.kb.products.map((p) => p.product_url)].map((u) => httpUrl(u)).filter((u): u is string => !!u);
    return [...new Set(urls)];
  }

  /**
   * The JSON as website catalogue entries. Unlike the bot's view, these keep the listed starting
   * price (the website shows it); forbidden spec rows and sentences are still removed.
   */
  catalogueEntries(): CatalogueEntry[] {
    const entries: CatalogueEntry[] = [];
    // Records without a page URL still get a page here, keyed by a stable placeholder on the seller's site.
    const site = httpUrl(this.kb.seller.website_url) ?? "https://seller.invalid/";
    const urlOfCategory = (c: SellerKb["categories"][number]) => httpUrl(c.url) ?? `${site}#category-${encodeURIComponent(c.category_id)}`;
    const urlOfProduct = (p: KbProduct) => httpUrl(p.product_url) ?? `${site}#product-${encodeURIComponent(p.product_id)}`;
    for (const c of this.kb.categories) {
      const url = urlOfCategory(c);
      if (!url) continue;
      const products = this.productsIn(c).map((p) => ({ url: urlOfProduct(p), title: this.title(p), image: this.images(p)[0]?.url ?? null }));
      const desc = cleanText(c.description);
      entries.push({
        url,
        kind: "category",
        slug: slugFromUrl(url) || slugFromUrl(`https://x/${c.name}`) || `c-${c.category_id}`,
        title: c.name,
        category: c.name,
        price_text: null,
        specs: {},
        description: desc,
        image: httpUrl(c.image_url) ?? products.find((p) => p.image)?.image ?? null,
        images: [],
        details: desc,
        features: [],
        videos: [],
        documents: [],
        breadcrumbs: [],
        products,
      });
    }
    for (const p of this.kb.products) {
      const url = urlOfProduct(p);
      const c = this.categoryOf(p);
      const cUrl = c ? urlOfCategory(c) : null;
      const images = this.images(p).map((i) => i.url);
      const details = cleanText(p.description);
      entries.push({
        url,
        kind: "product",
        slug: this.slug(p),
        title: this.title(p),
        category: c?.name || p.taxonomy?.category_name || "",
        price_text: typeof p.price_text === "string" && p.price_text.trim() ? p.price_text.trim() : null,
        specs: Object.fromEntries(this.specs(p)),
        description: details.split("\n\n")[0].slice(0, 300),
        image: images[0] ?? null,
        images,
        details,
        features: [],
        videos: this.videos(p).map((v) => ({ url: v.url, title: v.title })),
        documents: this.documents(p).map((d) => ({ url: d.url, title: d.title })),
        breadcrumbs: c && cUrl ? [{ title: c.name, url: cUrl }] : [],
        products: [],
      });
    }
    return entries;
  }

  // ---- rendering for the system prompt ----

  location(): { city: string; address: string } {
    const a = this.kb.seller.address;
    return {
      city: [a?.city, a?.state, a?.country].filter(Boolean).join(", "),
      address: [a?.line1, a?.locality, a?.pincode]
        .filter(Boolean)
        .join(", ")
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x && !/^nil$/i.test(x))
        .join(", "),
    };
  }

  private fact(name: string): string {
    return this.kb.seller.factsheet.find((f) => f.name.toLowerCase() === name)?.value ?? "";
  }

  businessCard(): BusinessCard {
    const s = this.kb.seller;
    const { city, address } = this.location();
    return {
      name: s.company_name,
      ceo: this.fact("company ceo") || undefined,
      location: [city, address ? `(registered address: ${address})` : ""].filter(Boolean).join(" ") || undefined,
      nature: s.nature_of_business ? [s.nature_of_business] : undefined,
      deals_in: this.kb.categories.map((c) => c.name),
      listed_contact: s.phone || undefined,
    };
  }

  companyText(): string {
    const s = this.kb.seller;
    const { city, address } = this.location();
    const lines = [`Name: ${s.company_name}`];
    if (s.nature_of_business) lines.push(`Nature of business: ${s.nature_of_business}`);
    for (const f of s.factsheet) {
      const key = f.name.toLowerCase();
      if (!FACTSHEET_ALLOWED.has(key) || !f.value || f.value === "[]" || key === "nature of business") continue;
      lines.push(`${f.name}: ${key === "registered address" ? f.value : cleanText(f.value) || f.value}`);
    }
    if (city) lines.push(`Location: ${city}${address ? ` (address: ${address})` : ""}`);
    if (s.contact_person) lines.push(`Contact person: ${s.contact_person}${s.contact_designation ? `, ${s.contact_designation}` : ""}`);
    const contacts = [s.phone ? `phone ${s.phone}` : "", s.whatsapp_number ? `WhatsApp ${s.whatsapp_number}` : "", httpUrl(s.website_url) ? `website ${s.website_url}` : ""].filter(Boolean);
    if (contacts.length) lines.push(`Listed contact (share only if the buyer asks for a contact): ${contacts.join(", ")}`);
    if (this.kb.categories.length) lines.push(`Deals in: ${this.kb.categories.map((c) => c.name).join(", ")}`);
    const summary = cleanText(s.business_summary);
    if (summary) lines.push(`Summary: ${summary}`);
    const seenParas = new Set<string>(summary ? [summary] : []);
    const pages: string[] = [];
    for (const p of this.kb.company_pages) {
      if (!PAGES_ALLOWED.has(p.page_type)) continue;
      const paras = cleanText(p.text)
        .split("\n\n")
        .filter((para) => para.length > 20 && !seenParas.has(para));
      paras.forEach((para) => seenParas.add(para));
      if (paras.length) pages.push(`${p.title.replace(/\s+-\s+.*$/, "") || p.page_type}:\n${paras.join("\n")}`);
    }
    if (pages.length) lines.push(`About the company (from our website):\n${pages.join("\n\n")}`);
    const m = this.companyMedia();
    const counts = [m.images.length ? plural(m.images.length, "photo") : "", m.videos.length ? plural(m.videos.length, "video") : "", m.documents.length ? plural(m.documents.length, "brochure") : ""].filter(Boolean);
    if (counts.length) lines.push(`Company media (share with share_media, product id "company"): ${counts.join(", ")}`);
    return lines.join("\n");
  }

  productText(p: KbProduct): string {
    const lines = [`## ${this.title(p)}`, `Product id: ${this.slug(p)}`];
    const c = this.categoryOf(p);
    const cat = c?.name || p.taxonomy?.category_name;
    if (cat) lines.push(`Category: ${cat}`);
    if (p.name && p.name !== this.title(p)) lines.push(`Also known as: ${p.name}`);
    if (p.brand) lines.push(`Brand: ${p.brand}`);
    if (p.item_code && !/^\d+$/.test(p.item_code)) lines.push(`Model / item code: ${p.item_code}`);
    if (p.min_order_quantity) lines.push(`Minimum order: ${p.min_order_quantity}${p.price_unit ? ` ${p.price_unit}` : ""}`);
    const specs = this.specs(p);
    if (specs.length) lines.push(`Specifications: ${specs.map(([k, v]) => `${k}: ${v}`).join("; ")}`);
    const desc = cleanText(p.description).slice(0, 1500);
    if (desc) lines.push(`Description: ${desc}`);
    const media = [plural(this.images(p).length, "photo"), plural(this.videos(p).length, "video"), plural(this.documents(p).length, "brochure")];
    lines.push(`Media: ${media.join(", ")}`);
    const url = httpUrl(p.product_url);
    if (url) lines.push(`Page: ${url}`);
    return lines.join("\n");
  }

  productCardsText(): string {
    const guide = this.kb.categories
      .map((c) => {
        const products = this.productsIn(c);
        const isqs = this.isqs(c);
        const lines = [`### ${c.name}`];
        const desc = cleanText(c.description);
        if (desc) lines.push(desc);
        lines.push(`Products: ${products.map((p) => `${this.title(p)} (${this.slug(p)})`).join("; ") || "none listed"}`);
        if (isqs.length) {
          lines.push(`ISQs (ask one per message, in this order, offering the options with show_options):\n${isqs.map((q, i) => `${i + 1}. ${q.question}? Options: ${q.options.join(" / ")}`).join("\n")}`);
        }
        return lines.join("\n");
      })
      .join("\n\n");
    const products = this.kb.products.map((p) => this.productText(p)).join("\n\n---\n\n");
    return `# Categories and their ISQs\n\n${guide || "No categories listed."}\n\n# Products\n\n${products}`;
  }

  systemText(): string {
    return this.companyText() + this.productCardsText();
  }
}

function dedupeVideos(items: Array<{ url: string; thumb: string; title: string }>, fallbackTitle: string): MediaCard[] {
  const out: MediaCard[] = [];
  for (const it of items) {
    const v = videoInfo(it.url, it.thumb);
    if (!v || out.some((o) => o.url === v.url)) continue;
    out.push({ type: "video", title: it.title || fallbackTitle, url: v.url, thumb: v.thumb, embed: v.embed });
  }
  return out;
}

/**
 * Turns an uploaded KB into the KnowledgeBase the bot uses. `base` (from the KB folder) supplies
 * the sitemap domains, so links to the seller's crawled website stay shareable.
 */
export function knowledgeFromKb(view: KbView, base: KnowledgeBase): KnowledgeBase {
  const productCards: ProductCard[] = view.kb.products.map((p) => ({
    product_id: view.slug(p),
    canonical_name: view.title(p),
    category: view.categoryOf(p)?.name,
    flow: { markdown: view.productText(p) },
  }));
  const domains = new Set(base.allowedDomains);
  for (const u of [view.kb.seller.website_url, ...view.kb.products.map((p) => p.product_url)]) {
    const h = hostOf(u);
    if (h) domains.add(h);
  }
  const s = view.kb.seller;
  return {
    businessCard: view.businessCard(),
    productCards,
    businessCardText: view.companyText(),
    productCardsText: view.productCardsText(),
    allowedPhones: [s.phone, s.whatsapp_number].filter(Boolean).map(digits),
    allowedDomains: [...domains].sort(),
  };
}
