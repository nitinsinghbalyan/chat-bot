import http from "node:http";
import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { ChatDb } from "../src/db.js";
import { updateCategory, type IsqSource } from "../src/isqTracker.js";
import { JevClient, JevService, maskDigits, pickProduct, productCandidates, productRequest, type SystemOneCaller, type SystemOneRequest, type SystemOneResponse } from "../src/jev.js";
import { SellerRegistry } from "../src/sellers.js";
import { SessionStore, type LeadState } from "../src/session.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const entry = (title: string, category: string) => ({ url: `https://x/${encodeURIComponent(title)}`, kind: "product" as const, slug: title, title, category, price_text: null, specs: {}, description: "", image: null, images: [], details: "", features: [], videos: [], documents: [], breadcrumbs: [], products: [] });
const brake = entry("CNC Press Brake 100 Ton", "Press Brakes");
const brake2 = entry("NC Press Brake 60 Ton", "Press Brakes");
const shear = entry("Hydraulic Shearing Machine", "Shearing Machines");

/** A seller with two categories; each category's questions are one spec with two options. */
const src: IsqSource = {
  plan: (category) => (category ? ({ category, label: category, mcatId: null, source: "derived", isqs: [{ question: `${category} size`, options: ["Small", "Large"] }], presentOn: 1 } as never) : null),
  locate: (e) => ({ category: e.category, mcatId: null, cardId: null }),
  locateText: () => null,
};
const lead = (over: Partial<LeadState> = {}): LeadState => ({ stage: "captured", otpAttempts: 0, otpSends: 1, ...over });

/** A fake Jev: answers from a function of the request, records what it was sent. */
function fakeJev(answer: (req: SystemOneRequest) => SystemOneResponse["answers"] | Error): SystemOneCaller & { sent: SystemOneRequest[] } {
  const sent: SystemOneRequest[] = [];
  return {
    model: "jev-1.14.0",
    sent,
    async systemOne(req) {
      sent.push(req);
      const a = answer(req);
      if (a instanceof Error) return { ok: false, error: a.message, ms: 5 };
      return { ok: true, res: { model: "jev-1.14.0", answers: a, usage: { input_tokens: 300, output_tokens: 10 } }, ms: 42 };
    },
  };
}
const choose = (key: (req: SystemOneRequest) => string, confidence: number, about: number, other?: number) => (req: SystemOneRequest) => ({
  product: { type: "choice" as const, choice: key(req), confidence, probabilities: {} },
  about_product: { type: "noul" as const, noul: about },
  ...(other !== undefined ? { other_product: { type: "noul" as const, noul: other } } : {}),
});
const keyFor = (label: string) => (req: SystemOneRequest) => Object.keys((req.questions.product as { criteria: Record<string, string> }).criteria).find((k) => k.startsWith(label.toLowerCase().replace(/[^a-z0-9]+/g, "_")))!;

describe("the product-pick question", () => {
  it("offers one option per product (two hits with the same questions are one), with readable names", () => {
    const c = productCandidates([brake, brake2, shear], src, "need a press brake");
    expect(c.map((x) => [x.key, x.label, x.titles])).toEqual([
      ["press_brakes", "Press Brakes", ["CNC Press Brake 100 Ton", "NC Press Brake 60 Ton"]],
      ["shearing_machines", "Shearing Machines", ["Hydraulic Shearing Machine"]],
    ]);
  });

  it("adds the seller's other products after the search hits, so a need in other words can still find one", () => {
    const withAll: IsqSource = { ...src, places: () => [{ place: { category: "Lathes", mcatId: null }, title: "All Geared Lathe" }, { place: { category: "Press Brakes", mcatId: null, cardId: null }, title: "CNC Press Brake 100 Ton" }] };
    expect(productCandidates([], withAll, "sheet bending machine chahiye").map((c) => c.label)).toEqual(["Lathes", "Press Brakes"]);
    expect(productCandidates([shear], withAll, "x", 2).map((c) => c.label)).toEqual(["Shearing Machines", "Lathes"]);
  });

  it("masks phone numbers, shuffles the options and asks about a switch only when the chat has a product", () => {
    const candidates = productCandidates([brake, shear], src, "x");
    let n = 0;
    const req = productRequest("jev-1.14.0", { buyerText: "call me on 98765 43210 about a shear", candidates }, () => (n++ === 0 ? 0 : 0.99));
    expect(req.model).toBe("jev-1.14.0");
    expect(req.state.buyer_message).toBe("call me on [number] about a shear");
    expect(Object.keys((req.questions.product as { criteria: object }).criteria)).toEqual(["shearing_machines", "press_brakes"]);
    expect(req.questions.about_product?.type).toBe("noul");
    expect(req.questions.other_product).toBeUndefined();
    const withCurrent = productRequest("m", { buyerText: "x", candidates, current: { label: "Press Brakes", place: candidates[0]!.place } });
    expect(withCurrent.state.current_product).toBe("Press Brakes");
    expect(withCurrent.questions.other_product?.type).toBe("noul");
    expect(maskDigits("pin 400001, mobile +91 98765-43210, 500 pieces")).toBe("pin [number], mobile [number], 500 pieces");
  });

  it("decides only when Jev is sure; a message about no product keeps the chat as it is", async () => {
    const candidates = productCandidates([brake, shear], src, "x");
    const ask = (answer: Parameters<typeof fakeJev>[0], current?: string) =>
      pickProduct(fakeJev(answer), { buyerText: "x", candidates, current: current ? { label: current, place: { category: current, mcatId: null, cardId: null } } : null }, { minConfidence: 0.7 });
    expect((await ask(choose(keyFor("Shearing"), 0.9, 0.95))).decision).toMatchObject({ category: "Shearing Machines" });
    expect((await ask(choose(keyFor("Shearing"), 0.9, 0.1))).decision).toBe("keep");
    expect(await ask(choose(keyFor("Shearing"), 0.5, 0.95))).toMatchObject({ decision: null, reason: "unsure" });
    expect(await ask(choose(keyFor("Shearing"), 0.9, 0.5))).toMatchObject({ decision: null, reason: "unsure" });
    // With a product already: the same one, or "still the current product", keeps it; a clear switch moves.
    expect((await ask(choose(keyFor("Press"), 0.9, 0.95, 0.9), "Press Brakes")).decision).toBe("keep");
    expect((await ask(choose(keyFor("Shearing"), 0.9, 0.95, 0.1), "Press Brakes")).decision).toBe("keep");
    expect((await ask(choose(keyFor("Shearing"), 0.9, 0.95, 0.5), "Press Brakes")).decision).toBeNull();
    expect((await ask(choose(keyFor("Shearing"), 0.9, 0.95, 0.9), "Press Brakes")).decision).toMatchObject({ category: "Shearing Machines" });
    expect(await ask(() => new Error("timed out after 1500 ms"))).toMatchObject({ decision: null, reason: "error", error: "timed out after 1500 ms" });
  });
});

describe("updateCategory with Jev's decision", () => {
  it("uses a decided product, keeps on 'keep', and the buyer's page still wins", () => {
    const l = lead();
    // Word rules alone would pick press brakes for "brake"; Jev's decision wins.
    expect(updateCategory(l, src, { buyerText: "need a brake", hits: [brake], ownHits: true, decided: { category: "Shearing Machines", mcatId: null } })).toBe(true);
    expect(l.category).toBe("Shearing Machines");
    expect(updateCategory(l, src, { buyerText: "press brake bhi", hits: [brake], ownHits: true, decided: "keep" })).toBe(false);
    expect(l.category).toBe("Shearing Machines");
    expect(updateCategory(l, src, { buyerText: "this one", page: brake, hits: [brake], ownHits: true, decided: "keep" })).toBe(true);
    expect(l.category).toBe("Press Brakes");
  });

  it("never lets Jev switch the product during the closing steps", () => {
    const l = lead({ category: "Press Brakes", askedIsqs: ["Press Brakes size"], details: { quantity: "2", buyerType: "business" } });
    expect(updateCategory(l, src, { buyerText: "Shree Shear Works", hits: [shear], ownHits: true, decided: { category: "Shearing Machines", mcatId: null } })).toBe(false);
    expect(l.category).toBe("Press Brakes");
  });
});

describe("the Jev service", () => {
  const make = (mode: "off" | "shadow" | "on", answer: Parameters<typeof fakeJev>[0]) => {
    const jev = fakeJev(answer);
    return { jev, svc: new JevService({ caller: jev, mode: () => mode, minConfidence: 0.7 }) };
  };
  const turn = (l: LeadState, buyerText: string, hits = [brake, shear]) => ({ lead: l, src, buyerText, hits, ownHits: hits.length > 0 });

  it("is off without a key, and never asked while off", async () => {
    const none = new JevService({ caller: null, mode: () => "on", minConfidence: 0.7 });
    expect(none.mode()).toBe("off");
    expect(await none.decide(turn(lead(), "shear"))).toBeUndefined();
    const { jev, svc } = make("off", choose(keyFor("Shearing"), 0.9, 0.9));
    expect(await svc.decide(turn(lead(), "shear"))).toBeUndefined();
    expect(jev.sent).toHaveLength(0);
  });

  it("on: returns the decision; shadow: asks and compares but decides nothing", async () => {
    const on = make("on", choose(keyFor("Shearing"), 0.9, 0.95));
    expect(await on.svc.decide(turn(lead(), "metal cutting machine"))).toMatchObject({ category: "Shearing Machines" });
    const shadow = make("shadow", choose(keyFor("Shearing"), 0.9, 0.95));
    expect(await shadow.svc.decide(turn(lead(), "metal cutting machine"))).toBeUndefined();
    expect(shadow.jev.sent).toHaveLength(1);
    expect(shadow.svc.stats).toMatchObject({ calls: 1, errors: 0, compared: 1 });
  });

  it("is never asked during login, for a tapped button, or with nothing to choose from", async () => {
    const { jev, svc } = make("on", choose(keyFor("Shearing"), 0.9, 0.95));
    await svc.decide(turn(lead({ stage: "otp_sent" }), "12345"));
    await svc.decide(turn(lead({ stage: "verified" }), "Ramesh"));
    await svc.decide(turn(lead({ category: "Press Brakes", lastOptions: ["Small", "Large"] }), "Large"));
    await svc.decide(turn(lead(), "hello", []));
    await svc.decide(turn(lead({ stage: "none" }), "98765 43210"));
    expect(jev.sent).toHaveLength(0);
  });

  it("falls back to the word rules when Jev fails, and counts the error", async () => {
    const { svc } = make("on", () => new Error("HTTP 529: overloaded"));
    expect(await svc.decide(turn(lead(), "shear"))).toBeUndefined();
    expect(svc.stats).toMatchObject({ calls: 1, errors: 1, lastError: "HTTP 529: overloaded" });
  });
});

describe("the HTTP client", () => {
  let server: http.Server;
  let base = "";
  const seen: Array<{ url?: string; auth?: string; body: unknown }> = [];
  let reply: (res: http.ServerResponse) => void = () => {};
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || "{}") });
        reply(res);
      });
    });
    server.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("posts to /v1/systemone with the key and reads the answers", async () => {
    reply = (res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ model: "jev-1.14.0", answers: { a: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 1 } }));
    const c = new JevClient({ apiKey: "ts-test", model: "jev-1.14.0", baseUrl: `${base}/`, timeoutMs: 1000 });
    const r = await c.systemOne({ model: c.model, state: { buyer_message: "hi" }, questions: { a: { type: "noul", instructions: "?" } } });
    expect(r).toMatchObject({ ok: true, res: { answers: { a: { noul: 0.9 } } } });
    expect(seen.at(-1)).toMatchObject({ url: "/v1/systemone", auth: "Bearer ts-test", body: { model: "jev-1.14.0" } });
  });

  it("reports errors and timeouts instead of throwing", async () => {
    reply = (res) => res.writeHead(422, { "Content-Type": "application/json" }).end('{"detail":[{"msg":"Field required"}]}');
    const c = new JevClient({ apiKey: "k", model: "m", baseUrl: base, timeoutMs: 300 });
    expect(await c.systemOne({ model: "m", state: "x", questions: {} })).toMatchObject({ ok: false, error: expect.stringContaining("HTTP 422") });
    reply = (res) => setTimeout(() => res.writeHead(200).end("{}"), 1000);
    expect(await c.systemOne({ model: "m", state: "x", questions: {} })).toMatchObject({ ok: false, error: "timed out after 300 ms" });
  });
});

describe("the admin switch", () => {
  const PASSWORD = "correct-horse-battery";
  const auth = { Authorization: `Basic ${Buffer.from(`a:${PASSWORD}`).toString("base64")}` };
  let base = "";
  let close: () => void;
  const db = new ChatDb(":memory:");
  beforeAll(async () => {
    const sellers = SellerRegistry.load(path.join(__dirname, "fixtures", "sellers"), fs.mkdtempSync(path.join(os.tmpdir(), "jev-")));
    const jev = new JevService({ caller: fakeJev(choose(() => "x", 0.9, 0.9)), mode: () => (db.getSetting("jev_product_pick") as never) ?? "off", minConfidence: 0.7 });
    const app = createApp({ client: {} as Anthropic, sellers, sessions: new SessionStore(db), db, allowedOrigins: [], adminPassword: PASSWORD, jev });
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close?.());

  it("shows the card, saves the mode from this site only, and reports it on /health", async () => {
    const page = await (await fetch(`${base}/admin`, { headers: auth })).text();
    expect(page).toContain("Jev product pick");
    expect(page).toMatch(/value="off" checked/);
    const post = (mode: string, origin = base) => fetch(`${base}/admin/jev`, { method: "POST", redirect: "manual", headers: { ...auth, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: `mode=${mode}` });
    expect((await post("on", "https://evil.example")).status).toBe(403);
    expect((await post("sometimes")).status).toBe(400);
    const saved = await post("shadow");
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe("/admin?jev=saved#jev");
    expect(db.getSetting("jev_product_pick")).toBe("shadow");
    expect((await (await fetch(`${base}/health`)).json()).jev).toEqual({ mode: "shadow", key: true, model: "jev-1.14.0" });
  });
});
