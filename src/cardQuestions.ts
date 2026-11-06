/**
 * Spec questions from the seller's product cards file.
 *
 * Each card lists its attributes with a role: `ASK` (with `required_for_lead`) marks a must-ask
 * spec, in `ask_order`; RARE, DEFER and ON_REQUEST are answered only if the buyer raises them. The
 * bot asks the card's must-ask specs first; when the buyer's product has no card or its card has
 * none, the MCAT file's specs for the product's MCAT, else the products' own spec values (see
 * KbView.isqPlan).
 *
 * Options stay grounded in the seller's files: the card's values; when it lists fewer than two, the
 * MCAT file's options for the same spec, then the values the seller's KB JSON products list for it.
 * With still fewer than two, the spec is an open question (asked in words, no buttons).
 */
import type { CardAttribute, ProductCard } from "./kb.js";
import { findMcat, namesEqual, type McatSpec } from "./sellerFiles.js";
import { cleanValues, MAX_ISQS, MAX_OPTIONS, normKey, specNamesMatch, SPEC_NEVER_ASKED, valueKey, type Isq, type IsqPlan, type KbView } from "./sellerKb.js";

/** Card values longer than this make poor buttons ("Kitchen work, dusting, utensil cleaning, cleaning fridge"). */
const MAX_OPTION_LENGTH = 40;
const PRICE_KEY = /price|rate|cost|mrp|discount/i;

/** The card's must-ask specs, in the seller's order: role ASK (or required for a lead), never brand, model or price. */
export function mustAskAttributes(card: ProductCard): CardAttribute[] {
  return (card.attributes ?? [])
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => a?.key && (String(a.role).toUpperCase() === "ASK" || a.required_for_lead === true) && !SPEC_NEVER_ASKED.test(a.key) && !PRICE_KEY.test(a.key))
    .sort((x, y) => (x.a.ask_order ?? 1e6) - (y.a.ask_order ?? 1e6) || x.i - y.i)
    .map(({ a }) => a);
}

/** "material_grade" → "Material grade"; "product_category" → "Product type". */
export function specLabel(key: string): string {
  const k = normKey(key);
  if (k === "product category") return "Product type";
  return k.charAt(0).toUpperCase() + k.slice(1);
}

/** Distinct values as written: spellings merged (case, plurals, "2.5mm" = "2.5 mm"), long ones dropped. */
function distinct(values: string[]): string[] {
  const out = new Map<string, string>();
  for (const raw of values) {
    const v = String(raw ?? "").trim();
    if (!v || v.length > MAX_OPTION_LENGTH) continue;
    const k = valueKey(v);
    if (!out.has(k)) out.set(k, v);
  }
  return [...out.values()];
}

/**
 * The questions of one card: its must-ask specs, up to MAX_ISQS. `mcat` is the MCAT file's entry
 * for the buyer's product (when known) and `productSpecs` the spec rows of the seller's products of
 * that kind, both used only to fill a spec with fewer than two card values.
 */
export function cardQuestions(card: ProductCard, mcat: McatSpec | undefined, productSpecs: Array<Array<[string, string]>>): Isq[] {
  const asked = (card.questions ?? []).filter((q) => q?.attribute && q.question);
  const out: Isq[] = [];
  for (const a of mustAskAttributes(card)) {
    if (out.length >= MAX_ISQS) break;
    const label = specLabel(a.key);
    if (out.some((q) => specNamesMatch(q.question, label))) continue;
    const own = distinct((a.values ?? []).map((v) => v?.value));
    let options = own;
    if (options.length < 2) {
      const have = new Set(options.map(valueKey));
      const add = (vs: string[]) => {
        for (const v of distinct(vs)) {
          if (options.length >= MAX_OPTIONS) break;
          if (!have.has(valueKey(v))) {
            have.add(valueKey(v));
            options = [...options, v];
          }
        }
      };
      const fileSpec = mcat?.specs.find((s) => specNamesMatch(s.name, label) || specNamesMatch(s.name, a.key));
      if (fileSpec) add(fileSpec.options);
      if (options.length < 2) add(cleanValues(productSpecs.flatMap((r) => r.filter(([n]) => specNamesMatch(n, label)).map(([, v]) => v))));
    }
    const phrasing = asked.find((q) => normKey(q.attribute) === normKey(a.key))?.question.trim();
    const listed = options.length === 1 ? `the seller lists ${options[0]}` : "";
    const hint = [phrasing ? `the seller asks "${phrasing}"` : "", listed].filter(Boolean).join("; ");
    out.push({ question: label, options: options.length >= 2 ? options.slice(0, MAX_OPTIONS) : [], from: "card", ...(hint ? { hint } : {}) });
  }
  return out;
}

/** Where a card sits in the KB JSON (see mapCard in mapping.ts). */
export interface CardPlace {
  category: string | null;
  mcatId: string | null;
}

/** Words that don't tell products apart ("Stainless Steel", "Machine", "Service"). */
const GENERIC = new Set(
  "stainless steel metal machine machines set sets premium heavy duty industrial commercial service services product products other type types with from that this what your need want price rate cost please hello namaste automatic manual semi chahiye".split(" "),
);
/** Distinctive words of 4+ letters, singular ("casseroles" → "casserole"). */
const wordsOf = (t: string) =>
  (t.toLowerCase().match(/[a-z]{4,}/g) ?? [])
    .map((w) => (w.length > 4 ? w.replace(/(?<=[^s])s$/, "") : w))
    .filter((w) => !GENERIC.has(w));

/**
 * The seller's product cards, found by the product the server picks each turn (its title, its
 * category and MCAT) or by the buyer's own words (card names and aliases).
 */
export class CardIndex {
  private byId = new Map<string, ProductCard>();
  private entries: Array<{ id: string; place: CardPlace; names: string[]; own: Set<string>; core: Set<string>; alias: Set<string> }> = [];

  constructor(cards: ProductCard[], places: Map<string, CardPlace>) {
    for (const card of cards) {
      if (this.byId.has(card.product_id)) continue;
      this.byId.set(card.product_id, card);
      const names = [card.canonical_name, card.category ?? "", ...(card.aliases ?? []), ...(card.flow.categories ?? [])].filter(Boolean);
      // The card's own name and categories say what it is; aliases are often long listing titles ("… Made in India,
      // Contact Owner"), so only short ones count, and they need two shared words.
      const core = new Set([card.canonical_name, card.category ?? "", ...(card.flow.categories ?? [])].flatMap(wordsOf));
      const alias = new Set((card.aliases ?? []).filter((a) => a.split(/\s+/).length <= 4).flatMap(wordsOf).filter((w) => !core.has(w)));
      const own = new Set(wordsOf(card.canonical_name));
      this.entries.push({ id: card.product_id, place: places.get(card.product_id) ?? { category: null, mcatId: null }, names, own, core, alias });
    }
  }

  get size() {
    return this.byId.size;
  }

  get(id: string | null | undefined): ProductCard | undefined {
    return id ? this.byId.get(id) : undefined;
  }

  /** The words of a card's name and categories that the text uses ("cook" in "24 ghante ka cook chahiye"). */
  coreWordsIn(id: string, text: string): string[] {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return [];
    const said = new Set(wordsOf(text));
    return [...e.core].filter((w) => said.has(w));
  }

  place(id: string): CardPlace | null {
    return this.entries.find((e) => e.id === id)?.place ?? null;
  }

  /**
   * The card for a product: one naming it (canonical name or alias equal to its title), else the
   * card mapped to the same category and MCAT, else the only card mapped to that category.
   */
  forProduct(title: string, category: string | null, mcatId: string | null): string | null {
    if (title) {
      const named = this.entries.find((e) => e.names.some((n) => namesEqual(n, title)));
      if (named) return named.id;
    }
    if (!category) return null;
    const same = this.entries.filter((e) => e.place.category === category);
    const exact = same.find((e) => mcatId && e.place.mcatId === mcatId);
    if (exact) return exact.id;
    return same.length === 1 ? same[0].id : null;
  }

  /**
   * The card the buyer's words name: a distinctive word of its own name (3 points) or of its
   * categories (2), or two of its short aliases' words (1 each); the highest score of at least 2
   * wins, so "cook" picks "Cook Service" over "Job Consultation Service (Cook Job)". A tie between
   * cards names none, and neither does a greeting.
   */
  forText(text: string): string | null {
    const said = new Set(wordsOf(text));
    if (!said.size) return null;
    let best: { id: string; n: number } | null = null;
    let tie = false;
    for (const e of this.entries) {
      let n = 0;
      for (const w of e.core) if (said.has(w)) n += e.own.has(w) ? 3 : 2;
      for (const w of e.alias) if (said.has(w)) n++;
      if (n < 2) continue;
      if (!best || n > best.n) {
        best = { id: e.id, n };
        tie = false;
      } else if (n === best.n) tie = true;
    }
    return best && !tie ? best.id : null;
  }
}

const cardPlanCache = new WeakMap<ProductCard, Map<string, IsqPlan>>();

/**
 * The spec questions for the buyer's product: the card's must-ask specs when it has any, else the
 * KB JSON category plan (the MCAT file's specs, else the products' own values). `category` may be
 * unknown when only the card is (a card the KB JSON has no category for).
 */
export function planFor(view: KbView, cards: CardIndex | null, category: string | null | undefined, mcatId: string | null | undefined, cardId: string | null | undefined): IsqPlan | null {
  const c = category ? view.categoryNamed(category) : undefined;
  const card = cards?.get(cardId);
  if (card) {
    const key = `${c?.category_id ?? ""}\u0000${mcatId ?? ""}`;
    let cache = cardPlanCache.get(card);
    if (!cache) cardPlanCache.set(card, (cache = new Map()));
    const hit = cache.get(key);
    if (hit) return hit;
    const mcats = view.mcatEntries();
    // The product's MCAT entry by id, else one named like the category (as the category plan does).
    const mcat = (mcatId && mcats.find((m) => m.id === mcatId)) || (c ? findMcat(mcats, [c.name]) : undefined);
    const products = c ? (mcatId ? view.productsOfMcat(c, mcatId) : view.productsIn(c)) : [];
    const isqs = cardQuestions(card, mcat, products.map((p) => view.specs(p)));
    if (isqs.length) {
      const plan: IsqPlan = {
        category: c?.name ?? card.canonical_name,
        label: card.canonical_name,
        mcatId: mcatId ?? null,
        source: "card",
        card: { id: card.product_id, name: card.canonical_name },
        ...(mcat ? { mcat: mcat.name } : {}),
        isqs,
        presentOn: products.length,
        ...(card.selling_unit?.unit ? { unit: card.selling_unit.unit } : {}),
      };
      cache.set(key, plan);
      return plan;
    }
  }
  const plan = c ? view.isqPlan(c, mcatId) : null;
  // A card without must-ask specs still says what unit the product is sold in.
  return plan && card?.selling_unit?.unit ? { ...plan, unit: card.selling_unit.unit } : plan;
}
