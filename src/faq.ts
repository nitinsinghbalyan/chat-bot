/**
 * The common FAQ: one Excel (or CSV) sheet for all sellers, uploaded on /admin/prompts.
 *
 * Columns: Question, Answer, and optionally Category and Seller. A row with a category applies
 * only to sellers dealing in it (matched like MCATs, see namesMatch); a row with a seller (name,
 * slug or IndiaMART seller id) only to that seller; a row with neither applies to all.
 * "{seller_name}" in a row is replaced with the seller's name. A seller's own product FAQs (KB
 * JSON version 5.0) join its rows. Each buyer message is searched against the seller's rows and
 * the best few go into that turn as <faq>, like the catalogue.
 */
import fs from "node:fs";
import MiniSearch from "minisearch";
import { readSheet } from "read-excel-file/node";
import type { ParseResult, SellerTerms } from "./sellerFiles.js";
import { namesMatch } from "./sellerFiles.js";

export interface FaqRow {
  question: string;
  answer: string;
  /** Categories this row is for (empty = every seller). */
  categories: string[];
  /** Sellers this row is for, as written in the sheet's Seller column (empty = every seller). */
  sellers?: string[];
  /** Set on a seller's own product FAQ (from the KB JSON): the product it is about. */
  product?: string;
}

export interface FaqFile {
  rows: FaqRow[];
  uploadedAt: string;
  format: "xlsx" | "csv";
  summary: string;
  warnings: string[];
}

export const FAQ_LIMIT_BYTES = 10_000_000;
const MAX_ROWS = 5000;

const HEADERS = {
  question: /^(question|questions|faq|faqs|q|query|(gl_)?faq_?question)$/i,
  answer: /^(answer|answers|a|response|reply|(gl_)?faq_?answer)$/i,
  category: /^(category|categories|mcat|mcat name|product|product category|applies to)$/i,
  seller: /^(seller|sellers|seller[ _]?name|company|company[ _]?name|glid|seller[ _]?id)$/i,
};

/** A price amount in an answer: the bot never states prices (Guardrail 1), so such rows are left out. */
export const PRICE_AMOUNT = /(₹|\brs\.?|\binr\b)\s*\d|\d[\d,]*\s*(\/-|rupees|lakh|crore)/i;
/** Topics the guardrails keep the bot away from; rows that mention them are kept but flagged for review. */
const SENSITIVE = /\b(gst|tax|freight|shipping|deliver(y|ed)|dispatch|payment|advance|discount|stock)\b/i;

/** Minimal RFC 4180 CSV parser (quoted fields, doubled quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && !cell) quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const cellText = (v: unknown) => (v == null ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim());

/** Reads an uploaded FAQ: .xlsx (first sheet) or .csv. */
export async function parseFaq(buf: Buffer): Promise<ParseResult<FaqRow[]> & { format?: "xlsx" | "csv" }> {
  if (!buf.length) return { ok: false, errors: ["The file is empty."] };
  if (buf.length > FAQ_LIMIT_BYTES) return { ok: false, errors: ["The file is larger than 10 MB."] };
  const isXlsx = buf[0] === 0x50 && buf[1] === 0x4b; // "PK": a zip, as .xlsx files are
  let table: string[][];
  try {
    table = isXlsx ? ((await readSheet(buf)) as unknown[][]).map((r) => r.map(cellText)) : parseCsv(buf.toString("utf8").replace(/^﻿/, "")).map((r) => r.map(cellText));
  } catch (err) {
    return { ok: false, errors: [`Could not read the ${isXlsx ? "Excel" : "CSV"} file: ${(err as Error).message}. Save it as .xlsx (or .csv) and try again.`] };
  }
  // The header row is the first of the top 5 rows naming a question and an answer column.
  const headerAt = table.slice(0, 5).findIndex((r) => r.some((c) => HEADERS.question.test(c)) && r.some((c) => HEADERS.answer.test(c)));
  if (headerAt < 0) return { ok: false, errors: ['No header row found. The first row should name the columns "Question", "Answer" and (optionally) "Category".'] };
  const header = table[headerAt];
  const col = (re: RegExp) => header.findIndex((c) => re.test(c));
  const [qi, ai, ci, si] = [col(HEADERS.question), col(HEADERS.answer), col(HEADERS.category), col(HEADERS.seller)];
  const rows: FaqRow[] = [];
  const warnings: string[] = [];
  let incomplete = 0;
  const priced: number[] = [];
  const sensitive: number[] = [];
  table.slice(headerAt + 1).forEach((r, i) => {
    const line = headerAt + i + 2;
    const question = r[qi] ?? "";
    const answer = r[ai] ?? "";
    if (!question && !answer) return;
    if (!question || !answer) {
      incomplete++;
      return;
    }
    if (PRICE_AMOUNT.test(answer)) {
      priced.push(line);
      return;
    }
    if (SENSITIVE.test(answer)) sensitive.push(line);
    const categories = ci >= 0 ? (r[ci] ?? "").split(/\s*[,;|\n]\s*/).filter(Boolean) : [];
    const sellers = si >= 0 ? (r[si] ?? "").split(/\s*[,;|\n]\s*/).filter(Boolean) : [];
    rows.push({ question: question.slice(0, 500), answer: answer.slice(0, 2000), categories, ...(sellers.length ? { sellers } : {}) });
  });
  if (!rows.length) return { ok: false, errors: ["No rows with both a question and an answer."] };
  if (rows.length > MAX_ROWS) return { ok: false, errors: [`Too many rows (${rows.length}); the limit is ${MAX_ROWS}.`] };
  const list = (n: number[]) => `${n.slice(0, 10).join(", ")}${n.length > 10 ? ` and ${n.length - 10} more` : ""}`;
  if (incomplete) warnings.push(`${incomplete} row${incomplete === 1 ? "" : "s"} skipped: a question or answer is missing.`);
  if (priced.length) warnings.push(`Row${priced.length === 1 ? "" : "s"} ${list(priced)} left out: the answer states a price, and the bot never quotes prices.`);
  if (sensitive.length) {
    warnings.push(`Row${sensitive.length === 1 ? "" : "s"} ${list(sensitive)} mention tax, delivery, payment, discount or stock. The bot still follows the guardrails, so it won't state those terms; check the wording.`);
  }
  if (ci < 0 && si < 0) warnings.push("No Category or Seller column: every row applies to every seller.");
  const scoped = rows.filter((r) => r.categories.length).length;
  const bySeller = rows.filter((r) => r.sellers?.length).length;
  const sellerNames = [...new Set(rows.flatMap((r) => r.sellers ?? []))];
  if (sellerNames.length) warnings.push(`Rows name ${sellerNames.length} seller${sellerNames.length === 1 ? "" : "s"} (${sellerNames.slice(0, 12).join(", ")}${sellerNames.length > 12 ? ", …" : ""}); each is matched to a seller here by name, slug or IndiaMART seller id.`);
  return {
    ok: true,
    value: rows,
    format: isXlsx ? "xlsx" : "csv",
    summary: `${rows.length} question${rows.length === 1 ? "" : "s"}${bySeller ? `, ${bySeller} for specific sellers` : ""}${scoped ? `, ${scoped} for specific categories` : ""}`,
    warnings,
  };
}

/** Who a seller is, for the sheet's Seller column: name, URL slug and IndiaMART seller id (glid). */
export interface SellerIdentity {
  name: string;
  slug?: string;
  sellerId?: string;
}

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** "Exoticasteel" names "Exotica Steel (India)"; "1952135" names seller id 1952135; a slug names itself. */
export function sellerNamed(cell: string, who: SellerIdentity): boolean {
  const c = compact(cell);
  if (!c) return false;
  if (/^\d+$/.test(c)) return !!who.sellerId && c === compact(who.sellerId);
  for (const own of [who.name, who.slug ?? ""].map(compact).filter(Boolean)) {
    if (own === c) return true;
    // One is the start of the other: "exoticasteel" ~ "exoticasteelindia", "sewaenterprisesnewdelhi" ~ "sewaenterprises".
    if (c.length >= 6 && own.length >= 6 && (own.startsWith(c) || c.startsWith(own))) return true;
  }
  return false;
}

/** Rows for one seller: unscoped rows, rows naming this seller, and rows whose category matches what the seller deals in. */
export function faqRowsFor(rows: FaqRow[], terms: SellerTerms & { mcats?: string[] }, sellerName: string, who: SellerIdentity = { name: sellerName }): FaqRow[] {
  const names = [...terms.names, ...(terms.mcats ?? [])];
  const fillName = (t: string) => t.replace(/\{\{?\s*(seller_name|seller|company|company_name)\s*\}?\}/gi, sellerName);
  return rows
    .filter((r) => (r.sellers?.length ? r.sellers.some((s) => sellerNamed(s, who)) : true))
    .filter((r) => !r.categories.length || r.sellers?.length || r.categories.some((c) => names.some((n) => namesMatch(c, n))))
    .map((r) => ({ ...r, question: fillName(r.question), answer: fillName(r.answer) }));
}

/** Seller names in the sheet that match none of the sellers here (sellers not added yet, or spelt differently). */
export function unknownSellerNames(rows: FaqRow[], sellers: SellerIdentity[]): string[] {
  const names = [...new Set(rows.flatMap((r) => r.sellers ?? []))];
  return names.filter((n) => !sellers.some((s) => sellerNamed(n, s)));
}

/** Words that say nothing about the topic ("do you…", "what is the…"), in English and common Hinglish. */
const STOPWORDS = new Set(
  "a an the is are was were be been am do does did you your yours we our us i me my mine it its this that these those of for to in on at by with from and or not no yes can could will would shall should may might have has had what which who whom whose how when where why any some there here please sir madam ji hai hain kya ka ki ke ko se me mein aap hum tum bhi".split(" "),
);
/** Light stemming so "installation", "installed" and "installs" all find "install". */
const stem = (t: string) =>
  t.length <= 4
    ? t
    : t
        .replace(/sses$/, "ss")
        .replace(/(ations?|ings?)$/, "")
        .replace(/(?<=..)ed$/, "")
        .replace(/(?<!s)s$/, "");
const processTerm = (term: string) => {
  const t = term.toLowerCase();
  return t.length < 2 || STOPWORDS.has(t) ? null : stem(t);
};

/** Search over one seller's FAQ rows. */
export class FaqIndex {
  private index = new MiniSearch<FaqRow & { id: number }>({
    fields: ["question", "answer"],
    storeFields: ["id"],
    processTerm,
    searchOptions: { boost: { question: 3 }, fuzzy: 0.2, prefix: true, combineWith: "OR", processTerm },
  });

  constructor(readonly rows: FaqRow[]) {
    this.index.addAll(rows.map((r, id) => ({ ...r, id })));
  }

  get size() {
    return this.rows.length;
  }

  /** The best `k` rows for a message; weak matches (under 35% of the best, or a single short word) are dropped. */
  search(q: string, k = 3): FaqRow[] {
    const hits = this.index.search(q).filter((h) => h.queryTerms.some((t) => t.length > 3) || h.queryTerms.length > 1);
    if (!hits.length) return [];
    const best = hits[0].score;
    return hits
      .filter((h) => h.score >= best * 0.35)
      .slice(0, k)
      .map((h) => this.rows[h.id as number]);
  }
}

/** The FAQ rows that matched this message, for the <faq> block. A seller's product FAQ names its product. */
export function formatFaqHits(rows: FaqRow[]): string {
  return rows.map((r) => `Q${r.product ? ` (about ${r.product})` : ""}: ${r.question}\nA: ${r.answer}`).join("\n\n");
}

/**
 * The FAQ in use, with one search index per seller (rebuilt when the FAQ or the seller's
 * knowledge changes). Stored as DATA_DIR/faq.xlsx or faq.csv.
 */
export class FaqStore {
  file: FaqFile | null = null;
  private indexes = new WeakMap<object, { version: number; index: FaqIndex }>();
  private version = 0;

  constructor(readonly dir: string) {}

  static async load(dir: string): Promise<FaqStore> {
    const store = new FaqStore(dir);
    for (const format of ["xlsx", "csv"] as const) {
      const file = store.pathFor(format);
      if (!fs.existsSync(file)) continue;
      const r = await parseFaq(fs.readFileSync(file));
      if (r.ok) {
        store.set({ rows: r.value, uploadedAt: fs.statSync(file).mtime.toISOString(), format, summary: r.summary, warnings: r.warnings });
        break;
      }
      console.error(`[faq] ignoring ${file}: ${r.errors.join("; ")}`);
    }
    return store;
  }

  pathFor(format: "xlsx" | "csv") {
    return `${this.dir}/faq.${format}`;
  }

  set(file: FaqFile | null) {
    this.file = file;
    this.version++;
  }

  /**
   * The index for a seller: the sheet's rows for them plus their own product FAQs (`own`). `key` is
   * the seller's current knowledge object, so a KB change rebuilds it. Null when there is nothing.
   */
  forSeller(key: object, terms: SellerTerms & { mcats?: string[] }, sellerName: string, own: { rows?: FaqRow[]; slug?: string; sellerId?: string } = {}): FaqIndex | null {
    if (!this.file && !own.rows?.length) return null;
    const hit = this.indexes.get(key);
    if (hit && hit.version === this.version) return hit.index;
    const sheet = this.file ? faqRowsFor(this.file.rows, terms, sellerName, { name: sellerName, slug: own.slug, sellerId: own.sellerId }) : [];
    const index = new FaqIndex([...(own.rows ?? []), ...sheet]);
    this.indexes.set(key, { version: this.version, index });
    return index;
  }
}
