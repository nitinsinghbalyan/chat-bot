/**
 * Langfuse tracing. One trace per buyer message ("chat-turn"), grouped into Langfuse sessions by
 * chat, with the catalogue search, each Claude call, each tool call and guardrail edits under it.
 *
 * Off unless LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set; then `noTracing` is used and
 * nothing is sent. Buyer mobile numbers are masked before anything leaves the server, OTPs are
 * never recorded, and the system prompt is referenced by version instead of being copied.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { LangfuseClient } from "@langfuse/client";
import { diag, DiagLogLevel } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { CompressionAlgorithm } from "@opentelemetry/otlp-exporter-base";
import type { ReadableSpan, Span, SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base";
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
  /** Full base URL and project id, for links to sessions in the Langfuse UI (known once the keys check passed). */
  baseUrl?: string;
  projectId?: string;
  message: string;
  /** The Langfuse server version, from /api/public/health. */
  version?: string;
  /** Uploads of trace batches since startup: successful, failed, and the latest one. */
  exports: number;
  spansExported: number;
  exportErrors: number;
  lastExportAt?: string;
  lastExportOk?: boolean;
  lastExportError?: string;
  /** The latest result of the admin "Test Langfuse" check. */
  lastTest?: ConnectionTest;
}

/** One step of the Langfuse connection test: ok, failed, or not run / unknown (null). */
export interface TestStep {
  label: string;
  ok: boolean | null;
  detail: string;
}

export interface ConnectionTest {
  at: string;
  ok: boolean;
  steps: TestStep[];
  /** Link to the test trace in the Langfuse UI. */
  traceUrl?: string;
  /** What to do next, in one or two sentences. */
  verdict: string;
}

export interface Tracing extends TraceSink {
  enabled: boolean;
  status: TracingStatus;
  /** Runs `fn` inside a new trace; `root` is the trace's top observation and carries its id. */
  trace<T>(name: string, ctx: TraceContext, fn: (root: Observation & { traceId: string }) => Promise<T>): Promise<T>;
  score(s: Score): void;
  /** Sends everything still buffered (call before the process exits). */
  flush(): Promise<void>;
  /** Sends a test trace and checks every step on the way into Langfuse (admin "Test Langfuse"). */
  testConnection(): Promise<ConnectionTest>;
}

const noObservation: Observation = { update() {}, end() {} };

export const noTracing: Tracing = {
  enabled: false,
  status: { state: "off", host: null, message: "Langfuse is off: LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are not set.", exports: 0, spansExported: 0, exportErrors: 0 },
  start: () => noObservation,
  trace: (_name, _ctx, fn) => fn({ ...noObservation, traceId: "" }),
  score() {},
  flush: async () => {},
  testConnection: async () => ({
    at: new Date().toISOString(),
    ok: false,
    steps: [{ label: "Keys", ok: false, detail: "LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are not set on the server." }],
    verdict: "Tracing is off. Add the two keys on Render (and LANGFUSE_BASE_URL for a self-hosted Langfuse), then redeploy.",
  }),
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
let probedProjectId: string | undefined;
async function probe(baseUrl: string, publicKey: string, secretKey: string, fetchImpl: typeof fetch): Promise<"ok" | "auth_failed" | "unreachable"> {
  try {
    const r = await fetchImpl(`${baseUrl}/api/public/projects`, {
      headers: { Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}` },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const body = (await r.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null;
      probedProjectId = typeof body?.data?.[0]?.id === "string" ? body.data[0].id : undefined;
      return "ok";
    }
    return r.status === 401 || r.status === 403 ? "auth_failed" : "unreachable";
  } catch {
    return "unreachable";
  }
}

/** A link to a session (one chat) in the Langfuse UI, when the project is known. */
export function langfuseSessionUrl(status: TracingStatus, sessionId: string): string | null {
  return status.baseUrl && status.projectId ? `${status.baseUrl}/project/${status.projectId}/sessions/${encodeURIComponent(sessionId)}` : null;
}

/** The chat a trace belongs to, set by `trace()` for every span started inside it. */
const traceScope = new AsyncLocalStorage<{ sessionId: string; userId?: string }>();

/**
 * Stamps the session and user on every span under both attribute names: the current one
 * ("session.id") and the one older Langfuse servers read ("langfuse.session.id"). Without the
 * second, a self-hosted Langfuse that predates the new name shows traces without a session.
 */
export class SessionStampProcessor implements SpanProcessor {
  onStart(span: Span): void {
    const scope = traceScope.getStore();
    if (!scope) return;
    span.setAttribute("session.id", scope.sessionId);
    span.setAttribute("langfuse.session.id", scope.sessionId);
    if (scope.userId) {
      span.setAttribute("user.id", scope.userId);
      span.setAttribute("langfuse.user.id", scope.userId);
    }
  }
  onEnd(): void {}
  forceFlush() {
    return Promise.resolve();
  }
  shutdown() {
    return Promise.resolve();
  }
}

/** Runs `fn` with the chat's session (and user) attached to every span it starts. */
export const withTraceScope = <T>(scope: { sessionId: string; userId?: string }, fn: () => T): T => traceScope.run(scope, fn);

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

/** One readable line for an export error ("OTLPExporterError: Not Found (HTTP 404) {...}"). */
export function describeError(a: unknown): string {
  if (typeof a === "string") {
    // OpenTelemetry's error handler passes errors as JSON strings with a stack.
    try {
      const parsed = JSON.parse(a);
      if (parsed && typeof parsed === "object") return describeError(parsed);
    } catch {}
    return a.split("\n")[0].slice(0, 300);
  }
  const o = (a ?? {}) as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown; data?: unknown };
  const named = o.message ? `${typeof o.name === "string" && o.name ? `${o.name}: ` : ""}${String(o.message)}` : "";
  const head = a instanceof Error ? `${a.name}: ${a.message}` : String(o.stack || named || JSON.stringify(a)).split("\n")[0];
  const code = typeof o.code === "number" ? ` (HTTP ${o.code})` : "";
  const body = typeof o.data === "string" && o.data.trim() ? ` ${o.data.trim().slice(0, 160)}` : "";
  return `${head}${code}${body}`.slice(0, 300);
}

/** Wraps the span exporter and records how every upload went, so /health and admin can show it. */
export class RecordingExporter implements SpanExporter {
  constructor(
    private delegate: SpanExporter,
    private status: TracingStatus,
  ) {}
  export(spans: ReadableSpan[], done: (r: ExportResult) => void): void {
    this.delegate.export(spans, (r) => {
      this.status.lastExportAt = new Date().toISOString();
      if (r.code === ExportResultCode.SUCCESS) {
        this.status.exports++;
        this.status.spansExported += spans.length;
        this.status.lastExportOk = true;
      } else {
        this.status.exportErrors++;
        this.status.lastExportOk = false;
        this.status.lastExportError = describeError(r.error ?? "export failed");
        console.error(`[tracing] export of ${spans.length} spans failed: ${this.status.lastExportError}`);
      }
      done(r);
    });
  }
  shutdown() {
    return this.delegate.shutdown();
  }
  forceFlush() {
    return this.delegate.forceFlush?.() ?? Promise.resolve();
  }
}

/** The SDK's own exporter settings (endpoint, headers, gzip), so traces look exactly as @langfuse/otel sends them. */
function langfuseExporter(baseUrl: string, publicKey: string, secretKey: string): SpanExporter {
  return new OTLPTraceExporter({
    url: `${baseUrl}/api/public/otel/v1/traces`,
    headers: {
      Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`,
      "x-langfuse-sdk-name": "javascript",
      "x-langfuse-sdk-version": LANGFUSE_SDK_VERSION,
      "x-langfuse-public-key": publicKey,
      "x-langfuse-ingestion-version": "4",
    },
    compression: CompressionAlgorithm.GZIP,
    timeoutMillis: 20_000,
  });
}

/** Version of the @langfuse/* packages in package.json. */
const LANGFUSE_SDK_VERSION = "6.0.0";
/** The oldest Langfuse server major version that accepts OpenTelemetry traces. */
const MIN_SERVER_MAJOR = 3;

/** Reads the server version from /api/public/health ({status, version}); undefined when it can't be read. */
export async function langfuseVersion(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const r = await fetchImpl(`${baseUrl}/api/public/health`, { signal: AbortSignal.timeout(8000) });
    const body = (await r.json().catch(() => null)) as { version?: unknown } | null;
    return typeof body?.version === "string" ? body.version : undefined;
  } catch {
    return undefined;
  }
}

/** A warning when the server is too old for OpenTelemetry traces, else null. */
export function versionWarning(version: string | undefined): string | null {
  const major = Number(version?.replace(/^v/, "").split(".")[0]);
  if (!version || !Number.isFinite(major)) return null;
  return major < MIN_SERVER_MAJOR
    ? `This Langfuse is version ${version}. It has no OpenTelemetry endpoint (added in Langfuse 3), so this SDK's traces can't be stored. Upgrade the Langfuse server.`
    : null;
}

export interface ConnectionTestDeps {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  environment: string;
  status: TracingStatus;
  fetchImpl: typeof fetch;
  /** Sends one trace, flushes it, and returns its id. */
  sendTrace(): Promise<string>;
  /** How long to look for the stored trace (default 20s), and how often. */
  waitMs?: number;
  pollMs?: number;
}

/**
 * The admin "Test Langfuse" check: server version, keys, one test trace upload, and whether
 * Langfuse then returns that trace from its API. The step that fails names the cause.
 */
export async function runConnectionTest(d: ConnectionTestDeps): Promise<ConnectionTest> {
  const steps: TestStep[] = [];
  const at = new Date().toISOString();
  const authHeader = { Authorization: `Basic ${Buffer.from(`${d.publicKey}:${d.secretKey}`).toString("base64")}` };
  const done = (ok: boolean, verdict: string, traceUrl?: string): ConnectionTest => ({ at, ok, steps, verdict, traceUrl });

  // 1. Server and version
  const version = await langfuseVersion(d.baseUrl, d.fetchImpl);
  const tooOld = versionWarning(version);
  steps.push({ label: "Langfuse server", ok: tooOld ? false : version ? true : null, detail: version ? `${host(d.baseUrl)}, version ${version}` : `${host(d.baseUrl)} (version not reported)` });
  if (tooOld) return done(false, tooOld);

  // 2. Keys, and the project they belong to
  let projectId: string | undefined;
  let projectName = "";
  try {
    const r = await d.fetchImpl(`${d.baseUrl}/api/public/projects`, { headers: authHeader, signal: AbortSignal.timeout(8000) });
    if (!r.ok) {
      steps.push({ label: "Keys", ok: false, detail: `Langfuse answered HTTP ${r.status}` });
      return done(false, "Langfuse rejected the keys. Copy the public and secret key again from the same project (Settings > API keys) and redeploy.");
    }
    const body = (await r.json().catch(() => null)) as { data?: Array<{ id?: string; name?: string }> } | null;
    projectId = body?.data?.[0]?.id;
    projectName = body?.data?.[0]?.name ?? "";
    steps.push({ label: "Keys", ok: true, detail: projectName ? `Accepted, project "${projectName}"` : "Accepted" });
  } catch (err) {
    steps.push({ label: "Keys", ok: false, detail: `Could not reach Langfuse: ${describeError(err)}` });
    return done(false, `The server can't reach ${host(d.baseUrl)}. If this Langfuse is on a private network, it has to be reachable from Render.`);
  }

  // 3. Upload one trace
  const before = { ok: d.status.exports, failed: d.status.exportErrors };
  let traceId: string;
  try {
    traceId = await d.sendTrace();
  } catch (err) {
    steps.push({ label: "Send a test trace", ok: false, detail: describeError(err) });
    return done(false, "The test trace could not be created on this server.");
  }
  if (d.status.exportErrors > before.failed) {
    steps.push({ label: "Send a test trace", ok: false, detail: `Upload refused: ${d.status.lastExportError ?? "unknown error"}` });
    return done(
      false,
      "Langfuse refused the trace upload (POST /api/public/otel/v1/traces). A 404 means this Langfuse version has no OpenTelemetry endpoint; upgrade it. Other errors usually come from a proxy or size limit in front of Langfuse.",
    );
  }
  if (d.status.exports === before.ok) {
    steps.push({ label: "Send a test trace", ok: null, detail: "Nothing was uploaded (the batch may still be queued)." });
  } else {
    steps.push({ label: "Send a test trace", ok: true, detail: `Uploaded, Langfuse answered OK (trace ${traceId})` });
  }

  // 4. Is it stored?
  const traceUrl = projectId ? `${d.baseUrl}/project/${projectId}/traces/${traceId}` : undefined;
  const waitMs = d.waitMs ?? 20_000;
  const pollMs = d.pollMs ?? 2_000;
  const until = Date.now() + waitMs;
  let lastStatus = 0;
  while (true) {
    try {
      const r = await d.fetchImpl(`${d.baseUrl}/api/public/traces/${traceId}`, { headers: authHeader, signal: AbortSignal.timeout(8000) });
      lastStatus = r.status;
      if (r.ok) {
        steps.push({ label: "Stored in Langfuse", ok: true, detail: `Found after the upload (environment "${d.environment}")` });
        return done(
          true,
          `Traces are reaching Langfuse${projectName ? ` project "${projectName}"` : ""}. If you don't see chats, open that project and set the environment filter to "${d.environment}" (or all).`,
          traceUrl,
        );
      }
    } catch {
      lastStatus = -1;
    }
    if (Date.now() >= until) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  steps.push({
    label: "Stored in Langfuse",
    ok: false,
    detail: `Not returned by the API after ${Math.round(waitMs / 1000)}s (last answer ${lastStatus === -1 ? "no response" : `HTTP ${lastStatus}`})`,
  });
  return done(
    false,
    `Langfuse accepted the upload but hasn't stored it. Open the link in a few minutes: if the trace is still missing, the Langfuse server isn't processing what it receives (on a self-hosted Langfuse, ask its admins to check the worker, ClickHouse and event storage, and that it is recent enough for SDK v${LANGFUSE_SDK_VERSION.split(".")[0]}).`,
    traceUrl,
  );
}

/** Starts Langfuse tracing when the keys are configured; otherwise returns `noTracing`. */
export async function initTracing(env: LangfuseEnv = config, fetchImpl: typeof fetch = fetch): Promise<Tracing> {
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) {
    console.log("[tracing] Langfuse off (set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY to turn it on)");
    return noTracing;
  }
  const { baseUrl, state, message } = await resolveLangfuse(env, fetchImpl);
  const environment = env.LANGFUSE_ENVIRONMENT ?? (process.env.NODE_ENV || "development").toLowerCase();
  const release = process.env.RENDER_GIT_COMMIT?.slice(0, 12);
  const version = await langfuseVersion(baseUrl, fetchImpl);
  const tooOld = versionWarning(version);
  const status: TracingStatus = { state, host: host(baseUrl), baseUrl, projectId: state === "ok" ? probedProjectId : undefined, message: tooOld ?? message, version, exports: 0, spansExported: 0, exportErrors: 0 };
  // Uploads are counted by RecordingExporter; anything else OpenTelemetry reports goes to the log.
  diag.setLogger(
    { error: (m, ...a) => console.error("[tracing]", [m, ...a].map(describeError).join(" ")), warn: (m, ...a) => console.warn("[tracing]", m, ...a), info() {}, debug() {}, verbose() {} },
    DiagLogLevel.WARN,
  );

  const processor = new LangfuseSpanProcessor({
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
    baseUrl,
    environment,
    release,
    exporter: new RecordingExporter(langfuseExporter(baseUrl, env.LANGFUSE_PUBLIC_KEY, env.LANGFUSE_SECRET_KEY), status),
    // Last line of defence: nothing leaves the server with a buyer's mobile number in it.
    mask: ({ data }) => maskPII(data),
  });
  const provider = new NodeTracerProvider({ spanProcessors: [new SessionStampProcessor(), processor] });
  provider.register();
  const client = new LangfuseClient({ publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY, baseUrl });

  const wrap = (o: { update(a: any): unknown; end(): void }): Observation => ({
    update: (a) => void o.update(a),
    end: () => o.end(),
  });

  const line = `[tracing] Langfuse ${version ? `${version} ` : ""}on (${baseUrl}, environment ${environment}${release ? `, release ${release}` : ""}): ${status.message}`;
  if (state === "auth_failed" || tooOld) console.error(line);
  else console.log(line);
  const trace: Tracing["trace"] = (name, ctx, fn) =>
    withTraceScope({ sessionId: ctx.sessionId, userId: ctx.userId }, () =>
      propagateAttributes({ traceName: name, sessionId: ctx.sessionId, userId: ctx.userId, tags: ctx.tags }, () =>
        startActiveObservation(name, async (root) => {
          root.update({ input: ctx.input, metadata: ctx.metadata });
          return fn({ ...wrap(root), traceId: root.traceId });
        }),
      ),
    );
  const auth = { publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY };

  return {
    enabled: true,
    status,
    start: (name, type, attrs = {}) => wrap(startObservation(name, attrs as any, { asType: type as any }) as any),
    trace,
    testConnection: async () => {
      const result = await runConnectionTest({
        baseUrl,
        environment,
        ...auth,
        fetchImpl,
        status,
        sendTrace: async () => {
          const traceId = await trace(
            "langfuse-connection-test",
            { sessionId: "langfuse-connection-test", tags: ["connection-test"], input: "Connection test from the admin page", metadata: { test: true } },
            async (root) => {
              root.update({ output: "OK" });
              return root.traceId;
            },
          );
          // A refused upload rejects the flush; RecordingExporter has already recorded why.
          await processor.forceFlush().catch(() => {});
          return traceId;
        },
      });
      status.lastTest = result;
      return result;
    },
    score: (s) => client.score.create({ ...s, environment }),
    flush: async () => {
      await Promise.allSettled([processor.forceFlush(), client.score.flush()]);
    },
  };
}
