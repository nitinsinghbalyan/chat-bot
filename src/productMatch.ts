/**
 * Does a product label (a catalogue hit's title and category, a picked category, a product card's
 * name) name the scenario's focus product? Shared by the retrieval eval and the simulation report.
 */

/** Words that don't tell products apart in a focus name ("Stainless Steel Mugs" → "mugs"). */
const GENERIC = new Set("machine machines service services stainless steel ss metal industrial heavy duty manual automatic semi electric hand new premium".split(" "));
export const stem = (w: string) => w.replace(/(ses|xes|ches|shes)$/, "s").replace(/ies$/, "y").replace(/s$/, "").slice(0, 5);
export const words = (t: string) => (t.toLowerCase().match(/[a-z]{3,}/g) ?? []).map(stem);
/** Distinctive words of a focus name; "bar" (3 letters) counts only beside a longer word. */
export const keyWords = (t: string) => [...new Set((t.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !GENERIC.has(w)))];
export const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** "Cutlery (Spoons & Forks)" names three things; any one of them is the product. */
export const alternatives = (focus: string) =>
  focus
    .split(/\s*(?:&|\/|,|\(|\))\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * The focus product is named by `text` or `mcat`: the MCAT has that name, or at least half of one
 * alternative's distinctive words (one of them 4+ letters) appear in the text.
 */
export function namesFocus(focus: string, text: string, mcat: string | null = null): boolean {
  if (mcat && norm(mcat) === norm(focus)) return true;
  const have = new Set(words(`${text} ${mcat ?? ""}`));
  return alternatives(focus).some((alt) => {
    const want = keyWords(alt);
    const shared = want.filter((w) => have.has(stem(w)));
    return want.length > 0 && shared.length >= Math.ceil(want.length / 2) && shared.some((w) => w.length >= 4);
  });
}
