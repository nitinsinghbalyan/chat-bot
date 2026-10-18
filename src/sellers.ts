/**
 * Loads every seller's KB folder (kb/sellers/<slug>/) and builds what each seller's bot and
 * website need: knowledge base, catalogue, cached system prompt and settings.
 */
import fs from "node:fs";
import path from "node:path";
import { buildMapping, type KnowledgeMapping } from "./mapping.js";
import { z } from "zod";
import { Catalogue } from "./catalogue.js";
import type { CatalogueEntry } from "./crawler.js";
import { paths } from "./config.js";
import { loadKnowledgeBase, renderProductCard, sitemapUrls, type KnowledgeBase, type ProductCard } from "./kb.js";
import type { SellerPersona } from "./db.js";
import { defaultSystemTemplate, renderSystemPrompt, sharedGuardrails } from "./prompts.js";
import { KbView, knowledgeFromKb, validateSellerKb, type KbSummary, type SellerKb } from "./sellerKb.js";
import {
  fillCardIsqs,
  matchingMcats,
  parseBusinessCardMd,
  parseMcatSpecs,
  parseProductCards,
  SELLER_FILES,
  type BusinessCardMd,
  type McatSpec,
  type ParseResult,
  type SellerFileKind,
  type SellerTerms,
} from "./sellerFiles.js";

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

export const sellerConfigSchema = z
  .object({
    name: z.string().min(2).max(120),
    slug: z.string().regex(SLUG_RE, "use lowercase letters, digits and dashes"),
    siteUrl: z.string().url(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "use a 6-digit hex colour like #0b5cad")
      .default("#0b5cad"),
    logoUrl: z.string().url().optional(),
    /** Websites allowed to embed this seller's bot, e.g. ["https://www.example.in"]. */
    allowedOrigins: z.array(z.string().url()).default([]),
    greeting: z.string().max(300).optional(),
    chips: z.array(z.string().min(1).max(40)).max(6).optional(),
    /** Which bottom corner the chat bubble sits in. */
    widgetPosition: z.enum(["right", "left"]).default("right"),
    /** One line under the company name on the home page. */
    tagline: z.string().max(200).optional(),
    /** About Us text (paragraphs separated by blank lines). Keep it to verified BUSINESS CARD facts (Guardrail 7). */
    about: z.string().max(3000).optional(),
  })
  .strict();

export type SellerConfig = z.infer<typeof sellerConfigSchema>;

/** kb/sellers/<slug>/persona.json: the seller's default brand persona. */
const personaSchema = z
  .object({ system: z.string().max(4000).default(""), user: z.string().max(2000).default("") })
  .strict()
  .transform((p) => ({ system: p.system.trim(), user: p.user.trim() }));

const businessCardSchema = z.object({ name: z.string().min(1) }).passthrough();
const productCardsSchema = z.array(
  z.object({ product_id: z.string(), canonical_name: z.string().min(1), flow: z.object({ markdown: z.string() }).passthrough() }).passthrough(),
);

export interface CrawlStatus {
  at: string;
  /** ok: catalogue replaced; partial: too few pages fetched, previous kept; failed: nothing fetched or an error. */
  status: "ok" | "partial" | "failed";
  ok: boolean;
  entries: number;
  message: string;
}

export interface UploadedKb {
  view: KbView;
  uploadedAt: string;
  summary: KbSummary;
}

/** One extra file uploaded on /admin (see src/sellerFiles.ts). */
export interface SellerFile<T> {
  value: T;
  uploadedAt: string;
  summary: string;
  warnings: string[];
}

export interface SellerFiles {
  businessCard?: SellerFile<BusinessCardMd>;
  mcat?: SellerFile<McatSpec[]>;
  productCards?: SellerFile<ProductCard[]>;
}

/** How the MCAT file was used for this seller, for the admin page. */
export interface McatUse {
  /** MCATs that match something the seller deals in. */
  matched: string[];
  /** Categories and product cards that got their ISQs from an MCAT ("Iron Worker Machine ← Ironworker Machine"). */
  filled: string[];
}

export interface SellerContext {
  config: SellerConfig;
  /** repo: a folder under kb/sellers/ (committed). admin: added on /admin, stored on the data disk. */
  source: "repo" | "admin";
  /** The seller's folder: kb/sellers/<slug> for repo sellers, DATA_DIR/sellers/<slug> for admin ones. */
  dir: string;
  /** This seller's folder on the data disk (crawls, uploaded KB; everything for admin sellers). */
  dataDir: string;
  /** The knowledge the bot uses: the uploaded KB JSON when there is one, else the KB folder's files. */
  kb: KnowledgeBase;
  /** The KB folder's business card and product cards (used when no JSON is uploaded). */
  fileKb: KnowledgeBase;
  /** The uploaded seller KB JSON, if any. Admin-added sellers always have one. */
  uploaded: UploadedKb | null;
  /** Where an uploaded KB JSON is stored (persistent disk). */
  uploadedKbFile: string;
  /** Website and retrieval catalogue: the KB JSON's products and categories first, crawled pages filling gaps. */
  catalogue: Catalogue;
  /** Pages from the last good crawl (runtime file, else the committed one). */
  crawled: CatalogueEntry[];
  crawledAt: Date | null;
  systemPrompt: string;
  /** URLs from the KB folder's sitemap.xml (empty for admin-added sellers). */
  sitemapList: string[];
  /** Catalogue written by runtime crawls (persistent disk). */
  runtimeCatalogueFile: string;
  /** Catalogue committed in the KB folder, used until the first runtime crawl (repo sellers only). */
  bundledCatalogueFile: string | null;
  /** The seller's own guardrails.md, which replaces the common guardrails; null = use the common ones. */
  ownGuardrails: string | null;
  /** Default brand persona from the KB folder's persona.json (used until one is saved in admin). */
  defaultPersona: SellerPersona;
  /** Brand persona set in admin: `system` goes into the system prompt, `user` into every buyer turn. */
  persona: SellerPersona;
  /** Number of pages the crawler visits: the sitemap's, else the KB JSON's product and category pages. */
  sitemapPages: number;
  lastCrawl: CrawlStatus | null;
  /** Extra files uploaded on /admin: business card (md), MCAT specifications, product cards. */
  files: SellerFiles;
  /** Where those files are stored: DATA_DIR/sellers/<slug>/files. */
  filesDir: string;
  mcatUse: McatUse;
  terms: SellerTerms;
  /** How the KB JSON, MCAT file, product cards, FAQs and policy card join up (KB JSON sellers only). */
  mapping: KnowledgeMapping | null;
}

function readJsonFile(file: string, errors: string[]): unknown {
  if (!fs.existsSync(file)) {
    errors.push(`${file}: missing`);
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    errors.push(`${file}: not valid JSON (${(err as Error).message})`);
    return undefined;
  }
}

function zodErrors(file: string, result: z.ZodSafeParseResult<unknown>, errors: string[]) {
  if (!result.success) for (const issue of result.error.issues) errors.push(`${file}: ${issue.path.join(".") || "(root)"} ${issue.message}`);
}

/** Checks one seller folder. Returns a list of problems, empty when the folder is valid. */
export function validateSellerDir(dir: string): string[] {
  const errors: string[] = [];
  const folder = path.basename(dir);
  const cfgFile = path.join(dir, "seller.json");
  const cfg = readJsonFile(cfgFile, errors);
  if (cfg !== undefined) {
    const parsed = sellerConfigSchema.safeParse(cfg);
    zodErrors(cfgFile, parsed, errors);
    if (parsed.success && parsed.data.slug !== folder) errors.push(`${cfgFile}: slug "${parsed.data.slug}" must match the folder name "${folder}"`);
  }
  const bcFile = path.join(dir, "business_card.json");
  const bc = readJsonFile(bcFile, errors);
  if (bc !== undefined) zodErrors(bcFile, businessCardSchema.safeParse(bc), errors);
  const pcFile = path.join(dir, "product_cards.json");
  const pc = readJsonFile(pcFile, errors);
  if (pc !== undefined) zodErrors(pcFile, productCardsSchema.safeParse(pc), errors);
  const personaFile = path.join(dir, "persona.json");
  if (fs.existsSync(personaFile)) {
    const persona = readJsonFile(personaFile, errors);
    if (persona !== undefined) zodErrors(personaFile, personaSchema.safeParse(persona), errors);
  }
  const smFile = path.join(dir, "sitemap.xml");
  if (!fs.existsSync(smFile)) errors.push(`${smFile}: missing`);
  else if (sitemapUrls(fs.readFileSync(smFile, "utf8")).length === 0) errors.push(`${smFile}: no <loc> URLs found`);
  return errors;
}

export function sellerDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  // statSync follows symlinks, so symlinked seller folders count too.
  return fs
    .readdirSync(root)
    .filter((name) => !name.startsWith(".") && fs.statSync(path.join(root, name)).isDirectory())
    .map((name) => path.join(root, name))
    .sort();
}

export class SellerRegistry {
  private sellers = new Map<string, SellerContext>();
  private dataRoot = paths.sellerData;

  /**
   * Loads all sellers: every KB folder under `root`, plus sellers added on /admin (folders under
   * `dataRoot` with their own seller.json). Throws with every problem listed if a KB folder is invalid.
   */
  static load(root = paths.sellers, dataRoot = paths.sellerData): SellerRegistry {
    const dirs = sellerDirs(root);
    const problems = dirs.flatMap(validateSellerDir);
    if (problems.length) throw new Error(`Invalid seller KB:\n  - ${problems.join("\n  - ")}`);
    const reg = new SellerRegistry();
    reg.dataRoot = dataRoot;
    for (const dir of dirs) {
      const config = sellerConfigSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, "seller.json"), "utf8")));
      const kb = loadKnowledgeBase(dir, config.siteUrl);
      const override = path.join(dir, "guardrails.md");
      const personaFile = path.join(dir, "persona.json");
      const sitemapList = sitemapUrls(fs.readFileSync(path.join(dir, "sitemap.xml"), "utf8"));
      const s = reg.context(config, "repo", dir, kb, {
        ownGuardrails: fs.existsSync(override) ? fs.readFileSync(override, "utf8") : null,
        defaultPersona: fs.existsSync(personaFile) ? personaSchema.parse(JSON.parse(fs.readFileSync(personaFile, "utf8"))) : { system: "", user: "" },
        sitemapList,
        bundledCatalogueFile: path.join(dir, "catalogue.json"),
      });
      // An uploaded KB on the persistent disk wins; a seller_kb.json committed in the KB folder is the fallback.
      for (const file of [s.uploadedKbFile, path.join(dir, "seller_kb.json")]) {
        const kbJson = readKbFile(file, config.slug);
        if (kbJson) {
          reg.setUploadedKb(config.slug, kbJson, fs.statSync(file).mtime.toISOString());
          break;
        }
      }
    }
    // Sellers added on /admin: their whole folder lives on the data disk.
    for (const dir of sellerDirs(dataRoot)) {
      const cfgFile = path.join(dir, "seller.json");
      if (!fs.existsSync(cfgFile)) continue;
      try {
        const config = sellerConfigSchema.parse(JSON.parse(fs.readFileSync(cfgFile, "utf8")));
        if (config.slug !== path.basename(dir)) throw new Error(`slug "${config.slug}" does not match the folder`);
        if (reg.sellers.has(config.slug)) continue; // a KB folder in the repo wins
        const kbFile = path.join(dir, "seller_kb.json");
        const kbJson = readKbFile(kbFile, config.slug);
        if (!kbJson) throw new Error("no valid seller_kb.json");
        reg.addSeller(config, kbJson, fs.statSync(kbFile).mtime.toISOString());
      } catch (err) {
        console.error(`[sellers] skipping ${dir}: ${(err as Error).message}`);
      }
    }
    return reg;
  }

  private context(
    config: SellerConfig,
    source: SellerContext["source"],
    dir: string,
    kb: KnowledgeBase,
    extra: { ownGuardrails: string | null; defaultPersona: SellerPersona; sitemapList: string[]; bundledCatalogueFile: string | null },
  ): SellerContext {
    const dataDir = path.join(this.dataRoot, config.slug);
    const runtimeCatalogueFile = path.join(dataDir, "catalogue.json");
    const crawled = readCatalogueFiles([runtimeCatalogueFile, ...(extra.bundledCatalogueFile ? [extra.bundledCatalogueFile] : [])]);
    const s: SellerContext = {
      config,
      source,
      dir,
      dataDir,
      kb,
      fileKb: kb,
      uploaded: null,
      uploadedKbFile: path.join(dataDir, "seller_kb.json"),
      catalogue: new Catalogue(),
      crawled: crawled.entries,
      crawledAt: crawled.at,
      systemPrompt: "",
      sitemapList: extra.sitemapList,
      runtimeCatalogueFile,
      bundledCatalogueFile: extra.bundledCatalogueFile,
      ownGuardrails: extra.ownGuardrails,
      defaultPersona: extra.defaultPersona,
      persona: extra.defaultPersona,
      sitemapPages: extra.sitemapList.length,
      lastCrawl: null,
      files: {},
      filesDir: path.join(dataDir, "files"),
      mcatUse: { matched: [], filled: [] },
      terms: { names: [], mcatIds: new Set() },
      mapping: null,
    };
    s.files = readSellerFiles(s.filesDir, config.slug);
    this.sellers.set(config.slug, s);
    this.compose(s);
    return s;
  }

  /**
   * Adds (or replaces) a seller defined only by its settings and KB JSON, as created on /admin.
   * The caller stores seller.json and seller_kb.json in DATA_DIR/sellers/<slug>/.
   */
  addSeller(config: SellerConfig, kb: SellerKb, uploadedAt = new Date().toISOString()): SellerContext {
    const view = new KbView(kb);
    const host = (() => {
      try {
        return new URL(config.siteUrl).hostname.replace(/^www\./, "");
      } catch {
        return null;
      }
    })();
    const base: KnowledgeBase = {
      businessCard: { name: config.name },
      productCards: [],
      businessCardText: `Name: ${config.name}`,
      productCardsText: "",
      faqs: [],
      allowedPhones: [],
      allowedDomains: host ? [host] : [],
    };
    const fileKb = knowledgeFromKb(view, base);
    const s = this.context(config, "admin", path.join(this.dataRoot, config.slug), fileKb, { ownGuardrails: null, defaultPersona: { system: "", user: "" }, sitemapList: [], bundledCatalogueFile: null });
    this.setUploadedKb(config.slug, kb, uploadedAt);
    return s;
  }

  /** DATA_DIR/sellers: where admin-added sellers and runtime files live. */
  dataRootDir(): string {
    return this.dataRoot;
  }

  /** Forgets a seller (the caller removes its files). */
  removeSeller(slug: string) {
    this.sellers.delete(slug);
  }

  /** Makes an uploaded KB (or, with null, the KB folder's files) the seller's knowledge, and re-renders the prompt. */
  setUploadedKb(slug: string, kb: SellerKb | null, uploadedAt = new Date().toISOString()) {
    const s = this.sellers.get(slug);
    if (!s) return;
    if (kb) {
      const view = new KbView(kb);
      s.uploaded = { view, uploadedAt, summary: view.summary() };
      s.sitemapPages = s.sitemapList.length || view.pageUrls().length;
    } else {
      s.uploaded = null;
      s.sitemapPages = s.sitemapList.length;
    }
    this.compose(s);
  }

  /** Sets (or with null removes) one extra file and rebuilds the seller's knowledge. The caller stores the file. */
  setSellerFile(slug: string, kind: SellerFileKind, file: SellerFile<unknown> | null) {
    const s = this.sellers.get(slug);
    if (!s) return;
    const key = FILE_KEYS[kind];
    if (file) (s.files as Record<string, unknown>)[key] = file;
    else delete s.files[key];
    this.compose(s);
  }

  /**
   * Builds the knowledge the bot uses from the KB JSON (or KB folder) plus the extra files, which
   * are merged in: the business card .md is added to the business card, uploaded product cards to
   * the product cards (for a KB-folder seller they replace the folder's cards), and the MCAT file
   * gives ISQs to categories and cards that have none. Then re-renders the prompt and catalogue.
   */
  private compose(s: SellerContext) {
    const mcats = s.files.mcat?.value ?? [];
    const md = s.files.businessCard?.value;
    const uploadedCards = s.files.productCards?.value ?? [];
    const mdText = md ? `\n\n## Seller policy card (how to handle these topics)\n\nHandling rules from the seller's team. Where a rule says the team must confirm, say exactly that and pass the question on. Never state amounts, percentages, payment or delivery terms, even where "[amount]" marks one that was removed.\n\n${md.text}` : "";
    const filled: string[] = [];
    const fill = (cards: ProductCard[]) => {
      const r = fillCardIsqs(cards, mcats);
      filled.push(...r.filled.map((n) => `${n} (product card)`));
      return r.cards;
    };
    let kb: KnowledgeBase;
    if (s.uploaded) {
      const extra = fill(uploadedCards);
      const extraText = extra.length ? `\n\n# Product cards (uploaded)\n\n${extra.map(renderProductCard).join("\n\n---\n\n")}` : "";
      const view = new KbView(s.uploaded.view.kb, { mcats, reservedChars: mdText.length + extraText.length });
      s.uploaded.view = view;
      filled.push(...view.mcatFilledCategories().map((f) => `${f.category} (from MCAT ${f.mcat})`));
      const fromJson = knowledgeFromKb(view, s.fileKb);
      kb = { ...fromJson, productCards: [...fromJson.productCards, ...extra], productCardsText: fromJson.productCardsText + extraText };
      s.mapping = buildMapping(view, { mcats, mcatUploaded: !!s.files.mcat, cards: uploadedCards, policyCard: md ?? null }, view.faqs());
    } else {
      // The same kind of file as the KB folder's product_cards.json: the uploaded copy replaces it.
      const cards = fill(uploadedCards.length ? uploadedCards : s.fileKb.productCards);
      kb = { ...s.fileKb, productCards: cards, productCardsText: cards.map(renderProductCard).join("\n\n---\n\n") };
      s.mapping = null;
    }
    kb.businessCardText += mdText;
    if (md?.phones.length) kb.allowedPhones = [...new Set([...kb.allowedPhones, ...md.phones])];
    s.kb = kb;
    s.terms = {
      names: [
        ...new Set([
          ...(s.uploaded?.view.kb.categories.map((c) => c.name) ?? []),
          ...(kb.businessCard.deals_in ?? []),
          ...(md?.dealsIn ?? []),
          ...kb.productCards.flatMap((c) => [c.canonical_name, c.category ?? "", ...(c.aliases ?? []), ...(c.flow.categories ?? [])]),
        ]),
      ].filter(Boolean),
      mcatIds: s.uploaded?.view.mcatIds() ?? new Set(),
    };
    s.mcatUse = { matched: matchingMcats(mcats, s.terms).map((m) => m.name), filled };
    this.rebuildCatalogue(s);
    this.render(s);
  }

  /** Swaps in a fresh crawl and rebuilds the website catalogue. */
  setCrawled(slug: string, entries: CatalogueEntry[], at = new Date()) {
    const s = this.sellers.get(slug);
    if (!s) return;
    s.crawled = entries;
    s.crawledAt = at;
    this.rebuildCatalogue(s);
  }

  /** Pages the crawler should visit: the sitemap, else the KB JSON's product and category pages. */
  crawlUrls(s: SellerContext): string[] {
    return s.sitemapList.length ? s.sitemapList : (s.uploaded?.view.pageUrls() ?? []);
  }

  private rebuildCatalogue(s: SellerContext) {
    const fromKb = s.uploaded?.view.catalogueEntries() ?? [];
    const kbAt = s.uploaded ? new Date(s.uploaded.uploadedAt) : null;
    const times = [kbAt, s.crawledAt].filter((d): d is Date => !!d && !isNaN(d.getTime()));
    const updatedAt = times.length ? new Date(Math.max(...times.map((d) => d.getTime()))) : null;
    s.catalogue.load(mergeCatalogue(fromKb, s.crawled), updatedAt);
  }

  /** The common system prompt template and guardrails, shared by every seller. */
  common = { system: defaultSystemTemplate(), guardrails: sharedGuardrails() };

  /** Replaces the common system prompt and/or guardrails (undefined = file default) and re-renders every seller. */
  setCommonPrompts(p: { system?: string | null; guardrails?: string | null }) {
    if (p.system !== undefined) this.common.system = p.system ?? defaultSystemTemplate();
    if (p.guardrails !== undefined) this.common.guardrails = (p.guardrails ?? sharedGuardrails()).trim();
    for (const s of this.sellers.values()) this.render(s);
  }

  /** Guardrails in force for a seller: their own guardrails.md, else the common ones. */
  guardrailsFor(s: SellerContext): string {
    return s.ownGuardrails ?? this.common.guardrails;
  }

  private render(s: SellerContext) {
    s.systemPrompt = renderSystemPrompt(s.kb, this.guardrailsFor(s), s.persona.system, this.common.system);
  }

  /** Applies a brand persona and re-renders that seller's system prompt. */
  setPersona(slug: string, persona: SellerPersona) {
    const s = this.sellers.get(slug);
    if (!s) return;
    s.persona = { system: persona.system.trim(), user: persona.user.trim() };
    this.render(s);
  }

  get(slug: string): SellerContext | undefined {
    return this.sellers.get(slug);
  }

  has(slug: string): boolean {
    return this.sellers.has(slug);
  }

  list(): SellerContext[] {
    return [...this.sellers.values()].sort((a, b) => a.config.name.localeCompare(b.config.name));
  }

  get size() {
    return this.sellers.size;
  }
}

const FILE_KEYS = { "business-card": "businessCard", mcat: "mcat", "product-cards": "productCards" } as const;

/** Parses an uploaded extra file (raw text as uploaded). */
export function parseSellerFile(kind: SellerFileKind, raw: string): ParseResult<unknown> {
  if (SELLER_FILES[kind].format === "text") return parseBusinessCardMd(raw);
  let json: unknown;
  try {
    json = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (err) {
    return { ok: false, errors: [`Not valid JSON: ${(err as Error).message}`] };
  }
  return kind === "mcat" ? parseMcatSpecs(json) : parseProductCards(json);
}

/** Reads the extra files stored for a seller; a file that no longer parses is logged and skipped. */
function readSellerFiles(dir: string, slug: string): SellerFiles {
  const files: SellerFiles = {};
  for (const kind of Object.keys(SELLER_FILES) as SellerFileKind[]) {
    const file = path.join(dir, SELLER_FILES[kind].file);
    if (!fs.existsSync(file)) continue;
    const r = parseSellerFile(kind, fs.readFileSync(file, "utf8"));
    if (!r.ok) {
      console.error(`[files:${slug}] ignoring ${file}: ${r.errors.slice(0, 3).join("; ")}`);
      continue;
    }
    (files as Record<string, unknown>)[FILE_KEYS[kind]] = { value: r.value, uploadedAt: fs.statSync(file).mtime.toISOString(), summary: r.summary, warnings: r.warnings };
  }
  return files;
}

function readKbFile(file: string, slug: string): SellerKb | null {
  if (!fs.existsSync(file)) return null;
  try {
    const result = validateSellerKb(JSON.parse(fs.readFileSync(file, "utf8")));
    if (!result.ok) throw new Error(result.errors.slice(0, 5).join("; "));
    return result.kb;
  } catch (err) {
    console.error(`[kb:${slug}] ignoring ${file}: ${(err as Error).message}`);
    return null;
  }
}

/** The first non-empty catalogue file (runtime crawl first, then the committed one). */
function readCatalogueFiles(files: string[]): { entries: CatalogueEntry[]; at: Date | null } {
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    try {
      const entries = JSON.parse(fs.readFileSync(file, "utf8")) as CatalogueEntry[];
      if (entries.length) return { entries, at: fs.statSync(file).mtime };
    } catch (err) {
      console.error(`[catalogue] ignoring ${file}: ${(err as Error).message}`);
    }
  }
  return { entries: [], at: null };
}

/** Same page regardless of http/https, www. or a trailing slash. */
export function pageKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "").toLowerCase()}${u.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return url;
  }
}

const unionBy = <T>(a: T[], b: T[], key: (x: T) => string) => {
  const seen = new Set(a.map(key));
  return [...a, ...b.filter((x) => !seen.has(key(x)) && seen.add(key(x)))];
};

/**
 * KB JSON entries first; for the same page, empty fields are filled from the crawl. Crawled pages
 * the JSON doesn't have are added after.
 */
export function mergeCatalogue(fromKb: CatalogueEntry[], crawled: CatalogueEntry[]): CatalogueEntry[] {
  const byKey = new Map(crawled.map((e) => [pageKey(e.url), e]));
  const merged = fromKb.map((k) => {
    const c = byKey.get(pageKey(k.url));
    if (!c) return k;
    byKey.delete(pageKey(k.url));
    return {
      ...k,
      price_text: k.price_text ?? c.price_text,
      specs: Object.keys(k.specs).length ? k.specs : c.specs,
      description: k.description || c.description,
      details: k.details || c.details,
      features: k.features.length ? k.features : c.features,
      image: k.image ?? c.image,
      images: unionBy(k.images, c.images ?? [], (x) => x),
      videos: unionBy(k.videos, c.videos ?? [], (x) => x.url),
      documents: unionBy(k.documents, c.documents ?? [], (x) => x.url),
      breadcrumbs: k.breadcrumbs.length ? k.breadcrumbs : c.breadcrumbs,
      products: unionBy(k.products, c.products ?? [], (x) => pageKey(x.url)),
    };
  });
  return [...merged, ...byKey.values()];
}
