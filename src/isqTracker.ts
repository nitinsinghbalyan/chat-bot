/**
 * Which machine category the chat is about, and which of its spec questions (ISQs) were asked.
 * The server works this out each turn and gives the bot only that category's questions, inside
 * <spec_questions>, so it never asks another category's.
 */
import type { CatalogueEntry } from "./crawler.js";
import type { IsqPlan } from "./sellerKb.js";
import type { LeadState } from "./session.js";

/** What runTurn needs from the seller's knowledge base (KB JSON sellers only). */
export interface IsqSource {
  plan(category: string): IsqPlan | null;
  categoryOfEntry(e: CatalogueEntry): string | null;
  /** The category of the best catalogue match for a product name (e.g. from save_lead). */
  categoryForText(text: string): string | null;
}

/** Words too generic to tell machines apart ("mild steel", "automatic"). */
const GENERIC = new Set(
  "machine machines steel mild stainless plate sheet metal automatic semi manual industrial heavy duty model type size with from that this what your have need want price rate cost please".split(" "),
);
/** Distinctive words, cut to 5 letters so "shear" and "shearing" count as one. */
const words = (t: string) => (t.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !GENERIC.has(w)).map((w) => w.slice(0, 5));

/**
 * Updates the chat's category from this turn's strongest signal: the page the buyer is on, else
 * the top catalogue match for the buyer's own words. A match switches an existing category only
 * when the message names that machine: two distinctive words shared with it, or one the current
 * machine's name and options don't use ("shear" while on press brakes). So an answer such as
 * "6 mm", "MS" or "Hydraulic" never moves the chat to another machine. Returns true when it changed.
 */
export function updateCategory(
  lead: LeadState,
  src: IsqSource,
  turn: { buyerText: string; page?: CatalogueEntry | null; hits: CatalogueEntry[]; ownHits: boolean },
): boolean {
  if (lead.stage === "otp_sent" || lead.stage === "verified") return false;
  let next: string | null = null;
  if (turn.page) next = src.categoryOfEntry(turn.page);
  else if (turn.ownHits && turn.hits[0]) {
    const top = turn.hits[0];
    const tapped = lead.lastOptions?.some((o) => o.toLowerCase() === turn.buyerText.trim().toLowerCase());
    const named = new Set(words(turn.buyerText));
    const shared = [...new Set(words(`${top.title} ${top.category}`).filter((w) => named.has(w)))];
    const current = lead.category ? src.plan(lead.category) : null;
    const known = new Set(current ? words(`${current.label} ${current.isqs.flatMap((q) => q.options).join(" ")}`) : []);
    const namesIt = shared.length >= 2 || shared.some((w) => !known.has(w));
    if (!tapped && (!lead.category || namesIt)) next = src.categoryOfEntry(top);
  }
  if (!next || next === lead.category) return false;
  // Same MCAT family (same questions) is not a switch: keep what was asked.
  const before = lead.category ? src.plan(lead.category) : null;
  const after = src.plan(next);
  const sameQuestions = !!before && !!after && before.isqs.map((q) => q.question).join("|") === after.isqs.map((q) => q.question).join("|");
  lead.category = next;
  if (!sameQuestions) lead.askedIsqs = [];
  return true;
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

/** Marks ISQs answered through save_lead's specs (by label). */
export function markAnswered(lead: LeadState, plan: IsqPlan | null, labels: string[]) {
  if (!plan) return;
  const said = new Set(labels.map((l) => l.toLowerCase().trim()));
  const asked = new Set(lead.askedIsqs ?? []);
  for (const isq of plan.isqs) if (said.has(isq.question.toLowerCase())) asked.add(isq.question);
  lead.askedIsqs = [...asked];
}

/** The <spec_questions> block for this turn. */
export function specQuestionsText(plan: IsqPlan, asked: string[] = []): string {
  if (!plan.isqs.length) {
    return `Machine category: ${plan.label}. It has no listed specification questions: don't invent any. Ask only for the quantity and city if still needed.`;
  }
  const done = new Set(asked);
  const next = plan.isqs.find((q) => !done.has(q.question));
  return [
    `Machine category: ${plan.label}.`,
    "Ask only these specification questions (ISQs) for this machine, one per message, in this order, with exactly these options in show_options. Skip any the buyer has already answered. Never ask another category's questions.",
    ...plan.isqs.map((q, i) => `${i + 1}. ${q.question}? Options: ${q.options.join(" / ")}`),
    asked.length ? `Already asked: ${plan.isqs.filter((q) => done.has(q.question)).map((q) => q.question).join(", ") || "none"}.` : "",
    next ? `Next: ${next.question}.` : "All asked: when the buyer has answered, save the enquiry with complete set to true.",
  ]
    .filter(Boolean)
    .join("\n");
}
