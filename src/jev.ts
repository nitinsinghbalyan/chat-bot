/**
 * Jev (TypeSafe AI's "System One" decision model) picks which of the seller's products the buyer
 * means this turn. Claude still writes every reply; Jev only makes this one decision.
 *
 * One request per turn (POST /v1/systemone, https://docs.typesafe.ai/api/system-one.md) asks:
 * - `product`: a Choice over the candidates (the top catalogue matches, one per product card or
 *   category, plus the card the buyer's own words name), shuffled because Jev leans to the first option;
 * - `about_product`: a companion Noul: does the message ask about a product at all? (A Choice always
 *   picks something, even for "hi"; see https://docs.typesafe.ai/patterns/companion-noul.md);
 * - `other_product`: when the chat already has a product, does the message move to a different one?
 *
 * Off by default (`/admin`, Jev product pick card). In shadow mode Jev is asked and logged, but the
 * word rules in isqTracker.ts decide. When Jev is slow, down or unsure, the word rules decide.
 */
import type { CatalogueEntry } from "./crawler.js";
import { askingNames, currentPlan, updateCategory, type IsqSource, type Place } from "./isqTracker.js";
import type { LeadState } from "./session.js";
import type { TraceSink } from "./tracing.js";

export type JevMode = "off" | "shadow" | "on";
export const JEV_MODES: JevMode[] = ["off", "shadow", "on"];
export const isJevMode = (v: unknown): v is JevMode => typeof v === "string" && (JEV_MODES as string[]).includes(v);
/** The settings key for the mode (db settings table). */
export const JEV_MODE_SETTING = "jev_product_pick";

// ---- the API ----

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}
export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}
export interface SystemOneRequest {
  model: string;
  state: Record<string, unknown> | string;
  questions: Record<string, ChoiceQuestion | NoulQuestion>;
}
export type SystemOneAnswer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "noul"; noul: number };
export interface SystemOneResponse {
  model: string;
  answers: Record<string, SystemOneAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}
export type SystemOneResult = { ok: true; res: SystemOneResponse; ms: number } | { ok: false; error: string; ms: number };

/** Anything that can answer a System One request (the HTTP client, a cache, a fake in tests). */
export interface SystemOneCaller {
  readonly model: string;
  systemOne(req: SystemOneRequest): Promise<SystemOneResult>;
}

export interface JevClientOptions {
  apiKey: string;
  model: string;
  /** API origin, e.g. https://api.typesafe.ai */
  baseUrl: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

/** The HTTP client: one POST, a hard timeout, no retries (a chat turn can't wait). */
export class JevClient implements SystemOneCaller {
  readonly model: string;
  constructor(private readonly opts: JevClientOptions) {
    this.model = opts.model;
  }

  async systemOne(req: SystemOneRequest): Promise<SystemOneResult> {
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
    try {
      const res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl.replace(/\/+$/, "")}/v1/systemone`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(req),
        signal: ctrl.signal,
      });
      const ms = Date.now() - started;
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        return { ok: false, error: `HTTP ${res.status}${detail ? `: ${detail}` : ""}`, ms };
      }
      const body = (await res.json()) as SystemOneResponse;
      if (!body?.answers || typeof body.answers !== "object") return { ok: false, error: "response without answers", ms };
      return { ok: true, res: body, ms };
    } catch (err) {
      const ms = Date.now() - started;
      return { ok: false, error: ctrl.signal.aborted ? `timed out after ${this.opts.timeoutMs} ms` : (err as Error).message, ms };
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---- the product-pick question ----

export interface ProductCandidate {
  /** The option name Jev sees (a readable slug of the label). */
  key: string;
  /** The product card's name, else the category (what the bot's spec questions are for). */
  label: string;
  /** Catalogue titles that led to it. */
  titles: string[];
  place: Place;
}

const placeKey = (p: { category: string; mcatId?: string | null; cardId?: string | null }) => `${p.category}|${p.mcatId ?? ""}|${p.cardId ?? ""}`;
const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "product";

/**
 * The options for the Choice: one per distinct place among the catalogue hits (the place decides the
 * spec questions, so two hits with the same card or category are one option), the product card the
 * buyer's words name, then the rest of the seller's products, so a need described in other words
 * ("sheet bending machine chahiye") can still find its product when the word search finds nothing.
 * At most `max` (Jev takes up to 255; fewer keep the state small, which its docs advise).
 */
export function productCandidates(hits: CatalogueEntry[], src: IsqSource, buyerText: string, max = 30): ProductCandidate[] {
  const out: ProductCandidate[] = [];
  const byPlace = new Map<string, ProductCandidate>();
  const add = (place: Place | null, title: string | null) => {
    if (!place) return;
    const k = placeKey(place);
    const have = byPlace.get(k);
    if (have) {
      if (title && !have.titles.includes(title) && have.titles.length < 3) have.titles.push(title);
      return;
    }
    if (out.length >= max) return;
    const label = src.plan(place.category, place.mcatId, place.cardId ?? null)?.label || title || place.category;
    if (!label) return;
    const c: ProductCandidate = { key: "", label, titles: title ? [title] : [], place };
    byPlace.set(k, c);
    out.push(c);
  };
  for (const h of hits) add(src.locate(h), h.title);
  add(src.locateCard?.(buyerText) ?? null, null);
  for (const p of src.places?.() ?? []) add(p.place, p.title);
  const used = new Set<string>();
  for (const c of out) {
    let key = slug(c.label);
    for (let i = 2; used.has(key); i++) key = `${slug(c.label)}_${i}`;
    used.add(key);
    c.key = key;
  }
  return out;
}

/** Phone numbers, OTPs and other long digit runs never leave for Jev. */
export const maskDigits = (t: string) => t.replace(/\+?\d[\d\s-]{4,}\d/g, "[number]");

export interface PickInput {
  buyerText: string;
  /** The bot's previous message, so an answer to it ("6 mm", "Lucknow") isn't read as a product. */
  lastBotText?: string;
  /** The reply buttons the bot showed last. */
  buttons?: string[];
  /** The chat's product so far. */
  current?: { label: string; place: Place } | null;
  candidates: ProductCandidate[];
}

export interface JevPick {
  /** A product to switch to, "keep" (no product change this turn), or null: Jev isn't sure, the word rules decide. */
  decision: Place | "keep" | null;
  reason: string;
  choice?: string;
  confidence?: number;
  aboutProduct?: number;
  otherProduct?: number;
  ms: number;
  inputTokens?: number;
  error?: string;
}

/** Thresholds: a clear no / a clear yes on a Noul (the docs' companion-Noul routing). */
const NO = 0.3;
const YES = 0.7;

/** Builds the request (the options in a shuffled order). */
export function productRequest(model: string, input: PickInput, rng: () => number = Math.random): SystemOneRequest {
  const shuffled = [...input.candidates];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  const state: Record<string, unknown> = {
    buyer_message: maskDigits(input.buyerText).slice(0, 1000),
    ...(input.lastBotText ? { bot_previous_message: maskDigits(input.lastBotText).slice(0, 400) } : {}),
    ...(input.buttons?.length ? { buttons_shown: input.buttons.slice(0, 8) } : {}),
    ...(input.current ? { current_product: input.current.label } : {}),
    seller_products: Object.fromEntries(shuffled.map((c) => [c.key, c.titles.length ? `${c.label} (e.g. ${c.titles.join("; ")})` : c.label])),
  };
  const questions: SystemOneRequest["questions"] = {
    product: {
      type: "choice",
      instructions: "Which product in `seller_products` is the buyer asking about in `buyer_message`?",
      criteria: Object.fromEntries(shuffled.map((c) => [c.key, c.titles.length ? `${c.label}, such as ${c.titles.join("; ")}` : c.label])),
    },
    about_product: {
      type: "noul",
      instructions: "Does `buyer_message` ask about, name or describe a product or service the buyer wants?",
      criteria: {
        true: "The buyer names, describes or asks about something they want to buy, in any language (English, Hindi or Hinglish).",
        false:
          "A greeting or thanks; a name, phone number, firm or city; an answer to `bot_previous_message` such as a size, material, quantity or time frame; a question about price, delivery, payment or the company with no product in it; or something unrelated to buying.",
      },
    },
  };
  if (input.current) {
    questions.other_product = {
      type: "noul",
      instructions: "Does `buyer_message` ask about a different product than `current_product`?",
      criteria: {
        true: "The buyer names or describes another product they want, instead of or as well as `current_product`.",
        false: "The message is still about `current_product`: an answer to the bot's question, a detail of it, or no product at all.",
      },
    };
  }
  return { model, state, questions };
}

/** Asks Jev and turns its answers into a decision. */
export async function pickProduct(caller: SystemOneCaller, input: PickInput, opts: { minConfidence: number; rng?: () => number }): Promise<JevPick> {
  const r = await caller.systemOne(productRequest(caller.model, input, opts.rng));
  if (!r.ok) return { decision: null, reason: "error", error: r.error, ms: r.ms };
  const a = r.res.answers;
  const product = a.product?.type === "choice" ? a.product : null;
  const about = a.about_product?.type === "noul" ? a.about_product.noul : undefined;
  const other = a.other_product?.type === "noul" ? a.other_product.noul : undefined;
  const base = { choice: product?.choice, confidence: product?.confidence, aboutProduct: about, otherProduct: other, ms: r.ms, inputTokens: r.res.usage?.input_tokens };
  if (!product || about === undefined) return { ...base, decision: null, reason: "incomplete answer" };
  if (about < NO) return { ...base, decision: "keep", reason: "not about a product" };
  const picked = input.candidates.find((c) => c.key === product.choice);
  if (about < YES || !picked || product.confidence < opts.minConfidence) return { ...base, decision: null, reason: "unsure" };
  if (input.current) {
    if (placeKey(picked.place) === placeKey(input.current.place)) return { ...base, decision: "keep", reason: "same product" };
    if (other !== undefined && other < NO) return { ...base, decision: "keep", reason: "still the current product" };
    if (other === undefined || other < YES) return { ...base, decision: null, reason: "unsure about a switch" };
  }
  return { ...base, decision: picked.place, reason: input.current ? "switch" : "pick" };
}

// ---- the service runTurn uses ----

export interface JevStats {
  calls: number;
  errors: number;
  totalMs: number;
  lastMs: number | null;
  lastAt: string | null;
  lastError: string | null;
  /** Turns where Jev's result and the word rules' result were compared, and how many agreed. */
  compared: number;
  agreed: number;
}

export interface JevDecideInput {
  lead: LeadState;
  src: IsqSource;
  buyerText: string;
  hits: CatalogueEntry[];
  ownHits: boolean;
  lastBotText?: string;
  trace?: TraceSink;
}

export class JevService {
  readonly stats: JevStats = { calls: 0, errors: 0, totalMs: 0, lastMs: null, lastAt: null, lastError: null, compared: 0, agreed: 0 };
  constructor(
    private readonly opts: {
      caller: SystemOneCaller | null;
      mode: () => JevMode;
      minConfidence: number;
      rng?: () => number;
    },
  ) {}

  get hasKey(): boolean {
    return !!this.opts.caller;
  }
  get model(): string | null {
    return this.opts.caller?.model ?? null;
  }
  get minConfidence(): number {
    return this.opts.minConfidence;
  }
  mode(): JevMode {
    return this.opts.caller ? this.opts.mode() : "off";
  }

  /**
   * Jev's decision for this turn, to pass to updateCategory as `decided`. Undefined when the mode is
   * off or shadow, when Jev isn't asked (login steps, a tapped button, nothing to choose from), or when
   * it isn't sure: the word rules decide then.
   */
  async decide(t: JevDecideInput): Promise<Place | "keep" | undefined> {
    const mode = this.mode();
    if (mode === "off") return undefined;
    const { lead, src } = t;
    if (lead.stage === "otp_sent" || lead.stage === "verified") return undefined;
    if (lead.lastOptions?.some((o) => o.toLowerCase() === t.buyerText.trim().toLowerCase())) return undefined;
    // Firm, time frame and city answers can't move the chat to another product, so there is nothing to ask.
    if (askingNames(lead, src)) return undefined;
    // A mobile number, OTP or quantity alone names no product.
    if (!/\p{L}{2,}/u.test(t.buyerText)) return undefined;
    const candidates = productCandidates(t.ownHits ? t.hits : [], src, t.buyerText);
    if (!candidates.length) return undefined;
    const plan = currentPlan(lead, src);
    const current = plan ? { label: plan.label, place: { category: lead.category ?? "", mcatId: lead.mcatId ?? null, cardId: lead.cardId ?? null } } : null;

    const obs = t.trace?.start("jev-product-pick", "span", {
      input: { buyerMessage: maskDigits(t.buyerText), current: current?.label ?? null, candidates: candidates.map((c) => c.label) },
      metadata: { mode, model: this.model, minConfidence: this.opts.minConfidence },
    });
    const pick = await pickProduct(this.opts.caller!, { buyerText: t.buyerText, lastBotText: t.lastBotText, buttons: lead.lastOptions, current, candidates }, { minConfidence: this.opts.minConfidence, rng: this.opts.rng });
    this.stats.calls++;
    this.stats.lastAt = new Date().toISOString();
    this.stats.lastMs = pick.ms;
    this.stats.totalMs += pick.ms;
    if (pick.error) this.stats.errors++, (this.stats.lastError = pick.error);

    // What the word rules alone would do, to compare (both modes).
    const words = structuredClone(lead);
    updateCategory(words, src, { buyerText: t.buyerText, hits: t.hits, ownHits: t.ownHits });
    let agrees: boolean | null = null;
    if (pick.decision !== null) {
      const withJev = structuredClone(lead);
      updateCategory(withJev, src, { buyerText: t.buyerText, hits: t.hits, ownHits: t.ownHits, decided: pick.decision });
      agrees = placeKey({ category: words.category ?? "", mcatId: words.mcatId, cardId: words.cardId }) === placeKey({ category: withJev.category ?? "", mcatId: withJev.mcatId, cardId: withJev.cardId });
      this.stats.compared++;
      if (agrees) this.stats.agreed++;
    }
    const used = mode === "on" && pick.decision !== null;
    const label = (d: JevPick["decision"]) => (d === null ? null : d === "keep" ? "keep" : (candidates.find((c) => placeKey(c.place) === placeKey(d))?.label ?? d.category));
    obs?.update({
      output: { decision: label(pick.decision), reason: pick.reason, choice: pick.choice ?? null, confidence: pick.confidence ?? null, aboutProduct: pick.aboutProduct ?? null, otherProduct: pick.otherProduct ?? null },
      metadata: { outcome: pick.error ? "error" : mode === "shadow" ? "shadow" : used ? "used" : "fallback", agreesWithWordRules: agrees, ms: pick.ms, inputTokens: pick.inputTokens ?? null },
      ...(pick.error ? { level: "WARNING" as const, statusMessage: pick.error } : {}),
    });
    obs?.end();
    return used ? (pick.decision ?? undefined) : undefined;
  }
}
