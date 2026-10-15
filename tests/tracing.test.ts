import { describe, expect, it } from "vitest";
import { ExportResultCode } from "@opentelemetry/core";
import {
  costDetails,
  describeError,
  initTracing,
  LANGFUSE_EU,
  LANGFUSE_US,
  langfuseVersion,
  maskMobile,
  maskPII,
  noTracing,
  RecordingExporter,
  resolveLangfuse,
  runConnectionTest,
  usageDetails,
  versionWarning,
  type TracingStatus,
} from "../src/tracing.js";

describe("maskPII", () => {
  it.each([
    ["call me on 9876543210", "call me on xxxxxx3210"],
    ["+91 98765 43210 please", "xxxxxx3210 please"],
    ["my no. is 098765-43210.", "my no. is xxxxxx3210."],
    ['{"mobile":"9876543210"}', '{"mobile":"xxxxxx3210"}'],
    ['"<buyer_message>\\n98765 43210\\n</buyer_message>"', '"<buyer_message>\\nxxxxxx3210\\n</buyer_message>"'],
  ])("masks %s", (input, out) => {
    expect(maskPII(input)).toBe(out);
  });

  it("leaves specs, ids and other numbers alone", () => {
    const keep = "100 ton, 3 m, 6 mm, model KPBF-10080, landline 0281-2345678, trace 4bf92f3577b34da6a3ce929d0e0e4736, 2026-10-14T10:00:00Z";
    expect(maskPII(keep)).toBe(keep);
  });

  it("walks arrays and objects", () => {
    expect(maskPII({ a: ["9876543210", 5], b: { c: "x 7012345678" } })).toEqual({ a: ["xxxxxx3210", 5], b: { c: "x xxxxxx5678" } });
    expect(maskMobile("98765 43210")).toBe("xxxxxx3210");
  });
});

describe("cost", () => {
  it("prices a Sonnet 5.5 call with cache reads and writes", () => {
    const u = { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 40_000 };
    const c = costDetails("claude-sonnet-5-5", u)!;
    expect(c.input).toBeCloseTo(2);
    expect(c.output).toBeCloseTo(1);
    expect(c.cache_read_input_tokens).toBeCloseTo(0.4);
    expect(c.cache_creation_input_tokens).toBeCloseTo(0.1);
    expect(c.total).toBeCloseTo(3.5);
    expect(usageDetails(u).total).toBe(3_140_000);
    expect(costDetails("some-unknown-model", u)).toBeUndefined();
  });
});

describe("noTracing", () => {
  it("runs the callback and records nothing", async () => {
    expect(noTracing.enabled).toBe(false);
    expect(await noTracing.trace("t", { sessionId: "s" }, async (root) => root.traceId)).toBe("");
  });
});

describe("resolveLangfuse (startup key check)", () => {
  const keys = { LANGFUSE_PUBLIC_KEY: "pk-lf-1", LANGFUSE_SECRET_KEY: "sk-lf-1", LANGFUSE_BASE_URL: undefined, LANGFUSE_ENVIRONMENT: undefined };
  /** Answers each host with the given status (or throws for "down"). */
  const fakeFetch = (byHost: Record<string, number | "down">) => {
    const calls: string[] = [];
    const auth: string[] = [];
    const f = (async (url: string, init: any) => {
      calls.push(url);
      auth.push(init.headers.Authorization);
      const s = byHost[new URL(url).host];
      if (s === "down" || s === undefined) throw new Error("ECONNREFUSED");
      return new Response("{}", { status: s });
    }) as unknown as typeof fetch;
    return { f, calls, auth };
  };

  it("uses the EU cloud when it accepts the keys", async () => {
    const { f, calls, auth } = fakeFetch({ "cloud.langfuse.com": 200 });
    expect(await resolveLangfuse(keys, f)).toMatchObject({ baseUrl: LANGFUSE_EU, state: "ok" });
    expect(calls).toEqual([`${LANGFUSE_EU}/api/public/projects`]);
    expect(auth).toEqual([`Basic ${Buffer.from("pk-lf-1:sk-lf-1").toString("base64")}`]);
  });

  it("switches to the US cloud when the keys belong there", async () => {
    const { f } = fakeFetch({ "cloud.langfuse.com": 401, "us.cloud.langfuse.com": 200 });
    const r = await resolveLangfuse(keys, f);
    expect(r).toMatchObject({ baseUrl: LANGFUSE_US, state: "ok" });
    expect(r.message).toContain("LANGFUSE_BASE_URL=https://us.cloud.langfuse.com");
  });

  it("reports rejected keys, with hints for swapped keys", async () => {
    const { f } = fakeFetch({ "cloud.langfuse.com": 401, "us.cloud.langfuse.com": 401 });
    const swapped = { ...keys, LANGFUSE_PUBLIC_KEY: "sk-lf-1", LANGFUSE_SECRET_KEY: "pk-lf-1" };
    const r = await resolveLangfuse(swapped, f);
    expect(r.state).toBe("auth_failed");
    expect(r.message).toMatch(/rejected the keys at cloud\.langfuse\.com and us\.cloud\.langfuse\.com/);
    expect(r.message).toMatch(/look swapped/);
  });

  it("only checks the configured host, and keeps tracing on when it can't be reached", async () => {
    const { f, calls } = fakeFetch({ "langfuse.example.com": "down" });
    const r = await resolveLangfuse({ ...keys, LANGFUSE_BASE_URL: "https://langfuse.example.com/" }, f);
    expect(r).toMatchObject({ baseUrl: "https://langfuse.example.com", state: "unreachable" });
    expect(calls).toHaveLength(1);
  });

  it("stays off without keys", async () => {
    const t = await initTracing({ ...keys, LANGFUSE_SECRET_KEY: undefined });
    expect(t).toBe(noTracing);
    expect(t.status.state).toBe("off");
  });
});

const freshStatus = (): TracingStatus => ({ state: "ok", host: "langfuse.example.com", message: "", exports: 0, spansExported: 0, exportErrors: 0 });

describe("Langfuse server version", () => {
  it("reads it from /api/public/health and warns when it predates OpenTelemetry", async () => {
    const f = (async () => new Response(JSON.stringify({ status: "OK", version: "2.95.1" }))) as unknown as typeof fetch;
    expect(await langfuseVersion("https://lf.example.com", f)).toBe("2.95.1");
    expect(versionWarning("2.95.1")).toMatch(/no OpenTelemetry endpoint/);
    expect(versionWarning("v3.120.0")).toBeNull();
    expect(versionWarning(undefined)).toBeNull();
    const down = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect(await langfuseVersion("https://lf.example.com", down)).toBeUndefined();
  });
});

describe("RecordingExporter", () => {
  it("counts successful and failed uploads", async () => {
    const status = freshStatus();
    let next: any = { code: ExportResultCode.SUCCESS };
    const delegate = { export: (_s: any, cb: any) => cb(next), shutdown: async () => {} };
    const ex = new RecordingExporter(delegate as any, status);
    const run = () => new Promise((r) => ex.export([{}, {}, {}] as any, r));
    await run();
    expect(status).toMatchObject({ exports: 1, spansExported: 3, exportErrors: 0, lastExportOk: true });
    next = { code: ExportResultCode.FAILED, error: { name: "OTLPExporterError", message: "Not Found", code: 404, data: "Cannot POST /api/public/otel/v1/traces" } };
    await run();
    expect(status).toMatchObject({ exports: 1, exportErrors: 1, lastExportOk: false });
    expect(status.lastExportError).toBe("OTLPExporterError: Not Found (HTTP 404) Cannot POST /api/public/otel/v1/traces");
    expect(describeError('{"stack":"OTLPExporterError: Unauthorized\\n    at x"}')).toBe("OTLPExporterError: Unauthorized");
  });
});

describe("runConnectionTest", () => {
  const base = "https://lf.example.com";
  /** A fake Langfuse: health, projects, and a trace lookup that answers `traceStatus`. */
  const fakeLangfuse = (o: { version?: string; projects?: number; traceStatus?: number }) =>
    (async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/api/public/health") return new Response(JSON.stringify({ status: "OK", version: o.version ?? "3.120.0" }));
      if (path === "/api/public/projects") return new Response(JSON.stringify({ data: [{ id: "proj1", name: "Seller bots" }] }), { status: o.projects ?? 200 });
      if (path.startsWith("/api/public/traces/")) return new Response("{}", { status: o.traceStatus ?? 200 });
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
  const deps = (fetchImpl: typeof fetch, upload: "ok" | "fail" = "ok") => {
    const status = freshStatus();
    return {
      status,
      d: {
        baseUrl: base,
        publicKey: "pk-lf-1",
        secretKey: "sk-lf-1",
        environment: "production",
        status,
        fetchImpl,
        waitMs: 30,
        pollMs: 10,
        sendTrace: async () => {
          if (upload === "ok") status.exports++;
          else {
            status.exportErrors++;
            status.lastExportError = "OTLPExporterError: Not Found (HTTP 404)";
          }
          return "a".repeat(32);
        },
      },
    };
  };

  it("passes when the trace comes back, with a link to it", async () => {
    const r = await runConnectionTest(deps(fakeLangfuse({})).d);
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.ok)).toEqual([true, true, true, true]);
    expect(r.traceUrl).toBe(`${base}/project/proj1/traces/${"a".repeat(32)}`);
    expect(r.verdict).toMatch(/environment filter to "production"/);
  });

  it("names a refused upload", async () => {
    const r = await runConnectionTest(deps(fakeLangfuse({}), "fail").d);
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)).toMatchObject({ label: "Send a test trace", ok: false });
    expect(r.verdict).toMatch(/refused the trace upload/);
  });

  it("names an upload that is accepted but never stored", async () => {
    const r = await runConnectionTest(deps(fakeLangfuse({ traceStatus: 404 })).d);
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)).toMatchObject({ label: "Stored in Langfuse", ok: false });
    expect(r.steps.at(-1)!.detail).toMatch(/HTTP 404/);
    expect(r.verdict).toMatch(/accepted the upload but hasn't stored it/);
    expect(r.traceUrl).toBeDefined();
  });

  it("stops early for an old server or rejected keys", async () => {
    expect((await runConnectionTest(deps(fakeLangfuse({ version: "2.60.0" })).d)).verdict).toMatch(/no OpenTelemetry endpoint/);
    const r = await runConnectionTest(deps(fakeLangfuse({ projects: 401 })).d);
    expect(r.steps.at(-1)).toMatchObject({ label: "Keys", ok: false, detail: "Langfuse answered HTTP 401" });
  });

  it("is a clear no-op when tracing is off", async () => {
    expect((await noTracing.testConnection()).verdict).toMatch(/Tracing is off/);
  });
});
