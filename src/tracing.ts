/**
 * Langfuse tracing. One trace per buyer message ("chat-turn"), grouped into Langfuse sessions by
 * chat, with the catalogue search, each Claude call, each tool call and guardrail edits under it.
 *
 * Off unless LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set; then `noTracing` is used and
 * nothing is sent. Buyer mobile numbers are masked before anything leaves the server, OTPs are
 * never recorded, and the system prompt is referenced by version instead of being copied.
 */
import { LangfuseClient } from "@langfuse/client";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, startActiveObservation, startObservation } from "@langfuse/tracing";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { config } from "./config.js";

export type ObservationType = "span" | "generation" | "tool" | "retriever" | "guardrail" | "event";

export interface ObservationAttrs {
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  statusMessage?: string;
  model?: string;
  modelParameters?: Record<string, string | number>;
  usageDetails?: Record<string, number>;
  costDetails?: Record<string, number>;
}

export interface Observation {
  update(attrs: ObservationAttrs): void;
  end(): void;
}

/** What `runTurn` uses to record observations under the current trace. */
export interface TraceSink {
  start(name: string, type: ObservationType, attrs?: ObservationAttrs): Observation;
}

export interface TraceContext {
  sessionId: string;
  userId?: string;
  tags?: string[];
  input?: unknown;
  metadata?: Record<string, unknown>;
}

export interface Score {
  /** Re-sending a score with the same id replaces it (e.g. a buyer changing their vote). */
  id?: string;
  traceId: string;
  name: string;
  value: number;
  dataType?: "NUMERIC" | "BOOLEAN";
  comment?: string;
}

export interface Tracing extends TraceSink {
  enabled: boolean;
  /** Runs `fn` inside a new trace; `root` is the trace's top observation and carries its id. */
  trace<T>(name: string, ctx: TraceContext, fn: (root: Observation & { traceId: string }) => Promise<T>): Promise<T>;
  score(s: Score): void;
  /** Sends everything still buffered (call before the process exits). */
  flush(): Promise<void>;
}

const noObservation: Observation = { update() {}, end() {} };

export const noTracing: Tracing = {
  enabled: false,
  start: () => noObservation,
  trace: (_name, _ctx, fn) => fn({ ...noObservation, traceId: "" }),
  score() {},
  flush: async () => {},
};

// ---- masking ----

/**
 * Indian mobile numbers: optional +91 / 0, then 10 digits starting 6-9, spaces or dashes allowed.
 * Bounded by non-digits only (not word boundaries), so a number right after an escaped newline in
 * serialized JSON ("\\n98765 43210") is still caught.
 */
const MOBILE_RE = /(?<![\d+])(?:\+?91[\s-]?|0)?[6-9](?:[\s-]?\d){9}(?!\d)/g;

/** "98765 43210" -> "xxxxxx3210". */
export const maskMobile = (m: string) => `xxxxxx${m.replace(/\D/g, "").slice(-4)}`;

/** Masks buyer mobile numbers anywhere in a value (strings, arrays, objects, JSON strings). */
export function maskPII<T>(value: T): T {
  if (typeof value === "string") return value.replace(MOBILE_RE, maskMobile) as T;
  if (Array.isArray(value)) return value.map(maskPII) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskPII(v)])) as T;
  }
  return value;
}

export const OTP_MASK = "•••••";

// ---- cost ----

/** USD per million tokens. Langfuse may not have prices for new models, so costs are sent with each call. */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Langfuse usage details for one Claude call. */
export const usageDetails = (u: TokenUsage) => ({
  input: u.input,
  output: u.output,
  cache_read_input_tokens: u.cacheRead,
  cache_creation_input_tokens: u.cacheWrite,
  total: u.input + u.output + u.cacheRead + u.cacheWrite,
});

/** Cost of one Claude call in USD, or undefined for a model without a known price. */
export function costDetails(model: string, u: TokenUsage): Record<string, number> | undefined {
  const p = PRICES[model] ?? PRICES[model.replace(/-\d{8}$/, "")];
  if (!p) return undefined;
  const d = {
    input: (u.input * p.input) / 1e6,
    output: (u.output * p.output) / 1e6,
    cache_read_input_tokens: (u.cacheRead * p.cacheRead) / 1e6,
    cache_creation_input_tokens: (u.cacheWrite * p.cacheWrite) / 1e6,
  };
  return { ...d, total: d.input + d.output + d.cache_read_input_tokens + d.cache_creation_input_tokens };
}

// ---- Langfuse ----

/** Starts Langfuse tracing when the keys are configured; otherwise returns `noTracing`. */
export function initTracing(env = config): Tracing {
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return noTracing;
  const baseUrl = env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com";
  const environment = env.LANGFUSE_ENVIRONMENT ?? (process.env.NODE_ENV || "development").toLowerCase();
  const release = process.env.RENDER_GIT_COMMIT?.slice(0, 12);
  const processor = new LangfuseSpanProcessor({
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
    baseUrl,
    environment,
    release,
    // Last line of defence: nothing leaves the server with a buyer's mobile number in it.
    mask: ({ data }) => maskPII(data),
  });
  const provider = new NodeTracerProvider({ spanProcessors: [processor] });
  provider.register();
  const client = new LangfuseClient({ publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY, baseUrl });

  const wrap = (o: { update(a: any): unknown; end(): void }): Observation => ({
    update: (a) => void o.update(a),
    end: () => o.end(),
  });

  console.log(`[tracing] Langfuse on (${baseUrl}, environment ${environment}${release ? `, release ${release}` : ""})`);
  return {
    enabled: true,
    start: (name, type, attrs = {}) => wrap(startObservation(name, attrs as any, { asType: type as any }) as any),
    trace: (name, ctx, fn) =>
      propagateAttributes({ traceName: name, sessionId: ctx.sessionId, userId: ctx.userId, tags: ctx.tags }, () =>
        startActiveObservation(name, async (root) => {
          root.update({ input: ctx.input, metadata: ctx.metadata });
          return fn({ ...wrap(root), traceId: root.traceId });
        }),
      ),
    score: (s) => client.score.create({ ...s, environment }),
    flush: async () => {
      await Promise.allSettled([processor.forceFlush(), client.score.flush()]);
    },
  };
}
