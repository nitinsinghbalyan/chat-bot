import { describe, expect, it } from "vitest";
import { costDetails, initTracing, LANGFUSE_EU, LANGFUSE_US, maskMobile, maskPII, noTracing, resolveLangfuse, usageDetails } from "../src/tracing.js";

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
