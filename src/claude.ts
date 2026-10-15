import Anthropic from "@anthropic-ai/sdk";
import type { Catalogue } from "./catalogue.js";
import { formatCatalogueHits } from "./catalogue.js";
import { formatFaqHits, type FaqIndex } from "./faq.js";
import { config } from "./config.js";
import type { CatalogueEntry } from "./crawler.js";
import { OutputFilter, REPLACEMENTS, type Intervention } from "./guardrails.js";
import type { KnowledgeBase } from "./kb.js";
import { renderUserPrompt } from "./prompts.js";
import type { Session } from "./session.js";
import type { MediaCard } from "./media.js";
import { describeLeadStatus, executeTool, toolDefinitions, type EnquirySummary, type LeadSink, type MediaSharer } from "./tools.js";
import { costDetails, noTracing, OTP_MASK, usageDetails, type Observation, type TraceSink } from "./tracing.js";

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
  /** Records observations (search, Claude calls, tools, guardrails) under the current Langfuse trace. */
  trace?: TraceSink;
  /** The common FAQ rows that apply to this seller, searched per buyer message. */
  faq?: FaqIndex | null;
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
  /** What this turn's Claude calls cost in USD (all rounds, failed ones included). */
  costUsd: number;
  /** False when a call used a model without a known price; costUsd then leaves it out. */
  costKnown: boolean;
  /** The enquiry summary card to show (from save_lead with complete set). */
  summary?: EnquirySummary;
  /** save_lead outcomes this turn, for trace scores. */
  leadEvents?: Array<"captured" | "updated">;
  /** True when the buyer got a canned reply (API error, refusal or empty answer). */
  fallbackReply?: boolean;
}

const MAX_TOOL_ROUNDS = 4;
const MAX_HISTORY_TURNS = 40;

export const FALLBACK_REPLY =
  "Sorry, I'm having trouble answering right now. You can leave your mobile number and our team will get back to you.";
const REFUSAL_REPLY = "Sorry, I can't help with that here. I'm happy to help with any of our machines or pass your enquiry to our team.";
const LIMIT_REPLY = "This chat has become quite long. Please refresh the page to start a new chat, or leave your mobile number and our team will get back to you.";

function retrieve(
  session: Session,
  catalogue: Catalogue,
  buyerText: string,
  page?: CatalogueEntry | null,
  trace: TraceSink = noTracing,
  forTrace: (t: string) => string = (t) => t,
): CatalogueEntry[] {
  const obs = trace.start("catalogue-search", "retriever", { input: { query: forTrace(buyerText), currentPage: page?.url ?? null } });
  let hits = catalogue.search(buyerText);
  let query = buyerText;
  // Follow-ups like "what is its price?" don't name the machine, so fall back to the last product query.
  if (hits.length === 0 && session.lastQuery) hits = catalogue.search((query = `${session.lastQuery} ${buyerText}`));
  else if (hits.length) session.lastQuery = buyerText;
  // The page the buyer is looking at is always relevant ("is this available in 3 m?").
  if (page) hits = [page, ...hits.filter((h) => h.url !== page.url)].slice(0, 4);
  for (const h of hits) session.seenCatalogue.set(h.url, h);
  obs.update({
    output: hits.map((h) => ({ title: h.title, id: h.slug, kind: h.kind, currentPage: h.url === page?.url || undefined })),
    metadata: { searchedFor: forTrace(query), usedLastQuery: query !== buyerText, catalogueSize: catalogue.size },
  });
  obs.end();
  return hits;
}

/** The OTP the buyer typed never goes into a trace. */
function maskOtpBlocks(content: unknown[]): unknown[] {
  return content.map((b: any) => (b?.type === "tool_use" && b.name === "verify_otp" ? { ...b, input: { otp: OTP_MASK } } : b));
}

/** Claude's content for the trace: text and tool calls; empty thinking blocks (the default display) left out. */
const traceOutput = (content: Anthropic.Beta.BetaContentBlock[]) =>
  maskOtpBlocks(content.filter((b) => !(b.type === "thinking" && !b.thinking) && b.type !== "redacted_thinking"));

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
  const cost = { costUsd: 0, costKnown: true };
  if (session.turns >= MAX_HISTORY_TURNS) {
    cb.onText?.(LIMIT_REPLY);
    return { text: LIMIT_REPLY, askFor: "mobile", chips: [], cards: [], interventions: [], usage, ...cost };
  }

  const trace = deps.trace ?? noTracing;
  const leadStageBefore = session.lead.stage;
  // While an OTP is expected, the buyer's message is the code: keep it out of the trace.
  const traceText = (t: string) => (leadStageBefore === "otp_sent" ? t.split(buyerText).join(OTP_MASK) : t);
  const hits = retrieve(session, deps.catalogue, buyerText, opts.pageEntry, trace, traceText);
  let faqHits: ReturnType<FaqIndex["search"]> = [];
  if (deps.faq?.size && leadStageBefore !== "otp_sent") {
    const obs = trace.start("faq-search", "retriever", { input: { query: buyerText }, metadata: { faqRows: deps.faq.size } });
    faqHits = deps.faq.search(buyerText);
    obs.update({ output: faqHits.map((r) => r.question) });
    obs.end();
  }
  const userContent = renderUserPrompt({
    currentPage: opts.pageEntry ? `${opts.pageEntry.title} (${opts.pageEntry.url})` : undefined,
    leadStatus: describeLeadStatus(session.lead),
    catalogue: formatCatalogueHits(hits),
    buyerMessage: buyerText,
    operatorNotes: session.pendingNotes,
    sellerInstructions: deps.sellerInstructions,
    faq: formatFaqHits(faqHits),
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
  let summary: EnquirySummary | undefined;
  const leadEvents: Array<"captured" | "updated"> = [];
  let gen: Observation | null = null;
  let roundInput: unknown = [{ role: "user", content: traceText(userContent) }];
  const cards: MediaCard[] = [];
  const emit = (t: string) => {
    if (!t) return;
    shown += t;
    cb.onText?.(t);
  };

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const model = deps.model ?? config.BOT_MODEL;
      // Only this round's new messages: the history is in earlier traces, the system prompt is referenced by version.
      gen = trace.start(`claude round ${round + 1}`, "generation", {
        model,
        modelParameters: { effort: config.BOT_EFFORT, max_tokens: 2048, tool_choice: "auto" },
        input: roundInput,
        metadata: { round: round + 1, historyMessages: messages.length - 1 },
      });
      const stream = deps.client.beta.messages.stream({
        model,
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
      const callUsage = {
        input: final.usage.input_tokens,
        output: final.usage.output_tokens,
        cacheRead: final.usage.cache_read_input_tokens ?? 0,
        cacheWrite: final.usage.cache_creation_input_tokens ?? 0,
      };
      usage.input += callUsage.input;
      usage.output += callUsage.output;
      usage.cacheRead += callUsage.cacheRead;
      usage.cacheWrite += callUsage.cacheWrite;
      // final.model is the model that actually answered (a server-side fallback can switch it).
      const served = final.model || model;
      const fellBack = final.content.some((b) => (b as { type: string }).type === "fallback");
      const callCost = costDetails(served, callUsage);
      if (callCost) cost.costUsd += callCost.total;
      else cost.costKnown = false;
      gen.update({
        model: served,
        output: traceOutput(final.content),
        usageDetails: usageDetails(callUsage),
        costDetails: callCost,
        metadata: { stop_reason: final.stop_reason, requestedModel: model, fallback: fellBack || served !== model },
        ...(final.stop_reason === "refusal" ? { level: "WARNING" as const, statusMessage: "Claude declined (refusal)" } : {}),
      });
      gen.end();
      gen = null;

      if (final.stop_reason === "refusal") {
        // Never run tools from a refused turn, and don't keep it in history.
        const canned = !shown.trim();
        if (canned) emit(REFUSAL_REPLY);
        return { text: shown, askFor: null, chips: [], cards: [], interventions: filter.interventions, usage, ...cost, leadEvents, fallbackReply: canned };
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
        const stageBefore = session.lead.stage;
        const tool = trace.start(tu.name, "tool", { input: tu.name === "verify_otp" ? { otp: OTP_MASK } : tu.input });
        const r = executeTool(session, tu.name, tu.input, { saveLead: deps.saveLead, pageUrl: opts.pageUrl, shareMedia: deps.shareMedia });
        if (r.ui?.chips) chips = r.ui.chips;
        if (r.ui?.summary) summary = r.ui.summary;
        if (r.ui?.cards) for (const c of r.ui.cards) if (cards.length < 12 && !cards.some((x) => x.url === c.url && x.type === c.type)) cards.push(c);
        if (tu.name === "save_lead" && !r.isError) leadEvents.push(stageBefore === "captured" ? "updated" : "captured");
        tool.update({
          output: { result: r.content, ...(r.ui?.chips ? { chips: r.ui.chips } : {}), ...(r.ui?.cards ? { cards: r.ui.cards.map((c) => `${c.type}: ${c.title}`) } : {}), ...(r.ui?.summary ? { summary: r.ui.summary } : {}) },
          metadata: { leadStage: session.lead.stage },
          ...(r.isError ? { level: "ERROR" as const, statusMessage: r.content.slice(0, 200) } : {}),
        });
        tool.end();
        return { type: "tool_result", tool_use_id: tu.id, content: r.content, is_error: r.isError };
      });
      messages.push({ role: "user", content: results });
      roundInput = results;
    }
  } catch (err) {
    logApiError(err);
    gen?.update({ level: "ERROR", statusMessage: apiErrorMessage(err) });
    gen?.end();
    const canned = !shown.trim();
    if (canned) emit(FALLBACK_REPLY);
    // A save_lead that already ran still shows its summary.
    return { text: shown, askFor: "mobile", chips: [], cards: [], interventions: filter.interventions, usage, ...cost, leadEvents, fallbackReply: canned, summary };
  }

  const canned = !shown.trim();
  if (canned) emit(FALLBACK_REPLY);

  session.messages = messages;
  session.turns++;
  session.pendingNotes = filter.interventions.length ? [correctionNote(filter.interventions)] : [];
  if (filter.interventions.length) {
    const g = trace.start("output-guardrails", "guardrail", {
      input: filter.interventions.map((i) => ({ rule: i.rule, removed: i.original })),
      output: filter.interventions.map((i) => REPLACEMENTS[i.rule]),
      level: "WARNING",
      statusMessage: [...new Set(filter.interventions.map((i) => i.rule))].join(", "),
    });
    g.end();
    (deps.logGuardrail ?? ((id, iv) => console.warn(`[guardrail] ${id}`, iv.map((i) => i.rule).join(","))))(session.id, filter.interventions);
  }
  const askFor = askForAfterTurn(session, shown);
  // Buttons only make sense when the buyer isn't being asked for a mobile number, OTP or name.
  return { text: shown, askFor, chips: askFor ? [] : chips, cards, interventions: filter.interventions, usage, ...cost, leadEvents, fallbackReply: canned, summary };
}

function apiErrorMessage(err: unknown): string {
  if (err instanceof Anthropic.APIError) return `${err.constructor.name} ${err.status ?? ""}: ${err.message}`.slice(0, 300);
  return err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : String(err).slice(0, 300);
}

function logApiError(err: unknown) {
  if (err instanceof Anthropic.RateLimitError) console.error("[claude] rate limited", err.message);
  else if (err instanceof Anthropic.AuthenticationError) console.error("[claude] authentication failed - check ANTHROPIC_API_KEY");
  else if (err instanceof Anthropic.BadRequestError) console.error("[claude] bad request", err.message);
  else if (err instanceof Anthropic.APIError) console.error(`[claude] API error ${err.status}`, err.message);
  else console.error("[claude] unexpected error", err);
}
