import Anthropic from "@anthropic-ai/sdk";
import type { Catalogue } from "./catalogue.js";
import { formatCatalogueHits } from "./catalogue.js";
import { config } from "./config.js";
import type { CatalogueEntry } from "./crawler.js";
import { OutputFilter, REPLACEMENTS, type Intervention } from "./guardrails.js";
import type { KnowledgeBase } from "./kb.js";
import { renderUserPrompt } from "./prompts.js";
import type { Session } from "./session.js";
import type { MediaCard } from "./media.js";
import { describeLeadStatus, executeTool, toolDefinitions, type LeadSink, type MediaSharer } from "./tools.js";

export type AskFor = "mobile" | "otp" | "name" | null;

export interface ChatDeps {
  client: Anthropic;
  kb: KnowledgeBase;
  catalogue: Catalogue;
  systemPrompt: string;
  /** The seller's per-turn persona instruction, added to every buyer turn. */
  sellerInstructions?: string;
  /** Resolves share_media calls to cards (product cards, photos, videos, PDFs). */
  shareMedia?: MediaSharer;
  /** Where verified leads go (the database in production). */
  saveLead: LeadSink;
  /** Records sentences the output guardrails replaced. */
  logGuardrail?: (sessionId: string, interventions: Intervention[]) => void;
  model?: string;
}

export interface TurnCallbacks {
  onText?: (text: string) => void;
}

export interface TurnResult {
  text: string;
  askFor: AskFor;
  /** Reply buttons to show under the message (from show_options). */
  chips: string[];
  /** Media cards to show under the message (from share_media). */
  cards: MediaCard[];
  interventions: Intervention[];
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

const MAX_TOOL_ROUNDS = 4;
const MAX_HISTORY_TURNS = 40;

export const FALLBACK_REPLY =
  "Sorry, I'm having trouble answering right now. You can leave your mobile number and our team will get back to you.";
const REFUSAL_REPLY = "Sorry, I can't help with that here. I'm happy to help with any of our machines or pass your enquiry to our team.";
const LIMIT_REPLY = "This chat has become quite long. Please refresh the page to start a new chat, or leave your mobile number and our team will get back to you.";

function retrieve(session: Session, catalogue: Catalogue, buyerText: string, page?: CatalogueEntry | null): CatalogueEntry[] {
  let hits = catalogue.search(buyerText);
  // Follow-ups like "what is its price?" don't name the machine, so fall back to the last product query.
  if (hits.length === 0 && session.lastQuery) hits = catalogue.search(`${session.lastQuery} ${buyerText}`);
  else if (hits.length) session.lastQuery = buyerText;
  // The page the buyer is looking at is always relevant ("is this available in 3 m?").
  if (page) hits = [page, ...hits.filter((h) => h.url !== page.url)].slice(0, 4);
  for (const h of hits) session.seenCatalogue.set(h.url, h);
  return hits;
}

function askForAfterTurn(session: Session, text: string): AskFor {
  switch (session.lead.stage) {
    case "otp_sent":
      return "otp";
    case "verified":
      return "name";
    case "none":
    case "locked":
      return /\b(mobile|phone|contact)\s*(number|no\.?)\b|मोबाइल|મોબાઇલ/i.test(text) && /\?|share|enter|type|provide|bata|batao|aapo/i.test(text) ? "mobile" : null;
    default:
      return null;
  }
}

function correctionNote(interventions: Intervention[]): string {
  const rules = [...new Set(interventions.map((i) => i.rule))];
  return `Part of your previous reply was replaced before the buyer saw it because it broke a guardrail (${rules.join(", ")}). The buyer saw instead: "${rules
    .map((r) => REPLACEMENTS[r])
    .join(" ")}". Stay within the guardrails and do not repeat the removed content.`;
}

/**
 * Runs one buyer turn: retrieve catalogue context, call Claude with streaming, run any tool calls,
 * and stream guardrail-filtered text back through `onText`.
 */
export async function runTurn(
  session: Session,
  buyerText: string,
  deps: ChatDeps,
  cb: TurnCallbacks = {},
  opts: { pageUrl?: string; pageEntry?: CatalogueEntry | null } = {},
): Promise<TurnResult> {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (session.turns >= MAX_HISTORY_TURNS) {
    cb.onText?.(LIMIT_REPLY);
    return { text: LIMIT_REPLY, askFor: "mobile", chips: [], cards: [], interventions: [], usage };
  }

  const hits = retrieve(session, deps.catalogue, buyerText, opts.pageEntry);
  const userContent = renderUserPrompt({
    currentPage: opts.pageEntry ? `${opts.pageEntry.title} (${opts.pageEntry.url})` : undefined,
    leadStatus: describeLeadStatus(session.lead),
    catalogue: formatCatalogueHits(hits),
    buyerMessage: buyerText,
    operatorNotes: session.pendingNotes,
    sellerInstructions: deps.sellerInstructions,
  });

  // Work on a copy so a failed or refused turn leaves the stored history untouched.
  const messages: Anthropic.Beta.BetaMessageParam[] = [...session.messages, { role: "user", content: [{ type: "text", text: userContent }] }];

  const filter = new OutputFilter({
    // Guardrail 1: the bot never states a price, so no amount is ever allowed through.
    allowedPrices: [],
    allowedPhones: [...deps.kb.allowedPhones, ...(session.lead.mobile ? [session.lead.mobile] : [])],
    allowedDomains: deps.kb.allowedDomains,
  });

  let shown = "";
  let chips: string[] = [];
  const cards: MediaCard[] = [];
  const emit = (t: string) => {
    if (!t) return;
    shown += t;
    cb.onText?.(t);
  };

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const stream = deps.client.beta.messages.stream({
        model: deps.model ?? config.BOT_MODEL,
        max_tokens: 2048,
        system: [{ type: "text", text: deps.systemPrompt, cache_control: { type: "ephemeral" } }],
        // Auto-cache the conversation prefix as well, so long chats stay cheap.
        cache_control: { type: "ephemeral" },
        messages,
        tools: toolDefinitions,
        tool_choice: { type: "auto" },
        output_config: { effort: config.BOT_EFFORT },
        ...(config.BOT_FALLBACKS ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });

      let blockIsText = false;
      for await (const event of stream) {
        if (event.type === "content_block_start") {
          blockIsText = event.content_block.type === "text";
          if (blockIsText && shown && !/\s$/.test(shown)) emit("\n");
        } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          emit(filter.push(event.delta.text));
        } else if (event.type === "content_block_stop" && blockIsText) {
          emit(filter.flush());
          blockIsText = false;
        }
      }
      const final = await stream.finalMessage();
      emit(filter.flush());
      usage.input += final.usage.input_tokens;
      usage.output += final.usage.output_tokens;
      usage.cacheRead += final.usage.cache_read_input_tokens ?? 0;
      usage.cacheWrite += final.usage.cache_creation_input_tokens ?? 0;

      if (final.stop_reason === "refusal") {
        // Never run tools from a refused turn, and don't keep it in history.
        if (!shown.trim()) emit(REFUSAL_REPLY);
        return { text: shown, askFor: null, chips: [], cards: [], interventions: filter.interventions, usage };
      }

      // Append-only: keep the model's content exactly as returned (thinking blocks included).
      messages.push({ role: "assistant", content: final.content });

      const toolUses = final.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (final.stop_reason !== "tool_use" || toolUses.length === 0) break;
      if (round === MAX_TOOL_ROUNDS) {
        if (!shown.trim()) emit(FALLBACK_REPLY);
        break;
      }

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = toolUses.map((tu) => {
        const r = executeTool(session, tu.name, tu.input, { saveLead: deps.saveLead, pageUrl: opts.pageUrl, shareMedia: deps.shareMedia });
        if (r.ui?.chips) chips = r.ui.chips;
        if (r.ui?.cards) for (const c of r.ui.cards) if (cards.length < 12 && !cards.some((x) => x.url === c.url && x.type === c.type)) cards.push(c);
        return { type: "tool_result", tool_use_id: tu.id, content: r.content, is_error: r.isError };
      });
      messages.push({ role: "user", content: results });
    }
  } catch (err) {
    logApiError(err);
    if (!shown.trim()) emit(FALLBACK_REPLY);
    return { text: shown, askFor: "mobile", chips: [], cards: [], interventions: filter.interventions, usage };
  }

  if (!shown.trim()) emit(FALLBACK_REPLY);

  session.messages = messages;
  session.turns++;
  session.pendingNotes = filter.interventions.length ? [correctionNote(filter.interventions)] : [];
  if (filter.interventions.length) {
    (deps.logGuardrail ?? ((id, iv) => console.warn(`[guardrail] ${id}`, iv.map((i) => i.rule).join(","))))(session.id, filter.interventions);
  }
  const askFor = askForAfterTurn(session, shown);
  // Buttons only make sense when the buyer isn't being asked for a mobile number, OTP or name.
  return { text: shown, askFor, chips: askFor ? [] : chips, cards, interventions: filter.interventions, usage };
}

function logApiError(err: unknown) {
  if (err instanceof Anthropic.RateLimitError) console.error("[claude] rate limited", err.message);
  else if (err instanceof Anthropic.AuthenticationError) console.error("[claude] authentication failed - check ANTHROPIC_API_KEY");
  else if (err instanceof Anthropic.BadRequestError) console.error("[claude] bad request", err.message);
  else if (err instanceof Anthropic.APIError) console.error(`[claude] API error ${err.status}`, err.message);
  else console.error("[claude] unexpected error", err);
}
