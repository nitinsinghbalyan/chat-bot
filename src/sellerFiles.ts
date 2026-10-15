/**
 * Extra per-seller files uploaded on /admin, on top of the KB JSON or KB folder:
 *
 * - business_card.md: the seller's business card as Markdown, added to the BUSINESS CARD.
 * - mcat_specifications.json: IndiaMART MCAT specifications, `[{mcat_id, mcat_name, specifications:
 *   [{name, options}]}]`. Only MCATs that match the seller's categories are used, and only to give
 *   ISQs to categories and product cards that have none.
 * - product_cards.json: product cards in the KB folder format, added to the PRODUCT CARDS.
 *
 * All three are optional and stored in DATA_DIR/sellers/<slug>/files/.
 */
import { z } from "zod";
import { FORBIDDEN_SPEC_KEYS } from "./crawler.js";
import type { ProductCard } from "./kb.js";
import { cleanText } from "./sellerKb.js";

export type SellerFileKind = "business-card" | "mcat" | "product-cards";

export const SELLER_FILES: Record<SellerFileKind, { file: string; label: string; format: "text" | "json"; accept: string; limit: number }> = {
  "business-card": { file: "business_card.md", label: "Business card (Markdown)", format: "text", accept: ".md,.markdown,.txt,text/markdown,text/plain", limit: 50_000 },
  mcat: { file: "mcat_specifications.json", label: "MCAT specifications (JSON)", format: "json", accept: ".json,application/json", limit: 10_000_000 },
  "product-cards": { file: "product_cards.json", label: "Product cards (JSON)", format: "json", accept: ".json,application/json", limit: 10_000_000 },
};

export const isSellerFileKind = (k: string): k is SellerFileKind => k in SELLER_FILES;

export type ParseResult<T> = { ok: true; value: T; summary: string; warnings: string[] } | { ok: false; errors: string[] };

// ---------------------------------------------------------------------------
// Business card (Markdown)
// ---------------------------------------------------------------------------

export interface BusinessCardMd {
  text: string;
  /** Numbers on "contact" lines: the bot may share these when a buyer asks for a contact. */
  phones: string[];
}

/** Lines the bot must never see (Guardrails 5-8): GST, bank, turnover, staff, ratings, prices, payment and delivery terms. */
const FORBIDDEN_LINE = /\b(gst|gstin|pan\b|cin\b|iec\b|bank|ifsc|account\s*(no|number)|turnover|revenue|employees?|staff|rating|reviews?|established|year\s+of\s+establishment|price|pricing|payment|delivery\s+time|dispatch|freight)\b/i;

export function parseBusinessCardMd(raw: string): ParseResult<BusinessCardMd> {
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim();
  if (!text) return { ok: false, errors: ["The file is empty."] };
  if (text.length > SELLER_FILES["business-card"].limit) return { ok: false, errors: [`The file is too long (${text.length.toLocaleString("en-IN")} characters; the limit is 50,000).`] };
  const warnings: string[] = [];
  const phones = new Set<string>();
  const kept: string[] = [];
  let dropped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim() || /^#{1,6}\s/.test(line)) {
      kept.push(line);
      continue;
    }
    if (FORBIDDEN_LINE.test(line)) {
      dropped++;
      continue;
    }
    if (/contact|phone|mobile|whatsapp|call/i.test(line)) {
      for (const m of line.match(/(?:\+?91[\s-]?)?\d[\d\s-]{8,}\d/g) ?? []) {
        const d = m.replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, "");
        if (d.length >= 10 && d.length <= 12) phones.add(d);
      }
      kept.push(line);
      continue;
    }
    // Free text goes through the same filter as the KB JSON's company text.
    const bullet = line.match(/^(\s*(?:[-*]|\d+\.)\s+)(.*)$/);
    const body = bullet ? bullet[2] : line;
    // Keep "**Label**: value" rows whole; filter sentences in prose.
    const cleaned = /^\*\*[^*]+\*\*\s*:/.test(body.trim()) ? body : cleanText(body);
    if (!cleaned.trim()) {
      dropped++;
      continue;
    }
    kept.push(bullet ? bullet[1] + cleaned : cleaned);
  }
  const out = kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    // A heading left with nothing under it.
    .replace(/(^|\n)#{1,6} [^\n]*\n*(?=#{1,6} |$)/g, "$1")
    .trim();
  if (!out) return { ok: false, errors: ["Nothing usable is left after removing details the bot may not share."] };
  if (dropped) warnings.push(`${dropped} line${dropped === 1 ? "" : "s"} left out: GST, bank, turnover, staff, ratings, prices, payment or delivery terms are never given to the bot.`);
  return { ok: true, value: { text: out, phones: [...phones] }, summary: `${out.split("\n").filter((l) => l.trim()).length} lines${phones.size ? `, contact ${[...phones].join(", ")}` : ""}`, warnings };
}

// ---------------------------------------------------------------------------
// MCAT specifications
// ---------------------------------------------------------------------------

export interface McatSpec {
  id: string;
  name: string;
  specs: Array<{ name: string; options: string[] }>;
}

const SPEC_NOT_ASKED = /country\s+of\s+origin|brand|make|model|item\s*code|^size$|finance|loan|emi\b|warranty|usage\/application|^usage$|^application$/i;
const PRICE_KEY = /price|rate|cost|mrp|discount/i;

const text = z.unknown().transform((v) => (v == null || typeof v === "object" ? "" : String(v).trim()));
const mcatSchema = z.looseObject({
  mcat_id: text.optional(),
  mcat_name: text,
  specifications: z
    .array(z.looseObject({ name: text, options: z.array(z.unknown()).nullish() }))
    .nullish()
    .transform((v) => v ?? []),
});
const mcatFileSchema = z.union([z.array(z.unknown()), z.looseObject({ mcats: z.array(z.unknown()) }).transform((o) => o.mcats)]);

export function parseMcatSpecs(json: unknown): ParseResult<McatSpec[]> {
  const file = mcatFileSchema.safeParse(json);
  if (!file.success) return { ok: false, errors: ["Expected a list of MCATs: [{\"mcat_id\", \"mcat_name\", \"specifications\": [{\"name\", \"options\": [...]}]}]."] };
  if (file.data.length > 5000) return { ok: false, errors: [`Too many MCATs (${file.data.length}); the limit is 5,000.`] };
  const warnings: string[] = [];
  const out: McatSpec[] = [];
  let skipped = 0;
  let droppedSpecs = 0;
  file.data.forEach((item, i) => {
    const r = mcatSchema.safeParse(item);
    if (!r.success || !r.data.mcat_name) {
      skipped++;
      if (skipped <= 5) warnings.push(`MCAT ${i + 1}: skipped (no mcat_name).`);
      return;
    }
    const specs: McatSpec["specs"] = [];
    for (const s of r.data.specifications) {
      if (!s.name || SPEC_NOT_ASKED.test(s.name) || PRICE_KEY.test(s.name) || FORBIDDEN_SPEC_KEYS.test(s.name)) {
        droppedSpecs++;
        continue;
      }
      const seen = new Set<string>();
      const options = (s.options ?? [])
        .map((o) => (o == null || typeof o === "object" ? "" : String(o).trim()))
        .filter((o) => o && o.length <= 60 && !seen.has(o.toLowerCase()) && seen.add(o.toLowerCase()))
        .slice(0, 8);
      if (options.length >= 2) specs.push({ name: s.name, options });
      else droppedSpecs++;
    }
    out.push({ id: r.data.mcat_id ?? "", name: r.data.mcat_name, specs: specs.slice(0, 6) });
  });
  if (!out.length) return { ok: false, errors: ["No MCATs with a name were found."] };
  if (skipped > 5) warnings.push(`…and ${skipped - 5} more MCATs skipped.`);
  if (droppedSpecs) warnings.push(`${droppedSpecs} specification${droppedSpecs === 1 ? "" : "s"} left out (brand, model, price-like, or fewer than 2 options).`);
  return { ok: true, value: out, summary: `${out.length} MCAT${out.length === 1 ? "" : "s"}`, warnings };
}

// ---------------------------------------------------------------------------
// Product cards
// ---------------------------------------------------------------------------

const cardSchema = z.looseObject({
  product_id: z.union([z.string(), z.number()]).transform((v) => String(v).trim()).pipe(z.string().min(1)),
  canonical_name: z.string().trim().min(1),
  flow: z.looseObject({ markdown: z.string().trim().min(1) }),
});

export function parseProductCards(json: unknown): ParseResult<ProductCard[]> {
  const list = Array.isArray(json) ? json : json && typeof json === "object" && Array.isArray((json as { product_cards?: unknown }).product_cards) ? (json as { product_cards: unknown[] }).product_cards : null;
  if (!list) return { ok: false, errors: ["Expected a list of product cards: [{\"product_id\", \"canonical_name\", \"flow\": {\"markdown\"}}]."] };
  const warnings: string[] = [];
  const cards: ProductCard[] = [];
  const ids = new Set<string>();
  list.forEach((item, i) => {
    const r = cardSchema.safeParse(item);
    if (!r.success) {
      warnings.push(`Card ${i + 1}: skipped (${r.error.issues.map((x) => `${x.path.join(".") || "card"} ${x.message}`).join("; ")}).`);
      return;
    }
    if (ids.has(r.data.product_id)) {
      warnings.push(`Card ${i + 1}: skipped (product_id "${r.data.product_id}" used twice).`);
      return;
    }
    ids.add(r.data.product_id);
    cards.push(r.data as unknown as ProductCard);
  });
  if (!cards.length) return { ok: false, errors: ["No valid product cards.", ...warnings.slice(0, 10)] };
  return { ok: true, value: cards, summary: `${cards.length} product card${cards.length === 1 ? "" : "s"}`, warnings: warnings.slice(0, 25) };
}

// ---------------------------------------------------------------------------
// Matching MCATs (and FAQ categories) to what a seller deals in
// ---------------------------------------------------------------------------

/** "Hydraulic Iron Workers" -> ["hydraulic", "iron", "worker"] -> compact "hydraulicironworker". */
function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => (/(ss|sh|ch|x)es$/.test(w) ? w.slice(0, -2) : /[^s]s$/.test(w) && w.length > 3 ? w.slice(0, -1) : w));
}

/**
 * True when `name` (something the seller deals in) is `general` (an MCAT or FAQ category) or a
 * kind of it: equal once normalised (case, plurals, spacing, so "Iron Worker" = "Ironworker"), or
 * it ends with or contains `general` as a phrase of at least two words ("Metal Sheet Bending
 * Machine" is a "Bending Machine"). Not the other way round: a seller listing "Bending Machine"
 * doesn't make "Bar Bending Machine" theirs.
 */
export function namesMatch(general: string, name: string): boolean {
  const tg = tokens(general);
  const tn = tokens(name);
  if (!tg.length || !tn.length) return false;
  const cg = tg.join("");
  const cn = tn.join("");
  if (cg === cn) return true;
  return tg.length >= 2 && ` ${tn.join(" ")} `.includes(` ${tg.join(" ")} `);
}

/** What a seller deals in, for matching: category names, product card names and aliases, "Deals in", and MCAT ids from the export. */
export interface SellerTerms {
  names: string[];
  mcatIds: Set<string>;
}

export function findMcat(mcats: McatSpec[], names: string[], ids: Iterable<string> = []): McatSpec | undefined {
  const idSet = new Set(ids);
  const withSpecs = mcats.filter((m) => m.specs.length);
  return withSpecs.find((m) => m.id && idSet.has(m.id)) ?? withSpecs.find((m) => names.some((n) => namesMatch(m.name, n)));
}

/** The MCATs that match anything the seller deals in. */
export function matchingMcats(mcats: McatSpec[], terms: SellerTerms): McatSpec[] {
  return mcats.filter((m) => (m.id && terms.mcatIds.has(m.id)) || terms.names.some((n) => namesMatch(m.name, n)));
}

/** The ISQ lines for a card or category, in the same shape the KB JSON's ISQs use. */
export function mcatIsqText(m: McatSpec): string {
  return m.specs.map((s, i) => `${i + 1}. ${s.name}? Options: ${s.options.join(" / ")}`).join("\n");
}

/** True when a product card already has questions to ask (its own ISQs win; MCAT only fills gaps). */
export function cardHasIsqs(card: ProductCard): boolean {
  return !!card.questions?.length || /qualification questions|variant options|ISQs/i.test(card.flow.markdown);
}

/** Adds the matching MCAT's ISQs to cards that have none. Returns new cards and how many were filled. */
export function fillCardIsqs(cards: ProductCard[], mcats: McatSpec[]): { cards: ProductCard[]; filled: string[] } {
  if (!mcats.length) return { cards, filled: [] };
  const filled: string[] = [];
  const out = cards.map((card) => {
    if (cardHasIsqs(card)) return card;
    const names = [card.canonical_name, card.category ?? "", ...(card.aliases ?? []), ...(card.flow.categories ?? [])].filter(Boolean);
    const m = findMcat(mcats, names);
    if (!m) return card;
    filled.push(card.canonical_name);
    const block = `\n\n**Qualification questions (from MCAT ${m.name}; ask one per message, in this order, offering the options with show_options):**\n\n${mcatIsqText(m)}`;
    return { ...card, flow: { ...card.flow, markdown: card.flow.markdown.trimEnd() + block } };
  });
  return { cards: out, filled };
}

/** "Ids" in the export's taxonomy look like ",85037, ,191925,". */
export const idsIn = (s: string | undefined) => (s ?? "").match(/\d+/g) ?? [];
