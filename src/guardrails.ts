/**
 * Code-level guardrails that back up the system prompt.
 *
 * The prompt asks the model to follow the seller's guardrails; this module makes sure the
 * highest-risk ones (price, freight, contacts, delivery, GST, payment/ID details) cannot reach
 * the buyer even if the model slips.
 */
import fs from "node:fs";
import path from "node:path";
import { paths } from "./config.js";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export const MAX_INPUT_CHARS = 1000;

export interface InputCheck {
  ok: boolean;
  /** Text safe to send to the model (sensitive details redacted). */
  text: string;
  /** Kinds of sensitive details that were removed. */
  redacted: string[];
  error?: string;
}

function luhn(num: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = Number(num[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const SENSITIVE: Array<{ kind: string; re: RegExp; test?: (m: string) => boolean }> = [
  { kind: "GSTIN", re: /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/gi },
  { kind: "PAN", re: /\b[A-Z]{5}\d{4}[A-Z]\b/gi },
  { kind: "IFSC", re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/gi },
  // UPI handles look like name@bank with no dot after the @ (unlike email addresses).
  { kind: "UPI ID", re: /\b[\w.-]{2,}@[a-z]{2,}\b(?!\.)/gi },
  { kind: "card number", re: /\b(?:\d[ -]?){13,19}\b/g, test: (m) => luhn(m.replace(/\D/g, "")) },
  { kind: "Aadhaar number", re: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g },
  { kind: "bank account number", re: /\b(?:a\/c|acc(?:ount)?)(?:\s*(?:no\.?|number|#))?\s*[:\-]?\s*\d{9,18}\b/gi },
];

export function checkInput(raw: unknown): InputCheck {
  if (typeof raw !== "string") return { ok: false, text: "", redacted: [], error: "Message must be text." };
  // Strip control characters except newlines and tabs.
  let text = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (!text) return { ok: false, text: "", redacted: [], error: "Please type a message." };
  if (text.length > MAX_INPUT_CHARS) {
    return { ok: false, text: "", redacted: [], error: `Please keep your message under ${MAX_INPUT_CHARS} characters.` };
  }
  const redacted: string[] = [];
  for (const { kind, re, test } of SENSITIVE) {
    text = text.replace(re, (m) => {
      if (test && !test(m)) return m;
      redacted.push(kind);
      return `[${kind} removed - we do not collect payment or ID details]`;
    });
  }
  return { ok: true, text, redacted: [...new Set(redacted)] };
}

export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private limit: number,
    private windowMs: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 20000) this.prune(now);
    return true;
  }

  private prune(now: number) {
    for (const [k, v] of this.hits) if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface OutputContext {
  /** Prices (as listed) from catalogue entries retrieved in this conversation. */
  allowedPrices: string[];
  /** Phone numbers (digits) from the BUSINESS CARD. */
  allowedPhones: string[];
  /** Domains the bot may link to (seller site). */
  allowedDomains: string[];
}

export type RuleId = "G1_price" | "G2_freight" | "G3_contact" | "G4_stock" | "G5_payment" | "G6_delivery" | "G8_tax";

export const REPLACEMENTS: Record<RuleId, string> = {
  G1_price: "For the price of this exact configuration, our team can share a quote.",
  G2_freight: "Our team will confirm the freight details with you.",
  G3_contact: "I can share our listed contact number if you'd like it, or pass your enquiry to our team.",
  G4_stock: "Our team will confirm availability for you.",
  G5_payment: "We don't need any payment or ID details here.",
  G6_delivery: "Our team will confirm dispatch and delivery details with you.",
  G8_tax: "Our team will help you with GST and tax details.",
};

const MULTIPLIERS: Record<string, number> = { k: 1e3, thousand: 1e3, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, crore: 1e7, crores: 1e7, cr: 1e7 };

const AMOUNT_RE =
  /(?:₹|\bRs\.?|\bINR|\brupees?)\s*(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|lakhs?|lacs?|crores?|cr)?\b|\b(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|cr)\b|\b(\d{1,3}(?:,\d{2,3})+)\b(?:\s*(?:\/-|rupees?))?/gi;

/** Extract money amounts (in rupees) from text. */
export function extractAmounts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const [, curNum, curMult, bareNum, bareMult, grouped] = m;
    const numStr = curNum ?? bareNum ?? grouped;
    const mult = (curMult ?? bareMult ?? "").toLowerCase();
    if (!numStr) continue;
    const value = Number(numStr.replace(/,/g, "")) * (MULTIPLIERS[mult] ?? 1);
    // Bare comma-grouped numbers count only if large enough to be a price.
    if (grouped && value < 10000) continue;
    if (Number.isFinite(value) && value > 0) out.push(value);
  }
  return out;
}

const FREIGHT_RE = [
  /\b(freight|transport(?:ation)?|shipping|cartage)\b[^.!?\n]{0,40}\b(included|inclusive|excluded|exclusive|extra|free|payable|paid|borne|chargeable|additional|on you|on us|to pay|to be paid)\b/i,
  /\b(free|including|incl\.?|excluding|plus|with|without)\s+(freight|transport(?:ation)?|shipping|delivery charges?)\b/i,
  /\b(ex[- ]?works|f\.?o\.?r\.?\s+destination|door[- ]?delivery charges?)\b/i,
];

const DELIVERY_RE = [
  /\b(dispatch(?:ed)?|deliver(?:y|ed)?|ship(?:ped|ping)?|lead\s*time|ready|manufactur(?:e|ed|ing))\b[^.!?\n]{0,40}\b(within|in|takes?|by)\s+\d+(?:\s*(?:-|to)\s*\d+)?\s*(hours?|days?|weeks?|months?)\b/i,
  /\b\d+(?:\s*(?:-|to)\s*\d+)?\s*(days?|weeks?|months?)\b[^.!?\n]{0,30}\b(dispatch|delivery|lead\s*time)\b/i,
  /\b(dispatch(?:ed)?|deliver(?:ed|y)?)\s+(today|tomorrow|immediately|this week|next week)\b/i,
  /\bdoor[- ]?(?:step\s+)?delivery\b/i,
  /\bready\s+to\s+(dispatch|ship)\b/i,
];

const STOCK_RE = /\b([Ii]n|[Rr]eady|available\s+in|have\s+(?:it\s+)?in)\s+stock\b|\b([Gg]enuine|[Aa]uthentic)\s+[A-Z][a-z]+\b|\bguarantee(?:d)?\s+(?:availability|stock)\b/;

const TAX_RE = [
  /\b\d+(?:\.\d+)?\s*%\s*(?:gst|igst|cgst|sgst|tax)\b/i,
  /\b(?:gst|igst|cgst|sgst|tax)\b[^.!?\n]{0,20}\b\d+(?:\.\d+)?\s*%/i,
  /\b(?:inclusive|exclusive|including|excluding|incl\.?|excl\.?|plus|\+)\s*(?:of\s+)?(?:all\s+)?(?:gst|taxes|tax)\b/i,
  /\b(?:gst|taxes|tax)\b\s*(?:is|are|will be)?\s*(?:included|extra|inclusive|exclusive|additional|applicable|charged)\b/i,
];

const PAYMENT_ASK_RE = /\b(share|send|provide|give|enter|pay|transfer)\b[^.!?\n]{0,30}\b(upi|bank|account number|ifsc|gstin|gst number|pan|aadhaa?r|card|advance|payment)\b/i;
const NEGATION_RE = /\b(don'?t|do not|no need|not need|never|won'?t|can'?t|cannot|unable|not required|please avoid)\b/i;

const PHONE_RE = /(?:\+?91[\s-]?)?(?<!\d)(?:\d[\s-]?){9,11}\d(?!\d)/g;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()]+|\bwa\.me\/\S+/gi;

function isAllowedPrice(amount: number, allowed: number[]): boolean {
  return allowed.some((a) => Math.abs(a - amount) <= Math.max(1, a * 0.005));
}

function hostAllowed(url: string, domains: string[]): boolean {
  try {
    const host = new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
    return domains.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/** Returns the guardrail a sentence breaks, or null if it is safe to show. */
export function checkSentence(sentence: string, ctx: OutputContext, allowedAmounts = ctx.allowedPrices.flatMap(extractAmounts)): RuleId | null {
  const amounts = extractAmounts(sentence);
  if (amounts.some((a) => !isAllowedPrice(a, allowedAmounts))) return "G1_price";
  if (FREIGHT_RE.some((re) => re.test(sentence))) return "G2_freight";
  if (TAX_RE.some((re) => re.test(sentence))) return "G8_tax";
  if (DELIVERY_RE.some((re) => re.test(sentence))) return "G6_delivery";
  if (STOCK_RE.test(sentence) && !NEGATION_RE.test(sentence)) return "G4_stock";
  if (PAYMENT_ASK_RE.test(sentence) && !NEGATION_RE.test(sentence)) return "G5_payment";
  if (EMAIL_RE.test(sentence)) return "G3_contact";
  for (const m of sentence.matchAll(PHONE_RE)) {
    const digits = m[0].replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
    if (digits.length >= 10 && !ctx.allowedPhones.some((p) => p.endsWith(digits) || digits.endsWith(p))) return "G3_contact";
  }
  for (const m of sentence.matchAll(URL_RE)) {
    if (!hostAllowed(m[0].replace(/[.,;:!?]+$/, ""), ctx.allowedDomains)) return "G3_contact";
  }
  return null;
}

export interface Intervention {
  rule: RuleId;
  original: string;
}

// Split after sentence punctuation followed by whitespace, or at newlines, but not after
// abbreviations that precede an amount ("Rs. 4,50,000") or a number ("No. 5").
const BOUNDARY_RE = /(?<!\b(?:Rs|No|approx|Approx|Mr|Ms|Dr|Pvt|Ltd|St|vs|etc|e\.g|i\.e))([.!?।]+)(\s+)|(\n+)/g;

/**
 * Buffers streamed text and releases it a sentence at a time, replacing any sentence that
 * breaks a guardrail with a safe hand-off line.
 */
export class OutputFilter {
  readonly interventions: Intervention[] = [];
  private buffer = "";
  private usedReplacements = new Set<RuleId>();
  private allowedAmounts: number[];

  constructor(private ctx: OutputContext) {
    this.allowedAmounts = ctx.allowedPrices.flatMap(extractAmounts);
  }

  /** Feed a text delta; returns text that is safe to emit now. */
  push(delta: string): string {
    this.buffer += delta;
    let out = "";
    let last = 0;
    BOUNDARY_RE.lastIndex = 0;
    for (let m = BOUNDARY_RE.exec(this.buffer); m; m = BOUNDARY_RE.exec(this.buffer)) {
      const end = m.index + m[0].length;
      out += this.filterSentence(this.buffer.slice(last, end));
      last = end;
    }
    this.buffer = this.buffer.slice(last);
    return out;
  }

  /** Release whatever is left at the end of a text block. */
  flush(): string {
    const rest = this.buffer;
    this.buffer = "";
    return rest ? this.filterSentence(rest) : "";
  }

  private filterSentence(chunk: string): string {
    const trailing = chunk.match(/\s*$/)![0];
    const sentence = chunk.slice(0, chunk.length - trailing.length);
    if (!sentence.trim()) return chunk;
    const rule = checkSentence(sentence, this.ctx, this.allowedAmounts);
    if (!rule) return chunk;
    this.interventions.push({ rule, original: sentence });
    if (this.usedReplacements.has(rule)) return "";
    this.usedReplacements.add(rule);
    return REPLACEMENTS[rule] + (trailing || " ");
  }
}

export function logGuardrailEvent(event: Record<string, unknown>) {
  try {
    fs.mkdirSync(path.dirname(paths.guardrailLog), { recursive: true });
    fs.appendFileSync(paths.guardrailLog, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
  } catch (err) {
    console.error("failed to log guardrail event", err);
  }
}
