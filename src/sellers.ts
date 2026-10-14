/**
 * Loads every seller's KB folder (kb/sellers/<slug>/) and builds what each seller's bot and
 * website need: knowledge base, catalogue, cached system prompt and settings.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Catalogue } from "./catalogue.js";
import { paths } from "./config.js";
import { loadKnowledgeBase, sitemapUrls, type KnowledgeBase } from "./kb.js";
import type { SellerPersona } from "./db.js";
import { renderSystemPrompt, sharedGuardrails } from "./prompts.js";

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

const sellerConfigSchema = z
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

const businessCardSchema = z.object({ name: z.string().min(1) }).passthrough();
const productCardsSchema = z.array(
  z.object({ product_id: z.string(), canonical_name: z.string().min(1), flow: z.object({ markdown: z.string() }).passthrough() }).passthrough(),
);

export interface CrawlStatus {
  at: string;
  ok: boolean;
  entries: number;
  message: string;
}

export interface SellerContext {
  config: SellerConfig;
  dir: string;
  kb: KnowledgeBase;
  catalogue: Catalogue;
  systemPrompt: string;
  sitemapFile: string;
  /** Catalogue written by runtime crawls (persistent disk). */
  runtimeCatalogueFile: string;
  /** Catalogue committed in the KB folder, used until the first runtime crawl. */
  bundledCatalogueFile: string;
  /** Guardrails text in force for this seller (shared or their own override). */
  guardrails: string;
  /** Brand persona set in admin: `system` goes into the system prompt, `user` into every buyer turn. */
  persona: SellerPersona;
  /** Number of URLs in the sitemap. */
  sitemapPages: number;
  lastCrawl: CrawlStatus | null;
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

  /** Loads all sellers. Throws with every problem listed if any folder is invalid. */
  static load(root = paths.sellers, dataRoot = paths.sellerData): SellerRegistry {
    const dirs = sellerDirs(root);
    const problems = dirs.flatMap(validateSellerDir);
    if (problems.length) throw new Error(`Invalid seller KB:\n  - ${problems.join("\n  - ")}`);
    const reg = new SellerRegistry();
    const shared = sharedGuardrails();
    for (const dir of dirs) {
      const config = sellerConfigSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, "seller.json"), "utf8")));
      const kb = loadKnowledgeBase(dir, config.siteUrl);
      const override = path.join(dir, "guardrails.md");
      const guardrails = fs.existsSync(override) ? fs.readFileSync(override, "utf8") : shared;
      const runtimeCatalogueFile = path.join(dataRoot, config.slug, "catalogue.json");
      const bundledCatalogueFile = path.join(dir, "catalogue.json");
      const sitemapFile = path.join(dir, "sitemap.xml");
      reg.sellers.set(config.slug, {
        config,
        dir,
        kb,
        catalogue: Catalogue.fromDisk([runtimeCatalogueFile, bundledCatalogueFile]),
        systemPrompt: renderSystemPrompt(kb, guardrails),
        guardrails,
        persona: { system: "", user: "" },
        sitemapFile,
        runtimeCatalogueFile,
        bundledCatalogueFile,
        sitemapPages: sitemapUrls(fs.readFileSync(sitemapFile, "utf8")).length,
        lastCrawl: null,
      });
    }
    return reg;
  }

  /** Applies a brand persona and re-renders that seller's system prompt. */
  setPersona(slug: string, persona: SellerPersona) {
    const s = this.sellers.get(slug);
    if (!s) return;
    s.persona = { system: persona.system.trim(), user: persona.user.trim() };
    s.systemPrompt = renderSystemPrompt(s.kb, s.guardrails, s.persona.system);
  }

  get(slug: string): SellerContext | undefined {
    return this.sellers.get(slug);
  }

  list(): SellerContext[] {
    return [...this.sellers.values()].sort((a, b) => a.config.name.localeCompare(b.config.name));
  }

  get size() {
    return this.sellers.size;
  }
}
