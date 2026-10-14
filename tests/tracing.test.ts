import { describe, expect, it } from "vitest";
import { costDetails, maskMobile, maskPII, noTracing, usageDetails } from "../src/tracing.js";

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
