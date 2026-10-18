/**
 * The knowledge mapping report for one seller: how the master JSON, the MCAT specifications file,
 * the product cards, the FAQs and the policy card join up, and what didn't. Shown on /admin
 * (Manage → Knowledge mapping) and served as JSON, so each seller's bot can be audited.
 */
import type { FaqRow } from "./faq.js";
import type { ProductCard } from "./kb.js";
import type { BusinessCardMd, McatSpec } from "./sellerFiles.js";
import { namesEqual, namesMatch } from "./sellerFiles.js";
import type { Isq, KbView } from "./sellerKb.js";

export interface CategoryMapping {
  name: string;
  products: number;
  /** The MCAT most of the category's products belong to. */
  mainMcat: { id: string; name: string | null; products: number; inFile: boolean } | null;
  /** The category's other MCATs (a site category often pools several). */
  otherMcats: Array<{ id: string; name: string | null; products: number; inFile: boolean }>;
  /** The questions asked when only the category is known (the main MCAT's). */
  questions: { source: "mcat" | "derived" | "none"; mcat: string | null; isqs: Isq[]; presentOn: number };
  flags: string[];
}

export interface CardMapping {
  name: string;
  /** The KB category the card maps to, and how it was found. */
  category: string | null;
  mcat: { id: string; name: string | null } | null;
  how: "product" | "category" | "mcat" | "contains" | "word" | "none";
}

export interface KnowledgeMapping {
  version: string;
  categories: CategoryMapping[];
  looseProducts: number;
  mcatFile: {
    uploaded: boolean;
    entries: number;
    withSpecs: number;
    /** File entries some product of this seller belongs to (by id). */
    usedById: number;
    /** File entries used by name only (a category named like them, no product with their id). */
    usedByName: string[];
    /** File entries no category or product uses. */
    unused: string[];
    /** MCAT ids in the export that the file lacks. */
    missing: Array<{ id: string; products: number; categories: string[] }>;
  };
  cards: CardMapping[];
  faqs: { product: number; productPriced: number };
  policyCard: { sections: string[]; stripped: number; dealsIn: number } | null;
  /** Problems worth a look, in plain words. */
  flags: string[];
}

/** Maps a product card to the seller's catalogue: a product, a category, an MCAT name, else a containing name. */
export function mapCard(card: ProductCard, view: KbView, mcats: McatSpec[]): CardMapping {
  const names = [card.canonical_name, card.category ?? "", ...(card.aliases ?? []), ...(card.flow.categories ?? [])].filter(Boolean);
  const kb = view.kb;
  const mcatName = (id: string | null) => (id ? (mcats.find((m) => m.id === id)?.name ?? null) : null);
  const place = (categoryName: string | null, id: string | null, how: CardMapping["how"]): CardMapping => ({ name: card.canonical_name, category: categoryName, mcat: id ? { id, name: mcatName(id) } : null, how });
  for (const n of names) {
    const p = kb.products.find((x) => namesEqual(view.title(x), n) || namesEqual(x.name, n));
    if (p) return place(view.categoryOf(p)?.name ?? null, view.mcatOf(p), "product");
  }
  for (const n of names) {
    const byTaxonomy = kb.products.find((p) => namesEqual(p.taxonomy?.category_name ?? "", n));
    const c = kb.categories.find((x) => namesEqual(x.name, n)) ?? (byTaxonomy ? view.categoryOf(byTaxonomy) : undefined);
    if (c) return place(c.name, view.mainMcatOf(c), "category");
  }
  for (const n of names) {
    const m = mcats.find((x) => namesEqual(x.name, n));
    if (m) {
      const c = kb.categories.find((x) => view.mcatsOf(x).some((y) => y.id === m.id));
      return place(c?.name ?? null, m.id, "mcat");
    }
  }
  for (const n of names) {
    const c = kb.categories.find((x) => namesMatch(n, x.name) || namesMatch(x.name, n));
    if (c) return place(c.name, view.mainMcatOf(c), "contains");
  }
  // Last resort: a distinctive word of the card's name in a product's name ("Casseroles" ~ "Triply Casserole with Lid").
  for (const n of names) {
    for (const w of distinctiveWords(n)) {
      const p = kb.products.find((x) => distinctiveWords(view.title(x)).includes(w));
      if (p) return place(view.categoryOf(p)?.name ?? null, view.mcatOf(p), "word");
    }
  }
  return place(null, null, "none");
}

const GENERIC_WORDS = new Set("stainless steel metal machine machines set sets premium heavy duty industrial commercial service services product products other".split(" "));
/** Words of 5+ letters that say what a thing is, singular ("casseroles" → "casserole"). */
const distinctiveWords = (name: string) =>
  name
    .toLowerCase()
    .split(/[^a-z]+/)
    .map((w) => w.replace(/(?<=[^s])s$/, ""))
    .filter((w) => w.length >= 5 && !GENERIC_WORDS.has(w));

export function buildMapping(view: KbView, files: { mcats: McatSpec[]; mcatUploaded: boolean; cards: ProductCard[]; policyCard: BusinessCardMd | null }, faqs: { rows: FaqRow[]; priced: number }): KnowledgeMapping {
  const { mcats, cards } = files;
  const flags: string[] = [];
  const usedIds = new Set<string>();
  const missing = new Map<string, { products: number; categories: Set<string> }>();
  const categories: CategoryMapping[] = view.kb.categories.map((c) => {
    const list = view.mcatsOf(c);
    const plan = view.isqPlan(c);
    const cf: string[] = [];
    for (const m of list) {
      if (m.inFile) usedIds.add(m.id);
      else {
        const e = missing.get(m.id) ?? { products: 0, categories: new Set<string>() };
        e.products += m.products;
        e.categories.add(c.name);
        missing.set(m.id, e);
      }
    }
    if (!list.length) cf.push("no MCAT ids on its products");
    else if (!list[0].inFile) cf.push(`main MCAT ${list[0].id} is not in the MCAT file`);
    if (!plan.isqs.length) cf.push("no spec questions");
    else if (plan.source === "derived") cf.push(plan.mcat ? `MCAT ${plan.mcat}'s specs aren't on these products; questions derived from the products` : "questions derived from the products (no MCAT match)");
    const toM = (m: (typeof list)[number]) => ({ id: m.id, name: m.name ?? null, products: m.products, inFile: m.inFile });
    return {
      name: c.name,
      products: view.productsIn(c).length,
      mainMcat: list[0] ? toM(list[0]) : null,
      otherMcats: list.slice(1).map(toM),
      questions: { source: plan.isqs.length ? plan.source : "none", mcat: plan.mcat ?? null, isqs: plan.isqs, presentOn: plan.presentOn },
      flags: cf,
    };
  });
  const byName = new Set(categories.filter((c) => c.questions.source === "mcat" && c.mainMcat && !c.mainMcat.inFile).map((c) => c.questions.mcat));
  const usedByName = mcats.filter((m) => !usedIds.has(m.id) && byName.has(m.name)).map((m) => m.name);
  const unused = mcats.filter((m) => !usedIds.has(m.id) && !byName.has(m.name)).map((m) => m.name);
  const cardMaps = cards.map((card) => mapCard(card, view, mcats));
  const loose = view.looseProducts().length;
  const noQuestions = categories.filter((c) => c.questions.source === "none").length;
  const derived = categories.filter((c) => c.questions.source === "derived").length;
  const unmatchedCards = cardMaps.filter((c) => c.how === "none").length;
  if (!files.mcatUploaded) flags.push("No MCAT specifications file: questions come from the products' own specification values.");
  if (missing.size) flags.push(`${missing.size} MCAT id${missing.size === 1 ? "" : "s"} used by products are not in the MCAT file (${[...missing.entries()].slice(0, 5).map(([id, e]) => `${id}: ${e.products} product${e.products === 1 ? "" : "s"}`).join(", ")}${missing.size > 5 ? ", …" : ""}).`);
  if (noQuestions) flags.push(`${noQuestions} categor${noQuestions === 1 ? "y has" : "ies have"} no spec questions.`);
  if (derived) flags.push(`${derived} categor${derived === 1 ? "y uses" : "ies use"} questions derived from the products instead of the MCAT file.`);
  if (loose) flags.push(`${loose} product${loose === 1 ? " is" : "s are"} in no category and never get spec questions.`);
  if (unmatchedCards) flags.push(`${unmatchedCards} product card${unmatchedCards === 1 ? "" : "s"} match${unmatchedCards === 1 ? "es" : ""} no product or category (${cardMaps.filter((c) => c.how === "none").slice(0, 5).map((c) => c.name).join(", ")}).`);
  if (unused.length) flags.push(`${unused.length} MCAT file entr${unused.length === 1 ? "y is" : "ies are"} not used by any product or category.`);
  return {
    version: view.kb._version,
    categories,
    looseProducts: loose,
    mcatFile: { uploaded: files.mcatUploaded, entries: mcats.length, withSpecs: mcats.filter((m) => m.specs.length).length, usedById: usedIds.size, usedByName, unused, missing: [...missing.entries()].map(([id, e]) => ({ id, products: e.products, categories: [...e.categories] })) },
    cards: cardMaps,
    faqs: { product: faqs.rows.length, productPriced: faqs.priced },
    policyCard: files.policyCard ? { sections: files.policyCard.sections, stripped: files.policyCard.stripped, dealsIn: files.policyCard.dealsIn.length } : null,
    flags,
  };
}
