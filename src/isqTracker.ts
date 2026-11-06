/**
 * Which machine category the chat is about, and which of its spec questions (ISQs) were asked.
 * The server works this out each turn and gives the bot only that category's questions, inside
 * <spec_questions>, so it never asks another category's.
 */
import type { CatalogueEntry } from "./crawler.js";
import { specNamesMatch, type IsqPlan } from "./sellerKb.js";
import type { LeadState } from "./session.js";

/**
 * Where the buyer's product sits in the seller's knowledge: its site category, its MCAT (null when
 * the export has none) and its product card (null when none matches). A product known only from a
 * card the KB JSON has no category for has an empty category.
 */
export interface Place {
  category: string;
  mcatId: string | null;
  cardId?: string | null;
  /** For a card found from the buyer's words: the words of its name they used. */
  named?: string[];
}

/** What runTurn needs from the seller's knowledge base (KB JSON sellers only). */
export interface IsqSource {
  /** The questions for the product: its card's must-ask specs, else the category's for the given MCAT (see planFor in cardQuestions.ts). */
  plan(category: string, mcatId?: string | null, cardId?: string | null): IsqPlan | null;
  /** The category and MCAT of a catalogue entry (a product's own MCAT; a category page's main one). */
  locate(e: CatalogueEntry): Place | null;
  /** The place of the best catalogue match for a product name (e.g. from save_lead), else of the product card it names. */
  locateText(text: string): Place | null;
  /** The place of the product card the buyer's own words name, when the catalogue finds nothing (none for a greeting). */
  locateCard?(text: string): Place | null;
}

/** Words too generic to tell machines apart ("mild steel", "automatic"). */
const GENERIC = new Set(
  "machine machines product products item items steel mild stainless plate sheet metal automatic semi manual industrial heavy duty model type size with from that this what your have need want price rate cost please hello namaste piece pieces unit units dozen quantity delivery city firm company business individual immediately within month months week weeks days".split(" "),
);
/** Distinctive words, cut to 5 letters so "shear" and "shearing" count as one. */
const words = (t: string) => (t.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !GENERIC.has(w)).map((w) => w.slice(0, 5));

/** The chat's current plan: its category's questions for its MCAT. */
export const currentPlan = (lead: LeadState, src: IsqSource) => (lead.category || lead.cardId ? src.plan(lead.category ?? "", lead.mcatId ?? null, lead.cardId ?? null) : null);

/**
 * True while the bot collects the firm name, time frame or delivery city (spec questions done,
 * quantity and buyer type given): a reply such as "Awadh Canteen Services" or "Lucknow" is an
 * answer, so only a message sharing two distinctive words with a product names another one.
 */
function askingNames(lead: LeadState, src: IsqSource): boolean {
  const d = lead.details ?? {};
  const plan = currentPlan(lead, src);
  return !!plan && pendingQuestions(lead, plan).length === 0 && !!d.quantity && !!d.buyerType;
}

/** Sets the chat's machine (category and MCAT). Returns true when it changed. */
export function setPlace(lead: LeadState, src: IsqSource, next: Place | null): boolean {
  if (!next || (next.category === (lead.category ?? "") && (next.mcatId ?? null) === (lead.mcatId ?? null) && (next.cardId ?? null) === (lead.cardId ?? null))) return false;
  // The same questions (same MCAT, or two categories sharing one) is not a switch: keep what was asked.
  const before = currentPlan(lead, src);
  const after = src.plan(next.category, next.mcatId, next.cardId ?? null);
  const sameQuestions = !!before && !!after && before.isqs.map((q) => q.question).join("|") === after.isqs.map((q) => q.question).join("|");
  lead.category = next.category || undefined;
  lead.mcatId = next.mcatId ?? undefined;
  lead.cardId = next.cardId ?? undefined;
  if (!sameQuestions) lead.askedIsqs = [];
  return true;
}

/**
 * Updates the chat's machine from this turn's strongest signal: the page the buyer is on, else
 * the top catalogue match for the buyer's own words. A match switches an existing machine only
 * when the message names one: two distinctive words shared with it, or one the current
 * machine's name and options don't use ("shear" while on press brakes). So an answer such as
 * "6 mm", "MS" or "Hydraulic" never moves the chat to another machine. Returns true when it changed.
 */
export function updateCategory(
  lead: LeadState,
  src: IsqSource,
  turn: { buyerText: string; page?: CatalogueEntry | null; hits: CatalogueEntry[]; ownHits: boolean },
): boolean {
  if (lead.stage === "otp_sent" || lead.stage === "verified") return false;
  let next: Place | null = null;
  if (turn.page) next = src.locate(turn.page);
  else if (turn.ownHits && turn.hits[0]) {
    const top = turn.hits[0];
    const tapped = lead.lastOptions?.some((o) => o.toLowerCase() === turn.buyerText.trim().toLowerCase());
    const named = new Set(words(turn.buyerText));
    const shared = [...new Set(words(`${top.title} ${top.category}`).filter((w) => named.has(w)))];
    const current = currentPlan(lead, src);
    const known = new Set(current ? words(`${current.label} ${current.isqs.flatMap((q) => q.options).join(" ")}`) : []);
    const namesIt = shared.length >= 2 || (!askingNames(lead, src) && shared.some((w) => !known.has(w)));
    // A greeting or a vague message ("hi", "price?") shares no distinctive word with its hit, so it
    // never picks a product, not even on the first message: the search is prefix and fuzzy.
    if (!tapped && shared.length && (!lead.category || namesIt)) next = src.locate(top);
    // The buyer's own word names a different card that the top hit's title lacks ("24 ghante ka cook chahiye" when the
    // top hit is "24 Hours Maid Service"): the card they named wins.
    if (next && src.locateCard && !askingNames(lead, src)) {
      const byCard = src.locateCard(turn.buyerText);
      const hitWords = new Set(words(`${top.title} ${top.category}`));
      if (byCard?.cardId && byCard.cardId !== next.cardId && (byCard.named ?? []).some((w) => !hitWords.has(w.slice(0, 5)))) next = byCard;
    }
  }
  // Nothing in the catalogue, but the buyer's words name one of the product cards ("bachcha samhalne wali maid").
  if (!next && !turn.page && src.locateCard && !lead.lastOptions?.some((o) => o.toLowerCase() === turn.buyerText.trim().toLowerCase())) {
    const byCard = src.locateCard(turn.buyerText);
    if (byCard && byCard.cardId !== lead.cardId && !askingNames(lead, src)) {
      const current = currentPlan(lead, src);
      const known = new Set(current ? words(`${current.label} ${current.isqs.flatMap((q) => q.options).join(" ")}`) : []);
      if (!lead.category && !lead.cardId) next = byCard;
      else if (words(turn.buyerText).some((w) => !known.has(w))) next = byCard;
    }
  }
  return setPlace(lead, src, next);
}

/** Marks the ISQ whose options best match the reply buttons just shown as asked. */
export function markAsked(lead: LeadState, plan: IsqPlan | null, options: string[]) {
  lead.lastOptions = options;
  if (!plan) return;
  const shown = new Set(options.map((o) => o.toLowerCase()));
  let best: { q: string; n: number } | null = null;
  for (const isq of plan.isqs) {
    const n = isq.options.filter((o) => shown.has(o.toLowerCase())).length;
    if (n && (!best || n > best.n)) best = { q: isq.question, n };
  }
  if (best && !(lead.askedIsqs ?? []).includes(best.q)) lead.askedIsqs = [...(lead.askedIsqs ?? []), best.q];
}

/** Marks ISQs answered through save_lead's specs (by label: the same name, or one containing it, "Form" for "Physical Form"). */
export function markAnswered(lead: LeadState, plan: IsqPlan | null, labels: string[]) {
  if (!plan) return;
  const said = labels.map((l) => l.trim()).filter(Boolean);
  const asked = new Set(lead.askedIsqs ?? []);
  for (const isq of plan.isqs) if (said.some((l) => specNamesMatch(l, isq.question))) asked.add(isq.question);
  lead.askedIsqs = [...asked];
}

/** The plan's questions neither asked (buttons shown) nor answered (a spec label), in order. */
export function pendingQuestions(lead: LeadState, plan: IsqPlan | null): IsqPlan["isqs"] {
  if (!plan) return [];
  const done = new Set(lead.askedIsqs ?? []);
  return plan.isqs.filter((q) => !done.has(q.question));
}

/** The <spec_questions> block for this turn. */
export function specQuestionsText(plan: IsqPlan, asked: string[] = []): string {
  const from = plan.source === "card" ? " (from the product card's must-ask specs)" : plan.source === "mcat" ? " (from the MCAT specifications)" : "";
  if (!plan.isqs.length) {
    return `Product: ${plan.label}. It has no listed specification questions: don't invent any. Go on to the quantity and the rest of the enquiry.`;
  }
  const done = new Set(asked);
  const next = plan.isqs.find((q) => !done.has(q.question));
  return [
    `Product: ${plan.label}${from}.`,
    "Ask only these specification questions (ISQs) for this product, one per message, in this order, with exactly these options in show_options. A question marked \"no buttons\" is asked in words, without show_options. Skip any the buyer has already answered. Never ask another product's questions.",
    ...plan.isqs.map((q, i) => `${i + 1}. ${q.question}? ${q.options.length ? `Options: ${q.options.join(" / ")}` : "No buttons: ask in words"}${q.hint ? ` (${q.hint})` : ""}`),
    asked.length ? `Already asked: ${plan.isqs.filter((q) => done.has(q.question)).map((q) => q.question).join(", ") || "none"}.` : "",
    next ? `Next: ${next.question}.` : "All asked: when the buyer has answered, save the enquiry with complete set to true.",
  ]
    .filter(Boolean)
    .join("\n");
}
