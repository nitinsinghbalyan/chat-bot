/**
 * Extra per-seller files uploaded on /admin, on top of the KB JSON or KB folder:
 *
 * - business_card.md: the seller's policy card as Markdown (Business, Dispatch, GST, Packaging, Must
 *   escalate…), kept as handling rules with amounts and terms removed, added to the BUSINESS CARD.
 * - mcat_specifications.json: IndiaMART MCAT specifications, `[{mcat_id, mcat_name, specifications:
 *   [{name, options, type?}]}]`, generated for the seller's MCAT ids (`type`, when present, is the
 *   ISQ type: key, config or regular). The seller's own specs are asked first, then the MCAT's
 *   specs the seller doesn't carry (see KbView.isqPlan).
 * - product_cards.json: product cards in the KB folder format, added to the PRODUCT CARDS.
 *
 * All three are optional and stored in DATA_DIR/sellers/<slug>/files/.
 */
import { z } from "zod";
import { FORBIDDEN_SPEC_KEYS, splitSentences } from "./crawler.js";
import type { ProductCard } from "./kb.js";

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
  /** The card as the bot sees it: every section kept as handling rules, amounts and terms removed. */
  text: string;
  /** Numbers on "contact" lines: the bot may share these when a buyer asks for a contact. */
  phones: string[];
  /** The "Deals in" list, for matching FAQ rows and MCATs to the seller. */
  dealsIn: string[];
  /** Section headings kept (## …). */
  sections: string[];
  /** Amounts, percentages, payment or delivery terms removed from kept lines. */
  stripped: number;
}

/**
 * Lines that are identity or financial facts, never handling rules: GSTIN, PAN, bank, turnover,
 * staff, ratings, tenure. (A line about GST policy, "GST is charged per quote", is not one of these.)
 */
const IDENTITY_LINE =
  /\b(gstin|gst\s*(no|number|registration)|(pan|cin|iec|tan)\s*(no|number|card)|bank(er|ers)?\b|ifsc|account\s*(no|number)|turnover|revenue|employees?|workforce|staff\s+(strength|of)|\d+\s+staff|ratings?|reviews?|established|establishment|member\s+since|founded|incorporated)\b|\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]{3}\b|^\s*(?:[-*]\s*)?\*\*(gst|gstin|pan|cin|iec|tan|bank|ifsc)\*\*\s*:/i;
/** A phone number or e-mail in a rule (only contact lines may carry them). */
const CONTACT_IN_RULE = /(?:\+?91[\s-]?)?\d[\d\s-]{8,}\d|[\w.+-]+@[\w-]+\.[\w.]+/;
/** Values the bot may never repeat even inside a handling rule (Guardrails 1, 5, 6): money, percentages, delivery durations. */
const AMOUNT =
  /(₹|\brs\.?|\binr\b)\s*[\d,]+(\.\d+)?\s*(lakh|crore|k|\/-)?(\s*(per|\/)\s*\w+)?|\b[\d,]+(\.\d+)?\s*(rupees|lakhs?|crores?|\/-)|\b\d+(\.\d+)?\s*(%|percent|per\s*cent)|\b\d+\s*(-|–|to)\s*\d+\s*(working\s+)?(days?|weeks?|months?|hours?)|\b\d+\s*(working\s+)?(days?|weeks?)\b/gi;
/** Sentences about tenure, turnover, staff or customer counts (Guardrail 7): dropped whole. */
const TENURE =
  /\b(established|founded|incorporated|since\s+(19|20)\d\d|(19|20)\d\d\s+onwards|\d+\s*\+?\s*years?\s+(of\s+)?(experience|in\s+business|old)|decades?\s+of|turnover|revenue|crores?|lakhs?\s+(of\s+)?(customers|buyers|units)|employees?|workforce|staff\s+of|member\s+since|happy\s+customers|\d+\s*\+?\s*(clients|customers))\b/i;
/** Sentences that are payment terms: dropped whole. */
const PAYMENT_TERM = /\b(advance|against\s+delivery|credit\s+period|net\s*\d+|\blc\b|letter\s+of\s+credit|cheque|neft|rtgs|upi|cash\s+on\s+delivery|\bcod\b|pay\s+(before|after|on)\b|balance\s+(before|after|on)\b)/i;

/** Strips amounts, percentages, durations and payment-term sentences from a handling rule. Returns the text and how many values went. */
function scrubRule(line: string): { text: string; removed: number } {
  let removed = 0;
  // "e.g." and "i.e." are not sentence ends.
  const sentences = splitSentences(line.replace(/\b(e\.g|i\.e)\.,?\s*/gi, "$1 ")).filter((sent) => {
    if (PAYMENT_TERM.test(sent) || TENURE.test(sent) || CONTACT_IN_RULE.test(sent)) {
      removed++;
      return false;
    }
    return true;
  });
  const text = sentences
    .join(" ")
    .replace(AMOUNT, () => {
      removed++;
      return "[amount]";
    })
    .replace(/\s+\[amount\](\s*,?\s*(or\s+)?\[amount\])*/g, " [amount]")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { text, removed };
}

/**
 * Reads a seller's policy card (Markdown). Every section is kept as handling rules for the bot
 * ("GST varies per quote: the team confirms"), with identity and financial facts dropped, money,
 * percentages, durations and payment terms removed, and the "Dropped" section (internal notes)
 * left out. Contact lines keep their numbers (the bot may share the listed contact).
 */
export function parseBusinessCardMd(raw: string): ParseResult<BusinessCardMd> {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!text) return { ok: false, errors: ["The file is empty."] };
  if (text.length > SELLER_FILES["business-card"].limit) return { ok: false, errors: [`The file is too long (${text.length.toLocaleString("en-IN")} characters; the limit is 50,000).`] };
  const warnings: string[] = [];
  const phones = new Set<string>();
  const dealsIn: string[] = [];
  const sections: string[] = [];
  const kept: string[] = [];
  let dropped = 0;
  let stripped = 0;
  let skipSection = false;
  for (const line of text.split("\n")) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      skipSection = heading[1].length >= 2 && /^dropped\b/i.test(heading[2]);
      if (skipSection) continue;
      if (heading[1].length >= 2) sections.push(heading[2].trim());
      kept.push(line);
      continue;
    }
    if (skipSection) continue;
    if (!line.trim()) {
      kept.push(line);
      continue;
    }
    if (IDENTITY_LINE.test(line)) {
      dropped++;
      continue;
    }
    const bullet = line.match(/^(\s*(?:[-*]|\d+\.)\s+)(.*)$/);
    const body = bullet ? bullet[2] : line;
    const labelled = body.trim().match(/^\*\*([^*]+)\*\*\s*:\s*(.*)$/);
    if (/contact|phone|mobile|whatsapp|call/i.test(labelled?.[1] ?? body)) {
      for (const m of body.match(/(?:\+?91[\s-]?)?\d[\d\s-]{8,}\d/g) ?? []) {
        const d = m.replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, "");
        if (d.length >= 10 && d.length <= 12) phones.add(d);
      }
      kept.push(line);
      continue;
    }
    if (labelled && /^deals?\s+in$/i.test(labelled[1].trim())) {
      dealsIn.push(...labelled[2].split(/\s*[,;|]\s*/).map((x) => x.trim()).filter(Boolean));
      kept.push(line);
      continue;
    }
    const { text: cleaned, removed } = labelled ? (() => {
      const r = scrubRule(labelled[2]);
      return { text: r.text ? `**${labelled[1]}**: ${r.text}` : "", removed: r.removed };
    })() : scrubRule(body);
    stripped += removed;
    if (!cleaned.trim() || /^\[amount\]\.?$/.test(cleaned.trim())) {
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
  const keptSections = sections.filter((h) => out.includes(`## ${h}`));
  if (dropped) warnings.push(`${dropped} line${dropped === 1 ? "" : "s"} left out: GST numbers, bank, turnover, staff, ratings, tenure and lines that were only an amount or a payment term are never given to the bot.`);
  if (stripped) warnings.push(`${stripped} value${stripped === 1 ? "" : "s"} removed from kept lines (amounts, percentages, delivery durations or payment terms); the rule around each stays.`);
  const lines = out.split("\n").filter((l) => l.trim()).length;
  return {
    ok: true,
    value: { text: out, phones: [...phones], dealsIn, sections: keptSections, stripped },
    summary: `${lines} lines in ${keptSections.length} section${keptSections.length === 1 ? "" : "s"}${keptSections.length ? ` (${keptSections.slice(0, 6).join(", ")}${keptSections.length > 6 ? ", …" : ""})` : ""}${phones.size ? `, contact ${[...phones].join(", ")}` : ""}`,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// MCAT specifications
// ---------------------------------------------------------------------------

export interface McatSpec {
  id: string;
  name: string;
  /** In the file's order (IndiaMART lists an MCAT's specs by importance); `type` when the file marks the ISQ type. */
  specs: Array<{ name: string; options: string[]; type?: "key" | "config" | "regular" }>;
}

/** Identity and money rows are never questions; everything else in the file is a real ISQ (usage, size, warranty, origin included). */
const SPEC_NOT_ASKED = /brand|^make$|model|item\s*code|finance|loan|emi\b/i;
const PRICE_KEY = /price|rate|cost|mrp|discount/i;
/** The most specs kept per MCAT (a conversation asks at most 8). */
const MAX_FILE_SPECS = 8;

const text = z.unknown().transform((v) => (v == null || typeof v === "object" ? "" : String(v).trim()));
const mcatSchema = z.looseObject({
  mcat_id: text.optional(),
  mcat_name: text,
  specifications: z
    .array(z.looseObject({ name: text, options: z.array(z.unknown()).nullish(), type: text.optional(), isq_type: text.optional(), spec_type: text.optional() }))
    .nullish()
    .transform((v) => v ?? []),
});
/** The ISQ type a file row marks, under any of the usual field names and spellings. */
function specType(s: { type?: string; isq_type?: string; spec_type?: string }): McatSpec["specs"][number]["type"] | undefined {
  const t = (s.type || s.isq_type || s.spec_type || "").toLowerCase();
  if (/key|primary/.test(t)) return "key";
  if (/config/.test(t)) return "config";
  if (/regular|normal|secondary/.test(t)) return "regular";
  return undefined;
}
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
      const type = specType(s);
      if (options.length >= 2) specs.push({ name: s.name, options, ...(type ? { type } : {}) });
      else droppedSpecs++;
    }
    out.push({ id: r.data.mcat_id ?? "", name: r.data.mcat_name, specs: specs.slice(0, MAX_FILE_SPECS) });
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

/** Same name once normalised (case, plurals, spacing): "Iron Worker Machines" = "Ironworker Machine". */
export function namesEqual(a: string, b: string): boolean {
  const ca = tokens(a).join("");
  return !!ca && ca === tokens(b).join("");
}

/**
 * The MCAT for a category or card: by MCAT id, else by an exactly equal name. Containment is not
 * enough for spec questions ("Bending Machine" for rebar is not "Metal Sheet Bending Machine").
 */
export function findMcat(mcats: McatSpec[], names: string[], ids: Iterable<string> = []): McatSpec | undefined {
  const idSet = new Set(ids);
  const withSpecs = mcats.filter((m) => m.specs.length);
  return withSpecs.find((m) => m.id && idSet.has(m.id)) ?? withSpecs.find((m) => names.some((n) => namesEqual(m.name, n)));
}

/** The MCATs that match anything the seller deals in (by id or equal name). */
export function matchingMcats(mcats: McatSpec[], terms: SellerTerms): McatSpec[] {
  return mcats.filter((m) => (m.id && terms.mcatIds.has(m.id)) || terms.names.some((n) => namesEqual(m.name, n)));
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
export const idsIn = (s: string | undefined): string[] => (s ?? "").match(/\d+/g) ?? [];
