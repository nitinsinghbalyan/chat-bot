/**
 * Langfuse tracing. One trace per buyer message ("chat-turn"), grouped into Langfuse sessions by
 * chat, with the catalogue search, each Claude call, each tool call and guardrail edits under it.
 *
 * Off unless LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set; then `noTracing` is used and
 * nothing is sent. Buyer mobile numbers are masked before anything leaves the server, OTPs are
 * never recorded, and the system prompt is referenced by version instead of being copied.
 */
import { LangfuseClient } from "@langfuse/client";
import { diag, DiagLogLevel } from "@opentelemetry/api";
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
  /** Scores one trace (one buyer message) ... */
  traceId?: string;
  /** ... or a whole Langfuse session (one chat), e.g. the running chat cost. */
  sessionId?: string;
  name: string;
  value: number;
  dataType?: "NUMERIC" | "BOOLEAN";
  comment?: string;
}

/** Whether traces are reaching Langfuse, for /health, the admin page and the startup log. */
export interface TracingStatus {
  /** off: no keys. ok: Langfuse accepted the keys. auth_failed: it rejected them. unreachable: no answer (traces still try). */
  state: "off" | "ok" | "auth_failed" | "unreachable";
  /** The Langfuse host traces go to, e.g. cloud.langfuse.com. */
  host: string | null;
  message: string;
  /** Failed exports since startup, and the last error (from the OpenTelemetry exporter). */
  exportErrors: number;
  lastExportError?: string;
}

export interface Tracing extends TraceSink {
  enabled: boolean;
  status: TracingStatus;
  /** Runs `fn` inside a new trace; `root` is the trace's top observation and carries its id. */
  trace<T>(name: string, ctx: TraceContext, fn: (root: Observation & { traceId: string }) => Promise<T>): Promise<T>;
  score(s: Score): void;
  /** Sends everything still buffered (call before the process exits). */
  flush(): Promise<void>;
}

const noObservation: Observation = { update() {}, end() {} };

export const noTracing: Tracing = {
  enabled: false,
  status: { state: "off", host: null, message: "Langfuse is off: LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are not set.", exportErrors: 0 },
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

export const LANGFUSE_EU = "https://cloud.langfuse.com";
export const LANGFUSE_US = "https://us.cloud.langfuse.com";

type LangfuseEnv = Pick<typeof config, "LANGFUSE_PUBLIC_KEY" | "LANGFUSE_SECRET_KEY" | "LANGFUSE_BASE_URL" | "LANGFUSE_ENVIRONMENT">;

/** Asks Langfuse whether it accepts the keys (GET /api/public/projects). */
async function probe(baseUrl: string, publicKey: string, secretKey: string, fetchImpl: typeof fetch): Promise<"ok" | "auth_failed" | "unreachable"> {
  try {
    const r = await fetchImpl(`${baseUrl}/api/public/projects`, {
      headers: { Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}` },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) return "ok";
    return r.status === 401 || r.status === 403 ? "auth_failed" : "unreachable";
  } catch {
    return "unreachable";
  }
}

/**
 * Works out where traces should go and whether Langfuse accepts the keys. With no
 * LANGFUSE_BASE_URL, keys rejected by the EU cloud are tried on the US cloud, since keys from a
 * US project otherwise fail silently.
 */
export async function resolveLangfuse(env: LangfuseEnv, fetchImpl: typeof fetch = fetch): Promise<{ baseUrl: string; state: TracingStatus["state"]; message: string }> {
  const pk = env.LANGFUSE_PUBLIC_KEY ?? "";
  const sk = env.LANGFUSE_SECRET_KEY ?? "";
  const hints: string[] = [];
  if (pk.startsWith("sk-lf-") && sk.startsWith("pk-lf-")) hints.push("the public and secret keys look swapped");
  else {
    if (!pk.startsWith("pk-lf-")) hints.push("LANGFUSE_PUBLIC_KEY should start with pk-lf-");
    if (!sk.startsWith("sk-lf-")) hints.push("LANGFUSE_SECRET_KEY should start with sk-lf-");
  }
  const tried = env.LANGFUSE_BASE_URL ? [env.LANGFUSE_BASE_URL.replace(/\/+$/, "")] : [LANGFUSE_EU, LANGFUSE_US];
  let first: "ok" | "auth_failed" | "unreachable" | null = null;
  for (const baseUrl of tried) {
    const state = await probe(baseUrl, pk, sk, fetchImpl);
    first ??= state;
    if (state === "ok") {
      const moved = baseUrl !== tried[0] ? ` The keys belong to ${host(baseUrl)}; set LANGFUSE_BASE_URL=${baseUrl} to skip this check.` : "";
      return { baseUrl, state, message: `Langfuse accepted the keys.${moved}` };
    }
    if (state === "unreachable") break;
  }
  const baseUrl = tried[0];
  if (first === "unreachable") return { baseUrl, state: "unreachable", message: `Could not reach ${host(baseUrl)} to check the keys; traces will still be sent.` };
  return {
    baseUrl,
    state: "auth_failed",
    message: `Langfuse rejected the keys at ${tried.map(host).join(" and ")}, so no traces are recorded. Copy both keys again from Langfuse (Settings > API keys, same project)${
      env.LANGFUSE_BASE_URL ? " and check LANGFUSE_BASE_URL is that project's region" : ""
    }${hints.length ? `; ${hints.join("; ")}` : ""}.`,
  };
}

const host = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");

/** Starts Langfuse tracing when the keys are configured; otherwise returns `noTracing`. */
export async function initTracing(env: LangfuseEnv = config, fetchImpl: typeof fetch = fetch): Promise<Tracing> {
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) {
    console.log("[tracing] Langfuse off (set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY to turn it on)");
    return noTracing;
  }
  const { baseUrl, state, message } = await resolveLangfuse(env, fetchImpl);
  const environment = env.LANGFUSE_ENVIRONMENT ?? (process.env.NODE_ENV || "development").toLowerCase();
  const release = process.env.RENDER_GIT_COMMIT?.slice(0, 12);
  const status: TracingStatus = { state, host: host(baseUrl), message, exportErrors: 0 };
  // Export failures are otherwise silent: log them and show them on /health and the admin page.
  const exportError = (msg: unknown, ...args: unknown[]) => {
    status.exportErrors++;
    // OpenTelemetry passes errors as JSON strings with a stack; keep the first line ("OTLPExporterError: Unauthorized").
    const describe = (a: unknown): string => {
      if (typeof a === "string") {
        try {
          const parsed = JSON.parse(a);
          if (parsed && typeof parsed === "object") return describe(parsed);
        } catch {}
        return a.split("\n")[0];
      }
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      const o = a as { message?: unknown; stack?: unknown } | null;
      return String(o?.stack || o?.message || JSON.stringify(a)).split("\n")[0];
    };
    status.lastExportError = [msg, ...args].map(describe).join(" ").slice(0, 300);
    console.error("[tracing] export failed:", status.lastExportError);
  };
  diag.setLogger({ error: exportError, warn: (m, ...a) => console.warn("[tracing]", m, ...a), info() {}, debug() {}, verbose() {} }, DiagLogLevel.WARN);

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

  const line = `[tracing] Langfuse on (${baseUrl}, environment ${environment}${release ? `, release ${release}` : ""}): ${message}`;
  if (state === "auth_failed") console.error(line);
  else console.log(line);
  return {
    enabled: true,
    status,
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
