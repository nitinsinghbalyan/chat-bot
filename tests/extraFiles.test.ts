import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { ChatDb } from "../src/db.js";
import { FaqStore } from "../src/faq.js";
import { KbView, type SellerKb } from "../src/sellerKb.js";
import { SellerRegistry } from "../src/sellers.js";
import { SessionStore } from "../src/session.js";

const fixtures = path.join(__dirname, "fixtures");
const ALPHA = "alpha-presses";
const PASSWORD = "correct-horse-battery";
const kbJson = (): SellerKb => JSON.parse(fs.readFileSync(path.join(fixtures, "kb", "alpha-kb.json"), "utf8"));

const mcatFile = JSON.stringify([
  { mcat_id: 777, mcat_name: "Hydraulic Shearing Machine", specifications: [{ name: "Cutting Length", options: ["8 ft", "10 ft"] }, { name: "Cutting Thickness", options: ["6 mm", "10 mm"] }] },
  { mcat_id: 888, mcat_name: "Press Brake", specifications: [{ name: "Bending Length", options: ["2500 mm", "3200 mm"] }, { name: "Capacity", options: ["60 Ton", "100 Ton", "200 Ton"] }] },
  { mcat_id: 1067, mcat_name: "Concrete Vibrator", specifications: [{ name: "Power Source", options: ["Electric", "Petrol"] }] },
]);
const cardsFile = JSON.stringify([{ product_id: "shear", canonical_name: "Shearing Machine", aliases: ["Hydraulic Shearing Machine"], flow: { markdown: "## **Shearing Machine**" } }]);
const cardMd = "## Business\n- **Name**: Alpha Presses Pvt Ltd\n- **GST**: 24ABCDE\n- **Listed contact**: 98989 89898\nWe make press brakes and shears.";

describe("extra files in the registry", () => {
  const load = () => SellerRegistry.load(path.join(fixtures, "sellers"), fs.mkdtempSync(path.join(os.tmpdir(), "xf-")));
  const file = (value: unknown) => ({ value, uploadedAt: "2026-10-15T00:00:00Z", summary: "", warnings: [] });

  it("merges the business card, replaces a KB folder's cards, and fills ISQ gaps from MCATs", async () => {
    const { parseSellerFile } = await import("../src/sellers.js");
    const reg = load();
    const s = reg.get(ALPHA)!;
    const before = s.systemPrompt;
    const md = parseSellerFile("business-card", cardMd);
    const mcat = parseSellerFile("mcat", mcatFile);
    const cards = parseSellerFile("product-cards", cardsFile);
    if (!md.ok || !mcat.ok || !cards.ok) throw new Error("parse");
    reg.setSellerFile(ALPHA, "business-card", file(md.value));
    reg.setSellerFile(ALPHA, "mcat", file(mcat.value));
    reg.setSellerFile(ALPHA, "product-cards", file(cards.value));
    expect(s.systemPrompt).toContain("## Seller policy card (how to handle these topics)");
    expect(s.systemPrompt).toContain("We make press brakes and shears.");
    expect(s.systemPrompt).not.toContain("24ABCDE");
    expect(s.kb.allowedPhones).toContain("9898989898");
    // The uploaded cards replace the folder's (same kind of file); the new card had no ISQs, so the MCAT gives them.
    expect(s.kb.productCards.map((c) => c.product_id)).toEqual(["shear"]);
    expect(s.systemPrompt).toContain("Qualification questions (from MCAT Hydraulic Shearing Machine;");
    expect(s.systemPrompt).toContain("1. Cutting Length? Options: 8 ft / 10 ft");
    expect(s.systemPrompt).not.toContain("Concrete Vibrator");
    expect(s.mcatUse).toEqual({ matched: ["Hydraulic Shearing Machine", "Press Brake"], filled: ["Shearing Machine (product card)"] });
    for (const kind of ["business-card", "mcat", "product-cards"] as const) reg.setSellerFile(ALPHA, kind, null);
    expect(s.systemPrompt).toBe(before);
  });

  it("with a KB JSON: adds the cards, and takes ISQs from the category's MCAT (by id, else equal name)", async () => {
    const { parseSellerFile } = await import("../src/sellers.js");
    const reg = load();
    const kb = kbJson();
    kb.categories.push({ category_id: "c9", name: "Hydraulic Shearing Machines", url: "", description: "", image_url: "", product_ids: ["601"] } as any);
    kb.products.push({ ...kb.products[1], product_id: "601", name: "Hydraulic Shear", display_name: "", product_url: "", specifications: [{ name: "Cutting Length", value: "10 ft" }, { name: "Blade Material", value: "HSS" }], taxonomy: { category_name: "Shears", glmcat_ids: ",777,", glcat_ids: "" } } as any);
    reg.setUploadedKb(ALPHA, kb);
    const mcat = parseSellerFile("mcat", mcatFile);
    const cards = parseSellerFile("product-cards", cardsFile);
    if (!mcat.ok || !cards.ok) throw new Error("parse");
    reg.setSellerFile(ALPHA, "mcat", file(mcat.value));
    reg.setSellerFile(ALPHA, "product-cards", file(cards.value));
    const s = reg.get(ALPHA)!;
    // "Press Brakes" equals the "Press Brake" MCAT's name (the products have no MCAT ids): of its specs, only Capacity is on
    // the products, so that is the one question, with the seller's values first. Bending Length is never asked.
    expect(s.systemPrompt).toMatch(/### Press Brakes[\s\S]*?ISQs \(from MCAT Press Brake\)[\s\S]*?1\. Capacity\? Options: 60 Ton \/ 100 Ton \/ 200 Ton/);
    expect(s.systemPrompt).not.toContain("Bending Length");
    // By MCAT id 777: Cutting Length is on the product (Cutting Thickness is not), with the seller's 10 ft first.
    expect(s.systemPrompt).toMatch(/### Hydraulic Shearing Machines[\s\S]*?ISQs \(from MCAT Hydraulic Shearing Machine\)[\s\S]*?1\. Cutting Length\? Options: 10 ft \/ 8 ft/);
    expect(s.systemPrompt.split("### Hydraulic Shearing Machines")[1].split(/\n#+ /)[0]).not.toContain("Cutting Thickness");
    expect(s.mapping?.categories.find((c) => c.name === "Hydraulic Shearing Machines")).toMatchObject({ mainMcat: { id: "777", name: "Hydraulic Shearing Machine", inFile: true }, questions: { source: "mcat" } });
    expect(s.systemPrompt).toContain("# Product cards (uploaded)");
    expect(s.kb.productCards.map((c) => c.product_id)).toContain("shear");
    expect(s.mcatUse.filled).toContain("Hydraulic Shearing Machines (from MCAT Hydraulic Shearing Machine)");
  });

  it("counts the extra text against the prompt budget", () => {
    const view = new KbView(kbJson());
    expect(view.promptPlan().mode).toBe("full");
    const squeezed = new KbView(kbJson(), { reservedChars: 299_000 });
    expect(squeezed.promptPlan().mode).not.toBe("full");
  });
});

/** Answers "OK." and records each request. */
function fakeClient(requests: any[]) {
  return {
    beta: {
      messages: {
        stream(params: any) {
          requests.push(structuredClone(params));
          const content = [{ type: "text", text: "OK." }];
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
              yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK." } };
              yield { type: "content_block_stop", index: 0 };
            },
            finalMessage: async () => ({ content, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }),
          };
        },
      },
    },
  } as unknown as Anthropic;
}

describe("admin: extra files and the common FAQ", () => {
  const requests: any[] = [];
  let base = "";
  let close: () => void;
  let dataDir = "";
  const auth = { Authorization: `Basic ${Buffer.from(`a:${PASSWORD}`).toString("base64")}` };
  const post = (p: string, body: string | Buffer, type = "application/json", origin?: string) =>
    fetch(`${base}${p}`, { method: "POST", headers: { ...auth, Origin: origin ?? base, "Content-Type": type }, body, redirect: "manual" });

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "xf-app-"));
    const sellers = SellerRegistry.load(path.join(fixtures, "sellers"), path.join(dataDir, "sellers"));
    const app = createApp({ client: fakeClient(requests), sellers, sessions: new SessionStore(), db: new ChatDb(":memory:"), allowedOrigins: [], adminPassword: PASSWORD, faq: new FaqStore(dataDir) });
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close?.());

  it("uploads, shows, downloads and removes each extra file", async () => {
    expect((await fetch(`${base}/admin/sellers/${ALPHA}/files/mcat`, { method: "POST", body: mcatFile })).status).toBe(401);
    expect((await post(`/admin/sellers/${ALPHA}/files/mcat`, mcatFile, "application/json", "https://evil.example")).status).toBe(403);
    expect((await post(`/admin/sellers/${ALPHA}/files/other`, "x")).status).toBe(404);
    const bad = await post(`/admin/sellers/${ALPHA}/files/product-cards`, "{oops");
    expect(bad.status).toBe(400);
    expect((await bad.json()).errors[0]).toMatch(/^Not valid JSON/);

    const up = await post(`/admin/sellers/${ALPHA}/files/mcat`, mcatFile);
    // "Shearing Machines" (the business card) is not a "Hydraulic Shearing Machine", so only the press brake MCAT matches;
    // the folder's press brake card has its own questions, so nothing is filled.
    expect(await up.json()).toMatchObject({ ok: true, summary: "3 MCATs, 1 matches this seller, ISQs added to 0 categories or cards" });
    expect((await post(`/admin/sellers/${ALPHA}/files/business-card`, cardMd, "text/plain")).status).toBe(200);
    expect(fs.existsSync(path.join(dataDir, "sellers", ALPHA, "files", "mcat_specifications.json"))).toBe(true);

    const page = await (await fetch(`${base}/admin`, { headers: auth })).text();
    expect(page).toContain("Extra files");
    expect(page).toContain("+2 files");
    expect(page).toContain("Matches this seller: Press Brake. Every matching category already has its own ISQs.");
    const dl = await fetch(`${base}/admin/sellers/${ALPHA}/files/business-card`, { headers: auth });
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe(cardMd);

    expect((await post(`/admin/sellers/${ALPHA}/files/business-card/delete`, "")).status).toBe(303);
    expect((await fetch(`${base}/admin/sellers/${ALPHA}/files/business-card`, { headers: auth })).status).toBe(404);
  });

  it("uploads the common FAQ and adds matching rows to the buyer's turn", async () => {
    const xlsx = fs.readFileSync(path.join(fixtures, "faq.xlsx"));
    expect((await post("/admin/faq", xlsx, "application/octet-stream", "https://evil.example")).status).toBe(403);
    const r = await post("/admin/faq", xlsx, "application/octet-stream");
    expect(await r.json()).toMatchObject({ ok: true, summary: "3 questions, 2 for specific categories" });
    const page = await (await fetch(`${base}/admin/prompts`, { headers: auth })).text();
    expect(page).toContain("Common FAQ (Excel)");
    // Alpha deals in press brakes: the all-sellers row and the press brake row, not the road roller one.
    expect(page).toContain("Alpha Presses: 2");
    expect(page).toContain("Do you provide installation and training?");
    expect((await fetch(`${base}/admin/faq.xlsx`, { headers: auth })).status).toBe(200);

    const chat = (message: string) =>
      fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ seller: ALPHA, sessionId: "faq-chat-001", message, pageUrl: `${base}/s/${ALPHA}/` }) }).then((x) => x.text());
    requests.length = 0;
    await chat("do you provide installation?");
    const turn = requests[0].messages.at(-1).content[0].text as string;
    expect(turn).toContain("<faq>\nQ: Do you provide installation and training?\nA: Yes, Alpha Presses installs the machine at your site and trains your operators.\n</faq>");
    requests.length = 0;
    await chat("hi");
    expect(requests[0].messages.at(-1).content[0].text).not.toContain("<faq>");

    expect((await post("/admin/faq/delete", "")).status).toBe(303);
    requests.length = 0;
    await chat("do you provide installation?");
    expect(requests[0].messages.at(-1).content[0].text).not.toContain("<faq>");
  });
});
