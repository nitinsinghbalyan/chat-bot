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
import { findMcat, idsIn, type McatSpec } from "./sellerFiles.js";
import { PRICE_AMOUNT, type FaqRow } from "./faq.js";

/**
 * How much KB text goes into the (cached) system prompt. A catalogue up to this size is included
 * in full; a larger one gets a category guide with ISQs and a product index instead, and the
 * matching products' details reach the bot per message through the SELLER CATALOGUE search.
 */
export const PROMPT_BUDGET = 300_000;
/** Export versions this importer was built for (older files keep loading; others get a warning). */
export const KB_VERSIONS = new Set(["3.0", "5.0"]);
/** Company pages beyond this are cut, so they can't crowd out the products. */
const COMPANY_PAGES_BUDGET = 30_000;

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
  taxonomy: z.looseObject({ category_name: str, group_name: str, mcat_name: str, glmcat_ids: str, glcat_ids: str }).nullish(),
  item_code: str,
  description: str,
  specifications: list(z.looseObject({ name: str, value: str })),
  brand: str,
  min_order_quantity: str,
  price_unit: str,
  /** Version 5.0: the seller's own questions and answers about this product. */
  faqs: list(z.looseObject({ question: str, answer: str })),
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
  /** The seller's IndiaMART id (glid), used to match common FAQ rows to the seller. */
  seller_id: str,
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
  products: z.array(product).min(1, "must list at least one product").max(20_000, "at most 20,000 products"),
});

export type SellerKb = z.infer<typeof sellerKbSchema>;
type KbProduct = SellerKb["products"][number];

/** A small example in the same format, for the "Download template" link. */
export const SELLER_KB_TEMPLATE = {
  _version: "5.0",
  seller: {
    seller_id: 1234567,
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
      taxonomy: { category_name: "CNC Press Brake", group_name: "Sheet Metal Machinery", mcat_name: "", glcat_ids: ",697,", glmcat_ids: ",25058," },
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
      faqs: [{ question: "Does the CNC press brake come with tooling?", answer: "Yes, a standard punch and die set is included." }],
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
  if (kb._version && !KB_VERSIONS.has(kb._version)) warnings.push(`_version is "${kb._version}"; this importer was built for versions ${[...KB_VERSIONS].join(" and ")}`);
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
  const plan = view.promptPlan();
  if (plan.mode !== "full") {
    warnings.unshift(
      `Large catalogue (${plural(kb.products.length, "product")}, about ${plan.fullChars.toLocaleString()} characters): the assistant keeps ${
        plan.mode === "index" ? "the categories, ISQs and a list of every product" : "the categories, ISQs and part of the product list"
      } in memory and looks up each matching product's full details as buyers ask.`,
    );
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

const SPEC_NOT_ASKED = /country\s+of\s+origin|brand|make|model|item\s*code|product\s*code|^code$|\bsku\b|\bhsn\b|part\s*(no|number)|^size$/i;
/** A product attribute label too long to be a question ("Police verified nanny, infant & newborn baby care experience"). */
const MAX_LABEL = 40;
/** MCAT file specs that are never questions (the file's specs are curated ISQs, so only identity rows are skipped). */
const SPEC_NEVER_ASKED = /brand|^make$|model|item\s*code/i;
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

export interface Isq {
  question: string;
  options: string[];
  /** Where the question comes from: an MCAT file spec the seller's products carry, the products' own spec values, or an MCAT file spec no product lists (the category's standard question). */
  from?: "products" | "derived" | "mcat";
  /** IndiaMART ISQ type when the MCAT file marks it (asked in this order: key, config, regular). */
  type?: IsqType;
}
export type IsqType = "key" | "config" | "regular";
const TYPE_RANK: Record<IsqType, number> = { key: 0, config: 1, regular: 2 };

/** The questions a plan may hold: the most asked in one conversation. */
export const MAX_ISQS = 8;
/** Options shown per question (the chat shows up to 8 chips; 6 keeps them readable). */
const MAX_OPTIONS = 6;

/**
 * The spec questions for one machine: a category and the MCAT within it (the one the buyer's
 * product belongs to, else the category's main MCAT), and where the questions came from.
 */
export interface IsqPlan {
  category: string;
  /** "<category> · <MCAT name>" (just the category when no MCAT is known). */
  label: string;
  mcatId: string | null;
  /** "mcat": at least one question is an MCAT file spec (carried by the products, or the MCAT's standard one); "derived": all come from the products' own specification values. Each question says where it is from. */
  source: "mcat" | "derived";
  mcat?: string;
  isqs: Isq[];
  /** How many of the seller's products the questions were checked against. */
  presentOn: number;
}

/** One MCAT within a category: how many of the category's products belong to it, and the file's entry if any. */
export interface CategoryMcat {
  id: string;
  products: number;
  name?: string;
  inFile: boolean;
}

/** Name tokens for matching an MCAT spec to a product spec ("Size/Diameter" covers "Diameter"). */
const specTokens = (s: string) => new Set(normKey(s).replace(/[()]/g, " ").split(" ").filter((w) => w && !SPEC_STOP.has(w)));
const SPEC_STOP = new Set(["of", "the", "type", "no", "number", "in", "and", "or"]);
const subset = (a: Set<string>, b: Set<string>) => a.size > 0 && [...a].every((w) => b.has(w));
/** Same spec attribute: equal once normalised, or one name's words are all in the other's. */
export function specNamesMatch(a: string, b: string): boolean {
  if (normKey(a) === normKey(b)) return true;
  const ta = specTokens(a);
  const tb = specTokens(b);
  return subset(ta, tb) || subset(tb, ta);
}
/** An MCAT option the seller's products carry: equal to a product value, or all its words are in it ("22 Gauge" ~ "22 gauge thick"). */
function optionSeen(option: string, values: Set<string>): boolean {
  const o = valueKey(option);
  if (values.has(o)) return true;
  const to = specTokens(option);
  for (const v of values) if (subset(to, specTokens(v))) return true;
  return false;
}

/** Two options that mean the same thing, for spotting a repeated question: "Crystal" ~ "Crystals", "paste form" ~ "Paste". */
function similarOption(a: string, b: string): boolean {
  const stem = (s: string) => new Set([...specTokens(s)].map((w) => (w.length > 3 ? w.replace(/s$/, "") : w)));
  const ta = stem(a);
  const tb = stem(b);
  return subset(ta, tb) || subset(tb, ta);
}

/** Spec rows that aren't questions a buyer can answer (on top of brand, model and price). */
const SPEC_NOT_A_QUESTION = /usage|application|machine\s*type|^type$|^product\s*type$|^model\s*name/i;
const normKey = (s: string) => s.toLowerCase().replace(/[-_/]+/g, " ").replace(/\s+/g, " ").trim();

/** One product attribute across a set of products: how many carry it and its distinct values, most common first. */
export interface SpecStat {
  label: string;
  /** Products carrying the attribute. */
  count: number;
  /** Distinct values as written (merged spellings), most common first. */
  options: string[];
  /** The same values normalised, for matching an MCAT option. */
  values: Set<string>;
}

/**
 * The attributes of a set of products that can be asked as questions: each attribute whose values
 * differ, with those values as options. Cleaned, because exports are messy: non-questions (usage,
 * machine type) are skipped, "Semi-Automatic" and "Semi Automatic" are one option, bare numbers
 * ("6 00") and long values are dropped, one-off values are dropped in families of 20 or more
 * products, and an attribute must appear on `minShare` of the products (any share below 4 products).
 * Most widely carried first.
 */
export function specStats(productsSpecs: Array<Array<[string, string]>>, minShare = 0.25): SpecStat[] {
  const stats = new Map<string, { label: string; count: number; values: Map<string, { label: string; n: number }> }>();
  for (const specs of productsSpecs) {
    const seenHere = new Set<string>();
    for (const [name, value] of specs) {
      if (name.length > MAX_LABEL || SPEC_NOT_ASKED.test(name) || SPEC_NOT_A_QUESTION.test(name)) continue;
      const key = normKey(name);
      const s = stats.get(key) ?? { label: name, count: 0, values: new Map<string, { label: string; n: number }>() };
      if (!seenHere.has(key)) s.count++;
      seenHere.add(key);
      for (const raw of value.split(/\s*,\s*/)) {
        const v = raw.trim();
        if (!v || v.length > 30 || /^[\d\s.]+$/.test(v)) continue;
        const k = valueKey(v);
        const prev = s.values.get(k);
        s.values.set(k, { label: prev?.label ?? v, n: (prev?.n ?? 0) + 1 });
      }
      stats.set(key, s);
    }
  }
  const n = productsSpecs.length;
  return [...stats.values()]
    .filter((s) => n < 4 || s.count >= n * minShare)
    .map((s) => ({ ...s, kept: [...s.values].filter(([, v]) => n < 20 || v.n > 1).sort((a, b) => b[1].n - a[1].n) }))
    .filter((s) => s.kept.length >= 2)
    .sort((a, b) => b.count - a.count)
    .map((s) => ({ label: s.label, count: s.count, options: s.kept.map(([, v]) => v.label), values: new Set(s.kept.map(([k]) => k)) }));
}

/** A spec value's identity: case, separators, the space before a unit ("2.5mm" = "2.5 mm") and plurals ("350 grams" = "350 GRAM") don't count. */
const valueKey = (v: string) =>
  normKey(v)
    .replace(/\b([a-z]{4,})s\b/g, "$1")
    .replace(/(\d)\s+([a-z])/g, "$1$2");

/** Distinct spec values as written (split on commas and slashes, spellings merged, bare numbers and long values dropped). */
function cleanValues(values: string[]): string[] {
  const out = new Map<string, string>();
  for (const raw of values.flatMap((v) => v.split(/\s*[,/|]\s*/))) {
    const v = raw.trim();
    if (!v || v.length > 30 || /^[\d\s.]+$/.test(v)) continue;
    const k = valueKey(v);
    if (!out.has(k)) out.set(k, v);
  }
  return [...out.values()];
}

/** ISQs derived from products' specifications (see specStats): up to 4 questions with up to 6 options, most common first. */
export function deriveIsqs(productsSpecs: Array<Array<[string, string]>>): Isq[] {
  return specStats(productsSpecs)
    .slice(0, 4)
    .map((s) => ({ question: s.label, options: s.options.slice(0, MAX_OPTIONS) }));
}

export interface KbViewOptions {
  /** The seller's MCAT specifications file: the spec questions per MCAT (see isqPlan). */
  mcats?: McatSpec[];
  /** Characters of the system prompt already taken by uploaded extras (business card, product cards). */
  reservedChars?: number;
}

/** Read-only view over an uploaded KB: rendering for the prompt, ISQs and media lookups. */
export class KbView {
  readonly kb: SellerKb;
  private byId = new Map<string, KbProduct>();
  private bySlug = new Map<string, KbProduct>();
  private categoryOfProduct = new Map<string, SellerKb["categories"][number]>();

  readonly options: KbViewOptions;

  constructor(kb: SellerKb, options: KbViewOptions = {}) {
    this.kb = kb;
    this.options = options;
    for (const p of kb.products) {
      this.byId.set(p.product_id, p);
      this.bySlug.set(this.slug(p), p);
    }
    // A product's categories: every category listing it in product_ids (a product can sit in several),
    // else the one named by its category_id, else by its taxonomy category name. The first is its main one.
    const byName = new Map(kb.categories.map((c) => [c.name.toLowerCase(), c]));
    const byCategoryId = new Map(kb.categories.map((c) => [c.category_id, c]));
    for (const c of kb.categories) {
      for (const pid of c.product_ids) {
        const list = this.categoriesOfProduct.get(pid) ?? [];
        if (!list.includes(c)) list.push(c);
        this.categoriesOfProduct.set(pid, list);
      }
    }
    for (const p of kb.products) {
      if (this.categoriesOfProduct.has(p.product_id)) continue;
      const c = (p.category_id && byCategoryId.get(p.category_id)) || byName.get((p.taxonomy?.category_name ?? "").toLowerCase());
      if (c) this.categoriesOfProduct.set(p.product_id, [c]);
    }
    for (const p of kb.products) {
      for (const c of this.categoriesOfProduct.get(p.product_id) ?? []) {
        const list = this.inCategory.get(c) ?? [];
        list.push(p);
        this.inCategory.set(c, list);
      }
    }
  }

  private inCategory = new Map<SellerKb["categories"][number], KbProduct[]>();
  private categoriesOfProduct = new Map<string, SellerKb["categories"][number][]>();

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

  /** A product's main category (the first listing it). */
  categoryOf(p: KbProduct) {
    return this.categoriesOfProduct.get(p.product_id)?.[0];
  }

  /** Every category a product is mapped to (the mapping is not one to one). */
  categoriesOf(p: KbProduct): SellerKb["categories"][number][] {
    return this.categoriesOfProduct.get(p.product_id) ?? [];
  }

  /** The category's products: its product_ids in order, then any others linked to it by id or name. */
  productsIn(c: SellerKb["categories"][number]): KbProduct[] {
    const listed = c.product_ids.map((pid) => this.byId.get(pid)).filter((p): p is KbProduct => !!p);
    const listedSet = new Set(listed);
    const rest = (this.inCategory.get(c) ?? []).filter((p) => !listedSet.has(p));
    return [...listed, ...rest];
  }

  specs(p: KbProduct): Array<[string, string]> {
    return p.specifications.filter((s) => s.name && s.value && !FORBIDDEN_SPEC_KEYS.test(s.name) && !PRICE_KEY.test(s.name)).map((s) => [s.name, s.value]);
  }

  /** ISQs derived from the products' own specification values: see deriveIsqs. */
  isqs(c: SellerKb["categories"][number], products: KbProduct[] = this.productsIn(c)): Isq[] {
    return deriveIsqs(products.map((p) => this.specs(p)));
  }

  /** A product's MCAT: the first id in its taxonomy `glmcat_ids`, or null. */
  mcatOf(p: KbProduct): string | null {
    return idsIn(p.taxonomy?.glmcat_ids)[0] ?? null;
  }

  private mcatsCache = new Map<SellerKb["categories"][number], CategoryMcat[]>();

  /** The MCATs of a category's products, most products first (a site category often pools several MCATs). */
  mcatsOf(c: SellerKb["categories"][number]): CategoryMcat[] {
    const hit = this.mcatsCache.get(c);
    if (hit) return hit;
    const counts = new Map<string, number>();
    for (const p of this.productsIn(c)) for (const id of new Set(idsIn(p.taxonomy?.glmcat_ids))) counts.set(id, (counts.get(id) ?? 0) + 1);
    const file = new Map((this.options.mcats ?? []).map((m) => [m.id, m]));
    const out = [...counts]
      .sort((a, b) => b[1] - a[1])
      .map(([id, products]) => ({ id, products, name: file.get(id)?.name, inFile: file.has(id) }));
    this.mcatsCache.set(c, out);
    return out;
  }

  /** The MCAT most of a category's products belong to, or null when the export has no MCAT ids. */
  mainMcatOf(c: SellerKb["categories"][number]): string | null {
    return this.mcatsOf(c)[0]?.id ?? null;
  }

  /** @deprecated use mainMcatOf */
  mcatIdOf(c: SellerKb["categories"][number]): string | null {
    return this.mainMcatOf(c);
  }

  /** The category's products in one MCAT (all of them when the MCAT is unknown). */
  productsOfMcat(c: SellerKb["categories"][number], mcatId: string | null): KbProduct[] {
    const all = this.productsIn(c);
    return mcatId ? all.filter((p) => idsIn(p.taxonomy?.glmcat_ids).includes(mcatId)) : all;
  }

  /**
   * The questions for a category and the MCAT within it, in the order they are asked, before the
   * cap and the repeat check (see isqPlan):
   * 1. the seller's own specs: every attribute whose values differ across the category's products
   *    (`specStats`, at least 15% of them), the seller's values as options. One that is also an
   *    MCAT file spec (by name) takes that spec's name and type and offers the MCAT's other options
   *    after the seller's ("products"); the rest are seller-only ("derived"). An MCAT spec with no
   *    attribute of its name but an option found among the products' values or names also counts
   *    as carried ("products"). Ordered by ISQ type (key, config, regular) when the file marks it,
   *    else MCAT-listed specs before seller-only ones, each by how many products carry them.
   * 2. the MCAT's remaining specs, which no product carries ("mcat"), in the file's order, which
   *    IndiaMART lists by importance, or by type when marked.
   * Brand, model and item code are never questions.
   */
  private orderedSpecs(m: McatSpec | undefined, products: KbProduct[]): Isq[] {
    const rows = products.map((p) => this.specs(p));
    const stats = specStats(rows, 0.15);
    // Every value the products list (not only the askable attributes') plus their names, to tell an MCAT spec the seller carries.
    const allValues = new Set([...rows.flat().flatMap(([, v]) => v.split(/\s*[,/|]\s*/)), ...products.map((p) => this.title(p))].map(valueKey).filter(Boolean));
    const fileSpecs = (m?.specs ?? []).filter((s) => !SPEC_NEVER_ASKED.test(s.name));
    const used = new Set<number>();
    type Ranked = Isq & { rank: number[] };
    // Order: the ISQ type when the file marks it; else MCAT-listed specs (the category's key ones) before seller-only
    // attributes, each by how many products carry them, then by first appearance.
    const rankOf = (type: IsqType | undefined, listed: boolean, count: number, i: number) => [type ? TYPE_RANK[type] : listed ? 0 : 1, -count, i];
    const own: Ranked[] = [];
    stats.forEach((s, i) => {
      const k = fileSpecs.findIndex((f, j) => !used.has(j) && specNamesMatch(f.name, s.label));
      if (k >= 0) {
        used.add(k);
        const f = fileSpecs[k];
        const options = [...s.options, ...f.options.filter((o) => !optionSeen(o, s.values))].slice(0, MAX_OPTIONS);
        own.push({ question: f.name, options, from: "products", ...(f.type ? { type: f.type } : {}), rank: rankOf(f.type, true, s.count, i) });
      } else {
        own.push({ question: s.label, options: s.options.slice(0, MAX_OPTIONS), from: "derived", rank: rankOf(undefined, false, s.count, i) });
      }
    });
    const standard: Ranked[] = [];
    fileSpecs.forEach((f, j) => {
      if (used.has(j)) return;
      // Carried by name even when the products agree on one value ("Control Axis: 8 + 1 AXIS" on the only product):
      // the seller's values lead, then the MCAT's other options. Else carried when an option shows up in the products' values or names.
      const carrying = rows.filter((r) => r.some(([n]) => specNamesMatch(f.name, n)));
      const ownValues = cleanValues(carrying.flatMap((r) => r.filter(([n]) => specNamesMatch(f.name, n)).map(([, v]) => v)));
      const ownSet = new Set(ownValues.map(valueKey));
      const seen = f.options.filter((o) => optionSeen(o, carrying.length ? ownSet : allValues));
      const lead = carrying.length ? ownValues : seen;
      const options = [...lead, ...f.options.filter((o) => !lead.includes(o) && !optionSeen(o, ownSet))].slice(0, MAX_OPTIONS);
      const q: Isq = { question: f.name, options, from: carrying.length || seen.length ? "products" : "mcat", ...(f.type ? { type: f.type } : {}) };
      if (carrying.length || seen.length) own.push({ ...q, rank: rankOf(f.type, true, carrying.length, stats.length + j) });
      else standard.push({ ...q, rank: rankOf(f.type, true, 0, j) });
    });
    const byRank = (a: Ranked, b: Ranked) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2];
    return [...own.sort(byRank), ...standard.sort(byRank)].map(({ rank: _rank, ...q }) => q);
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
    let pagesChars = 0;
    for (const p of this.kb.company_pages) {
      if (pagesChars > COMPANY_PAGES_BUDGET) break;
      if (!PAGES_ALLOWED.has(p.page_type)) continue;
      const paras = cleanText(p.text)
        .split("\n\n")
        .filter((para) => para.length > 20 && !seenParas.has(para));
      paras.forEach((para) => seenParas.add(para));
      if (!paras.length) continue;
      const page = `${p.title.replace(/\s+-\s+.*$/, "") || p.page_type}:\n${paras.join("\n")}`.slice(0, COMPANY_PAGES_BUDGET - pagesChars + 1);
      pages.push(page);
      pagesChars += page.length;
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

  private planCache = new Map<string, IsqPlan>();

  /**
   * The spec questions for a machine: the category and the MCAT within it. `mcatId` is the
   * buyer's product's MCAT when known; otherwise (or if no product of the category has it) the
   * category's main MCAT is used. Then:
   * 1. the MCAT file's entry for that id, else an entry whose name equals the category's;
   * 2. the questions of orderedSpecs: the seller's own specs across the category's products first
   *    (ordered by ISQ type, else by how many products carry them), then the MCAT's specs the
   *    seller doesn't carry; up to MAX_ISQS, never repeating a question (same name, or most of its
   *    options already offered by an earlier one).
   */
  isqPlan(c: SellerKb["categories"][number], mcatId?: string | null): IsqPlan {
    const inCategory = mcatId ? this.mcatsOf(c).some((m) => m.id === mcatId) : false;
    const id = inCategory ? mcatId! : this.mainMcatOf(c);
    const key = `${c.category_id}\u0000${id ?? ""}`;
    const hit = this.planCache.get(key);
    if (hit) return hit;
    // Values are compared across the whole category's products (a product can sit in several
    // categories; each category plans on its own), as the seller's range for that kind of product.
    const products = this.productsIn(c);
    const mcats = (this.options.mcats ?? []).filter((m) => m.specs.length);
    const m = (id && mcats.find((x) => x.id === id)) || findMcat(mcats, [c.name]);
    const label = m ? `${c.name} · ${m.name}` : c.name;
    const isqs: Isq[] = [];
    // Never ask the same thing twice: same name ("Max Shearing Thickness" covers "Shearing
    // Thickness"), or most of its options already offered by an earlier question ("Form Of
    // Asafoetida Available: Granules / Crystal / Paste" after "Physical Form").
    const repeats = (q: Isq) =>
      isqs.some((x) => {
        if (specNamesMatch(x.question, q.question)) return true;
        const shared = q.options.filter((o) => x.options.some((p) => similarOption(o, p))).length;
        return q.options.length > 0 && shared * 2 >= q.options.length;
      });
    for (const q of this.orderedSpecs(m, products)) if (isqs.length < MAX_ISQS && !repeats(q)) isqs.push(q);
    let plan: IsqPlan = {
      category: c.name,
      label,
      mcatId: id,
      source: isqs.some((q) => q.from !== "derived") ? "mcat" : "derived",
      ...(m ? { mcat: m.name } : {}),
      isqs: isqs.slice(0, MAX_ISQS),
      presentOn: products.length,
    };
    // A product's MCAT that yields no questions (one product, specs not in the file): fall back to the category's main MCAT.
    if (!plan.isqs.length && inCategory && id !== this.mainMcatOf(c)) {
      const main = this.isqPlan(c);
      if (main.isqs.length) plan = main;
    }
    this.planCache.set(key, plan);
    return plan;
  }

  /** Where a catalogue entry sits: its category and, for a product, its own MCAT (else the category's main one). */
  locateEntry(e: { kind: string; slug: string; category?: string }): { category: string; mcatId: string | null } | null {
    if (e.kind === "product") {
      const p = this.product(e.slug);
      // A product in several categories: the one the entry names, else its main one.
      const cats = p ? this.categoriesOf(p) : [];
      const c = cats.find((x) => x.name === e.category) ?? cats[0];
      if (p && c) return { category: c.name, mcatId: this.mcatOf(p) ?? this.mainMcatOf(c) };
    }
    const c = this.categoryOfEntry(e);
    return c ? { category: c.name, mcatId: this.mainMcatOf(c) } : null;
  }

  /** The seller's own product FAQs (version 5.0), as rows for the per-message FAQ search; answers stating a price are left out. */
  faqs(): { rows: FaqRow[]; priced: number } {
    const rows: FaqRow[] = [];
    let priced = 0;
    for (const p of this.kb.products) {
      const c = this.categoryOf(p);
      for (const f of p.faqs ?? []) {
        if (!f?.question || !f.answer) continue;
        if (PRICE_AMOUNT.test(f.answer)) {
          priced++;
          continue;
        }
        rows.push({ question: f.question.slice(0, 500), answer: f.answer.slice(0, 2000), categories: [c?.name ?? "", this.title(p)].filter(Boolean), product: this.title(p) });
      }
    }
    return { rows, priced };
  }

  /** Products linked to no category (they never get spec questions). */
  looseProducts(): KbProduct[] {
    return this.kb.products.filter((p) => !this.categoryOf(p));
  }

  /** The category a catalogue entry (product or category page) belongs to. */
  categoryOfEntry(e: { kind: string; slug: string; category?: string }): SellerKb["categories"][number] | undefined {
    if (e.kind === "product") {
      const p = this.product(e.slug);
      if (p) return this.categoryOf(p);
    }
    const name = (e.category || "").toLowerCase();
    return name ? this.kb.categories.find((c) => c.name.toLowerCase() === name) : undefined;
  }

  categoryNamed(name: string): SellerKb["categories"][number] | undefined {
    const n = name.toLowerCase();
    return this.kb.categories.find((c) => c.name.toLowerCase() === n);
  }

  /** Categories whose ISQs come from an MCAT, for the admin summary. */
  mcatFilledCategories(): Array<{ category: string; mcat: string }> {
    return this.kb.categories.flatMap((c) => {
      const r = this.isqPlan(c);
      return r.source === "mcat" ? [{ category: c.name, mcat: r.mcat! }] : [];
    });
  }

  /** Every MCAT id in the products' taxonomy. */
  mcatIds(): Set<string> {
    return new Set(this.kb.products.flatMap((p) => [...idsIn(p.taxonomy?.glmcat_ids), ...idsIn(p.taxonomy?.glcat_ids)]));
  }

  private categoryGuide(c: SellerKb["categories"][number], maxProducts: number): string {
    const products = this.productsIn(c);
    const { isqs, mcat, source } = this.isqPlan(c);
    const lines = [`### ${c.name}`];
    const desc = cleanText(c.description);
    if (desc) lines.push(maxProducts === Infinity ? desc : desc.slice(0, 300));
    lines.push(`Products: ${this.productList(products, maxProducts)}`);
    if (isqs.length) {
      lines.push(
        `ISQs${mcat && source === "mcat" ? ` (from MCAT ${mcat})` : ""} (ask one per message, in this order, offering the options with show_options):\n${isqs.map((q, i) => `${i + 1}. ${q.question}? Options: ${q.options.join(" / ")}`).join("\n")}`,
      );
    }
    const others = this.mcatsOf(c).slice(1).filter((m) => m.name);
    if (others.length) lines.push(`Also in this category: ${others.map((m) => `${m.name} (${plural(m.products, "product")})`).join(", ")}. Their own questions come in <spec_questions> when the buyer names one.`);
    return lines.join("\n");
  }

  private productList(products: KbProduct[], max: number): string {
    if (!products.length) return "none listed";
    const shown = products.slice(0, max).map((p) => `${this.title(p)} (${this.slug(p)})`);
    const more = products.length - shown.length;
    if (!more) return shown.join("; ");
    const note = `${shown.length ? `and ${more} more` : plural(more, "product")} (their details come up in the SELLER CATALOGUE when the buyer names them)`;
    return shown.length ? `${shown.join("; ")}; ${note}` : note;
  }

  private guide(maxProducts: number): string {
    const parts = this.kb.categories.map((c) => this.categoryGuide(c, maxProducts));
    const loose = this.kb.products.filter((p) => !this.categoryOf(p));
    if (loose.length) {
      parts.push(`### Other products\nProducts: ${this.productList(loose, maxProducts)}`);
    }
    return parts.join("\n\n") || "No categories listed.";
  }

  private plan?: PromptPlan;

  /**
   * Fits the products into PROMPT_BUDGET: every product in full when it fits ("full"), else the
   * category guide listing every product ("index"), else the guide with fewer products listed per
   * category ("partial"). In the last two, product details come from the per-message catalogue search.
   */
  promptPlan(): PromptPlan {
    if (this.plan) return this.plan;
    const company = this.companyText();
    const budget = PROMPT_BUDGET - company.length - (this.options.reservedChars ?? 0);
    const fullGuide = this.guide(Infinity);
    const full = `# Categories and their ISQs\n\n${fullGuide}\n\n# Products\n\n${this.kb.products.map((p) => this.productText(p)).join("\n\n---\n\n")}`;
    const fullChars = company.length + (this.options.reservedChars ?? 0) + full.length;
    if (full.length <= budget) return (this.plan = { mode: "full", text: full, fullChars });
    const note =
      "This seller's catalogue is large, so only the categories, their ISQs and product names are listed here. The full details (specifications, description, media) of the products that match the buyer's message are given in <seller_catalogue> in each buyer turn. State specifications only from there; if the buyer's product isn't shown, ask for its name or model, or collect the requirement for our team.";
    const compact = (guide: string) => `# Categories and their ISQs\n\n${note}\n\n${guide}`;
    let text = compact(fullGuide);
    if (text.length <= budget) return (this.plan = { mode: "index", text, fullChars });
    for (const n of [500, 200, 100, 50, 20, 8, 3, 0]) {
      text = compact(this.guide(n));
      if (text.length <= budget) break;
    }
    // Very many categories: cut at a category boundary.
    if (text.length > budget) text = `${text.slice(0, Math.max(0, budget - 200)).replace(/\n\n### [^]*$/, "")}\n\n(More categories are not listed here; they come up in the SELLER CATALOGUE.)`;
    return (this.plan = { mode: "partial", text, fullChars });
  }

  productCardsText(): string {
    return this.promptPlan().text;
  }

  systemText(): string {
    return this.companyText() + this.productCardsText();
  }
}

export interface PromptPlan {
  mode: "full" | "index" | "partial";
  text: string;
  /** Size the KB would have in full, for the admin note. */
  fullChars: number;
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
    faqs: view.faqs().rows,
  };
}
