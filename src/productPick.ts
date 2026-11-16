/**
 * Measurement only: on test chats (Bot API Test keys), Claude (Haiku by default) is asked the exact
 * product question Jev gets, with the same state and the same shuffled options, so the two can be
 * compared on accuracy, tokens, latency and cost. Its answer is logged, never used: the product is
 * still decided by Jev (when on and sure) or the word rules.
 *
 * Also defines the per-call record that test chats get back in the Bot API's `debug` block.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Place } from "./isqTracker.js";
import { placeKey, productRequest, type ChoiceQuestion, type PickInput } from "./jev.js";
import type { TokenUsage } from "./tracing.js";

/** One model call in a turn, as returned to test chats (`debug.calls`). */
export interface CallRecord {
  kind: "reply" | "jev-pick" | "haiku-pick";
  model: string;
  /** Reply calls: the round within the turn (1 = first Claude call). */
  round?: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
  latencyMs: number;
  /** Reply calls: time until the first text arrived. */
  firstTokenMs?: number | null;
  /** Null when the model has no known price. */
  costUsd: number | null;
  /** Product picks: the product label, "keep", or null (unsure: the word rules decide). */
  decision?: string | null;
  reason?: string;
  confidence?: number | string | null;
  error?: string;
}

/** The product each picker chose this turn (labels), and the one the chat ended up with. */
export interface ProductPicks {
  /** The chat's product before this turn. */
  current?: string | null;
  wordRules?: string | null;
  jev?: string | null;
  haiku?: string | null;
  used?: string | null;
}

export type Confidence = "low" | "medium" | "high";

export interface ModelPick {
  decision: Place | "keep" | null;
  reason: string;
  choice?: string;
  confidence?: Confidence;
  aboutProduct?: boolean;
  otherProduct?: boolean;
  ms: number;
  usage?: TokenUsage;
  /** The model that answered. */
  model: string;
  error?: string;
}

/** Anything that answers the product question like Jev does (Claude here, a fake in tests). */
export interface ProductPicker {
  readonly model: string;
  pick(input: PickInput, rng?: () => number): Promise<ModelPick>;
}

export interface PickAnswer {
  product: string;
  about_product: boolean;
  other_product?: boolean;
  confidence: Confidence;
}

/**
 * The same decision rules as Jev's `pickProduct`, with the model's yes/no answers in place of Jev's
 * probabilities and its stated confidence in place of Jev's: "low" means unsure.
 */
export function modelDecision(input: PickInput, a: PickAnswer): Pick<ModelPick, "decision" | "reason"> {
  if (!a.about_product) return { decision: "keep", reason: "not about a product" };
  const picked = input.candidates.find((c) => c.key === a.product);
  if (!picked || a.confidence === "low") return { decision: null, reason: "unsure" };
  if (input.current) {
    if (placeKey(picked.place) === placeKey(input.current.place)) return { decision: "keep", reason: "same product" };
    if (a.other_product === false) return { decision: "keep", reason: "still the current product" };
    if (a.other_product !== true) return { decision: null, reason: "unsure about a switch" };
  }
  return { decision: picked.place, reason: input.current ? "switch" : "pick" };
}

const SYSTEM = [
  "You classify one message a buyer sent to a B2B seller's chat assistant, like a decision model: you answer typed questions and write nothing else.",
  "`state` holds the buyer's message and its context. `questions` holds each question with its options (`criteria`).",
  "Answer in the JSON format: `product` is the key of the option in `seller_products` the buyer means, or \"none\" if no option fits;",
  "`about_product` and `other_product` are true or false as their criteria describe; `confidence` is how sure you are of `product`.",
].join(" ");

/** Asks Claude the product question with structured output (one call, no retries: it runs inside a chat turn). */
export class ClaudeProductPicker implements ProductPicker {
  constructor(
    private readonly client: Anthropic,
    readonly model: string,
    private readonly timeoutMs = 8000,
  ) {}

  async pick(input: PickInput, rng?: () => number): Promise<ModelPick> {
    const req = productRequest(this.model, input, rng);
    const keys = Object.keys((req.questions.product as ChoiceQuestion).criteria);
    const properties: Record<string, unknown> = {
      product: { type: "string", enum: [...keys, "none"] },
      about_product: { type: "boolean" },
      ...(input.current ? { other_product: { type: "boolean" } } : {}),
      confidence: { type: "string", enum: ["low", "medium", "high"] },
    };
    const schema = { type: "object", additionalProperties: false, properties, required: Object.keys(properties) };
    const started = Date.now();
    try {
      const res = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: 1024,
          system: SYSTEM,
          messages: [{ role: "user", content: JSON.stringify({ state: req.state, questions: req.questions }) }],
          output_config: { effort: "low", format: { type: "json_schema", schema } },
        },
        { timeout: this.timeoutMs, maxRetries: 0 },
      );
      const ms = Date.now() - started;
      const usage: TokenUsage = {
        input: res.usage.input_tokens,
        output: res.usage.output_tokens,
        cacheRead: res.usage.cache_read_input_tokens ?? 0,
        cacheWrite: res.usage.cache_creation_input_tokens ?? 0,
      };
      const served = res.model || this.model;
      if (res.stop_reason === "refusal") return { decision: null, reason: "error", error: "declined (refusal)", ms, usage, model: served };
      const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      let a: PickAnswer;
      try {
        a = JSON.parse(text) as PickAnswer;
      } catch {
        return { decision: null, reason: "error", error: `unreadable answer (${res.stop_reason})`, ms, usage, model: served };
      }
      return { ...modelDecision(input, a), choice: a.product, confidence: a.confidence, aboutProduct: a.about_product, otherProduct: a.other_product, ms, usage, model: served };
    } catch (err) {
      return { decision: null, reason: "error", error: (err as Error).message.slice(0, 200), ms: Date.now() - started, model: this.model };
    }
  }
}
