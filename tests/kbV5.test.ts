import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { ChatDb } from "../src/db.js";
import { FaqStore, parseFaq } from "../src/faq.js";
import { KbView, validateSellerKb } from "../src/sellerKb.js";
import { SellerRegistry } from "../src/sellers.js";
import { SessionStore } from "../src/session.js";

const fixtures = path.join(__dirname, "fixtures");
const ALPHA = "alpha-presses";
const PASSWORD = "correct-horse-battery";
const raw = () => JSON.parse(fs.readFileSync(path.join(fixtures, "kb", "alpha-kb-v5.json"), "utf8"));

describe("master JSON version 5.0", () => {
  const r = validateSellerKb(raw());
  if (!r.ok) throw new Error(r.errors.join("\n"));
  const view = new KbView(r.kb);
  const text = view.systemText();

  it("loads without a version warning and keeps the seller id and taxonomy", () => {
    expect(r.warnings.join(" ")).not.toMatch(/_version/);
    expect(r.kb.seller.seller_id).toBe("5525698");
    expect(r.kb.products[0].taxonomy).toMatchObject({ group_name: "Sheet Metal Machinery", glmcat_ids: ",25058," });
    expect(view.mcatOf(r.kb.products[0])).toBe("25058");
  });

  it("never gives the bot the export's prices, terms, tenure, staff, ratings or trust data", () => {
    expect(text).not.toMatch(/SENTINEL_|4,50,000|450000|18%/);
    expect(text).toContain("Product id: cnc-press-brake-a1b2c3d");
  });

  it("turns the products' FAQs into rows for the per-message search, leaving out answers with a price", () => {
    const { rows, priced } = view.faqs();
    expect(priced).toBe(1);
    expect(rows).toEqual([
      { question: "Does the CNC press brake come with tooling?", answer: "Yes, a standard punch and die set is included with every CNC press brake.", categories: ["Press Brakes", "CNC Press Brake 100 Ton"], product: "CNC Press Brake 100 Ton" },
      { question: "Can the NC press brake bend stainless steel?", answer: "Yes, up to 4 mm stainless steel on the 100 ton model.", categories: ["Press Brakes", "NC Press Brake"], product: "NC Press Brake" },
    ]);
    expect(text).not.toContain("punch and die");
  });
});

describe("FAQ sheet with a Seller column, merged with the seller's product FAQs", () => {
  const csv = [
    "Seller Name,gl_faq_question,gl_faq_answer",
    "Alphapresses,Do you provide installation?,Yes we install at site.",
    "5525698,Do you train operators?,Yes training is included.",
    "Topallimpex,Do you make brass taps?,Yes.",
    "alpha-presses,Which cities do you serve?,All of India.",
    ",Do you export?,Yes we export.",
  ].join("\n");

  it("reads the seller column and scopes rows by name, slug or seller id", async () => {
    const r = await parseFaq(Buffer.from(csv));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary).toBe("5 questions, 4 for specific sellers");
    expect(r.value[0]).toEqual({ question: "Do you provide installation?", answer: "Yes we install at site.", categories: [], sellers: ["Alphapresses"] });
    expect(r.warnings.join(" ")).toContain("Rows name 4 sellers");
    const store = new FaqStore(fs.mkdtempSync(path.join(os.tmpdir(), "faq-v5-")));
    store.set({ rows: r.value, uploadedAt: "2026-10-18T00:00:00Z", format: "csv", summary: r.summary, warnings: [] });
    const terms = { names: ["Press Brakes"], mcatIds: new Set<string>() };
    const own = [{ question: "Does it come with tooling?", answer: "Yes.", categories: [], product: "CNC Press Brake" }];
    const index = store.forSeller({}, terms, "Alpha Presses Pvt Ltd", { rows: own, slug: "alpha-presses", sellerId: "5525698" })!;
    expect(index.rows.map((x) => x.question)).toEqual(["Does it come with tooling?", "Do you provide installation?", "Do you train operators?", "Which cities do you serve?", "Do you export?"]);
    expect(index.search("do you give tooling with it?")[0]).toMatchObject({ product: "CNC Press Brake" });
    // No sheet at all: a seller's own FAQs still get an index.
    store.set(null);
    expect(store.forSeller({}, terms, "Alpha", { rows: own })?.size).toBe(1);
    expect(store.forSeller({}, terms, "Alpha")).toBeNull();
  });
});

/** Answers "OK." and records each request. */
function fakeClient(requests: any[]) {
  return {
    beta: {
      messages: {
        stream(params: any) {
          requests.push(structuredClone(params));
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
              yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK." } };
              yield { type: "content_block_stop", index: 0 };
            },
            finalMessage: async () => ({ content: [{ type: "text", text: "OK." }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }),
          };
        },
      },
    },
  } as unknown as Anthropic;
}

describe("a v5 seller end to end: product FAQs in the turn, knowledge mapping in admin", () => {
  const requests: any[] = [];
  let base = "";
  let close: () => void;
  const auth = { Authorization: `Basic ${Buffer.from(`a:${PASSWORD}`).toString("base64")}` };

  beforeAll(async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "v5-app-"));
    const sellers = SellerRegistry.load(path.join(fixtures, "sellers"), path.join(dataDir, "sellers"));
    const r = validateSellerKb(raw());
    if (!r.ok) throw new Error("kb");
    sellers.setUploadedKb(ALPHA, r.kb);
    const app = createApp({ client: fakeClient(requests), sellers, sessions: new SessionStore(), db: new ChatDb(":memory:"), allowedOrigins: [], adminPassword: PASSWORD, faq: new FaqStore(dataDir) });
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close?.());

  it("answers from the seller's own product FAQs even without a common sheet", async () => {
    await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ seller: ALPHA, sessionId: "v5-chat-0001", message: "does the cnc press brake come with tooling?", pageUrl: `${base}/s/${ALPHA}/` }) }).then((x) => x.text());
    const turn = requests.at(-1).messages.at(-1).content.at(-1).text as string;
    expect(turn).toContain("<faq>\nQ (about CNC Press Brake 100 Ton): Does the CNC press brake come with tooling?");
    expect(turn).toContain("<spec_questions>\nProduct: Press Brakes.");
  });

  it("shows the knowledge mapping and serves it as JSON", async () => {
    const page = await (await fetch(`${base}/admin`, { headers: auth })).text();
    expect(page).toContain("Knowledge mapping");
    expect(page).toContain("2 product FAQs in the KB JSON (1 left out for stating a price)");
    const res = await fetch(`${base}/admin/sellers/${ALPHA}/mapping.json`, { headers: auth });
    expect(res.status).toBe(200);
    const m = await res.json();
    expect(m).toMatchObject({ version: "5.0", looseProducts: 0, faqs: { product: 2, productPriced: 1 }, mcatFile: { uploaded: false, entries: 0 } });
    expect(m.categories[0]).toMatchObject({ name: "Press Brakes", products: 2, mainMcat: { id: "25058", inFile: false }, questions: { source: "derived" } });
    expect(m.flags[0]).toMatch(/^No MCAT specifications file/);
    expect((await fetch(`${base}/admin/sellers/${ALPHA}/mapping.json`)).status).toBe(401);
  });
});
