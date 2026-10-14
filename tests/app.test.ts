import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, csvCell } from "../src/app.js";
import { ChatDb } from "../src/db.js";
import { SellerRegistry, type SellerContext } from "../src/sellers.js";
import { SessionStore } from "../src/session.js";

type Scripted = { content: any[]; stop_reason: string };

/** Fake Claude client: replays scripted turns (text or tool calls) and records requests. */
function fakeClient(script: Scripted[], requests: any[]) {
  return {
    beta: {
      messages: {
        stream(params: any) {
          requests.push(structuredClone(params));
          const next = script.shift() ?? { content: [{ type: "text", text: "OK." }], stop_reason: "end_turn" };
          const events = next.content.flatMap((block, index) =>
            block.type === "text"
              ? [
                  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
                  { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
                  { type: "content_block_stop", index },
                ]
              : [
                  { type: "content_block_start", index, content_block: block },
                  { type: "content_block_stop", index },
                ],
          );
          return {
            async *[Symbol.asyncIterator]() {
              yield* events;
            },
            finalMessage: async () => ({ ...next, usage: { input_tokens: 1, output_tokens: 1 } }),
          };
        },
      },
    },
  } as unknown as Anthropic;
}

const PASSWORD = "correct-horse-battery";
const ALPHA = "alpha-presses";
const BETA = "beta-pumps";
const db = new ChatDb(":memory:");
const requests: any[] = [];
const recrawled: string[] = [];
let base = "";
let close: () => void;

beforeAll(async () => {
  const sellers = SellerRegistry.load(path.join(__dirname, "fixtures", "sellers"), fs.mkdtempSync(path.join(os.tmpdir(), "app-data-")));
  const app = createApp({
    client: fakeClient(
      [
        { content: [{ type: "tool_use", id: "a", name: "send_otp", input: { mobile: "9876543210" } }], stop_reason: "tool_use" },
        { content: [{ type: "text", text: "OTP sent. Please enter it." }], stop_reason: "end_turn" },
        { content: [{ type: "tool_use", id: "b", name: "verify_otp", input: { otp: "12345" } }], stop_reason: "tool_use" },
        { content: [{ type: "text", text: "Verified. Your name?" }], stop_reason: "end_turn" },
        { content: [{ type: "tool_use", id: "c", name: "save_lead", input: { name: "=Ramesh", product: "Press Brake", requirements: "100 ton", quantity: "1 piece", city: "Rajkot" } }], stop_reason: "tool_use" },
        { content: [{ type: "text", text: "Thanks, our team will contact you." }], stop_reason: "end_turn" },
      ],
      requests,
    ),
    sellers,
    sessions: new SessionStore(db),
    db,
    allowedOrigins: [],
    adminPassword: PASSWORD,
    recrawl: async (s: SellerContext) => {
      recrawled.push(s.config.slug);
    },
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close?.());

async function chat(seller: string, message: string, opts: { origin?: string; sessionId?: string; pageUrl?: string } = {}) {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: opts.origin ?? "https://www.alphapresses.example" },
    body: JSON.stringify({ seller, sessionId: opts.sessionId ?? "app-test-session", message, pageUrl: opts.pageUrl ?? "https://www.alphapresses.example/" }),
  });
  return { status: res.status, body: await res.text() };
}

const auth = (pw: string) => ({ Authorization: `Basic ${Buffer.from(`seller:${pw}`).toString("base64")}` });
const page_ = async (p: string) => {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, body: await res.text() };
};
const page = async (p: string) => {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, body: await res.text() };
};

describe("chat API", () => {
  it("rejects unknown sellers and other websites", async () => {
    expect((await chat("nobody", "hi")).status).toBe(404);
    expect((await chat(ALPHA, "hi", { origin: "https://evil.example" })).status).toBe(403);
    // Alpha's website may embed Alpha's bot, but not Beta's.
    expect((await chat(BETA, "hi", { origin: "https://www.alphapresses.example" })).status).toBe(403);
  });

  it("serves each seller's widget settings", async () => {
    const res = await fetch(`${base}/api/sellers/${ALPHA}`);
    expect(await res.json()).toMatchObject({ slug: ALPHA, name: "Alpha Presses", color: "#aa3300", chips: ["Press Brake"], position: "right" });
    expect((await fetch(`${base}/api/sellers/nobody`)).status).toBe(404);
  });

  it("runs the lead flow over SSE and saves the lead under the right seller", async () => {
    expect((await chat(ALPHA, "9876543210")).body).toContain('"askFor":"otp"');
    expect((await chat(ALPHA, "12345")).body).toContain('"askFor":"name"');
    expect((await chat(ALPHA, "Ramesh")).body).toContain("our team will contact you");
    expect(db.listLeads(10, ALPHA)).toHaveLength(1);
    expect(db.listLeads(10, BETA)).toHaveLength(0);
    expect(db.loadSession(`${ALPHA}:app-test-session`)?.lead).toMatchObject({ stage: "captured" });
    expect(db.transcript(`${ALPHA}:app-test-session`).map((t) => t.role)).toEqual(["buyer", "bot", "buyer", "bot", "buyer", "bot"]);
  });

  it("uses each seller's own system prompt", async () => {
    requests.length = 0;
    await chat(BETA, "hello", { origin: base, sessionId: "beta-session-1", pageUrl: `${base}/s/${BETA}/` });
    expect(requests[0].system[0].text).toContain("Beta Pumps & Motors");
    expect(requests[0].system[0].text).not.toContain("Alpha Presses");
  });

  it("tells the bot which product page the buyer is on", async () => {
    requests.length = 0;
    await chat(ALPHA, "what is the price of this?", { origin: base, sessionId: "page-ctx-1", pageUrl: `${base}/s/${ALPHA}/p/cnc-press-brake-a1b2c3d` });
    const userText = requests[0].messages.at(-1).content[0].text as string;
    expect(userText).toContain("<current_page>\nThe buyer is viewing: CNC Press Brake (https://www.alphapresses.example/product/cnc-press-brake-a1b2c3d.html)");
    expect(userText).toContain("Listed starting price: ₹4,50,000 / Piece");
  });
});

describe("website", () => {
  it("lists every seller in the directory with Visit site and Edit prompts, and no chat", async () => {
    const { status, body } = await page("/");
    expect(status).toBe(200);
    expect(body).toContain("Alpha Presses");
    expect(body).toContain("Beta Pumps");
    expect(body).toContain(`<a class="btn" href="/s/${ALPHA}/">Visit site</a>`);
    expect(body).toContain(`href="/admin/sellers/${ALPHA}/prompts">Edit prompts</a>`);
    expect(body).not.toContain("data-chat-open");
    expect(body).not.toContain("widget.js");
  });

  it("renders a seller home page with categories, products and their bot", async () => {
    const { body } = await page(`/s/${ALPHA}/`);
    expect(body).toContain("Alpha Presses Pvt Ltd");
    expect(body).toContain(`href="/s/${ALPHA}/c/press-brakes"`);
    expect(body).toContain(`href="/s/${ALPHA}/p/cnc-press-brake-a1b2c3d"`);
    expect(body).toContain(`data-seller="${ALPHA}"`);
    expect(body).toContain('<link rel="canonical" href="https://www.alphapresses.example/">');
    expect(body).toContain('<meta name="robots" content="noindex, follow">');
  });

  it("renders a category page with crawled and uncrawled products, escaping page text", async () => {
    const { body } = await page(`/s/${ALPHA}/c/press-brakes`);
    expect(body).toContain("Our &lt;b&gt;press brakes&lt;/b&gt; for sheet bending.");
    expect(body).toContain(`href="/s/${ALPHA}/p/cnc-press-brake-a1b2c3d"`);
    // Listed on the category page but not crawled: links to the original page.
    expect(body).toContain('href="https://www.alphapresses.example/product/nc-press-brake-z9y8x7w.html"');
  });

  it("renders a product page with a starting price, specs and the original link", async () => {
    const { body } = await page(`/s/${ALPHA}/p/cnc-press-brake-a1b2c3d`);
    expect(body).toContain("Starting price ₹4,50,000 / Piece");
    expect(body).toContain("<th>Pressing Force</th><td>100 ton</td>");
    expect(body).toContain('<link rel="canonical" href="https://www.alphapresses.example/product/cnc-press-brake-a1b2c3d.html">');
    expect(body).toContain("Get the best quote");
    expect(body).toContain(`href="/s/${ALPHA}/c/press-brakes">Press Brakes</a>`);
    // Photo gallery with every crawled image, plus description paragraphs and features.
    expect(body).toContain('id="gallery-main" class="img detail-img" src="https://img.alphapresses.example/cnc.jpg"');
    expect(body).toContain('data-gallery-src="https://img.alphapresses.example/cnc-side.jpg"');
    expect(body).toContain("<p>Heavy frame.</p><p>Back gauge included.</p>");
    expect(body).toContain("<li>CNC controller</li>");
  });

  it("renders About Us from the business card facts only", async () => {
    const { status, body } = await page(`/s/${ALPHA}/about`);
    expect(status).toBe(200);
    expect(body).toContain("<th>CEO</th><td>A. Sharma</td>");
    expect(body).toContain("<th>Location</th><td>Rajkot, Gujarat</td>");
    // "Press Brakes" in deals_in links to the matching crawled category.
    expect(body).toContain(`<li><a href="/s/${ALPHA}/c/press-brakes">Press Brakes</a></li>`);
    expect(body).toContain("<li>Shearing Machines</li>");
    expect(body).not.toMatch(/turnover|employees|established/i);
  });

  it("renders the products and contact pages with the main navigation", async () => {
    const products = (await page(`/s/${ALPHA}/products`)).body;
    expect(products).toContain('<section id="press-brakes">');
    expect(products).toContain(`href="/s/${ALPHA}/p/cnc-press-brake-a1b2c3d"`);
    expect(products).toContain(`<a href="/s/${ALPHA}/products" aria-current="page">Products</a>`);
    const contact = (await page(`/s/${ALPHA}/contact`)).body;
    expect(contact).toContain('href="tel:9000000001"');
    expect(contact).toContain("Start an enquiry");
    for (const nav of ["About Us", "Contact Us"]) expect(contact).toContain(`>${nav}</a>`);
  });

  it("searches only within the seller", async () => {
    expect((await page(`/s/${ALPHA}/search?q=press`)).body).toContain("CNC Press Brake");
    expect((await page(`/s/${ALPHA}/search?q=pump`)).body).toContain("Nothing matched");
  });

  it("returns 404 for unknown sellers, categories and products", async () => {
    expect((await page("/s/nobody/")).status).toBe(404);
    expect((await page(`/s/${ALPHA}/p/nothing`)).status).toBe(404);
    expect((await page(`/s/${ALPHA}/c/nothing`)).status).toBe(404);
    expect((await page("/no/such/page")).status).toBe(404);
  });

  it("shows each seller's own products and listed contact number", async () => {
    const { body } = await page(`/s/${BETA}/`);
    expect(body).toContain("Openwell Submersible Pump");
    expect(body).toContain("Call 9000000002");
  });
});

describe("admin", () => {
  it("protects admin pages with the password", async () => {
    expect((await fetch(`${base}/admin`)).status).toBe(401);
    expect((await fetch(`${base}/admin/leads`, { headers: auth("wrong-password!!") })).status).toBe(401);
    const res = await fetch(`${base}/admin`, { headers: auth(PASSWORD) });
    const body = await res.text();
    expect(body).toContain("Alpha Presses");
    expect(body).toContain("Re-crawl now");
  });

  it("filters leads by seller and exports CSV with formulas defused", async () => {
    const page = await (await fetch(`${base}/admin/leads?seller=${ALPHA}`, { headers: auth(PASSWORD) })).text();
    expect(page).toContain("9876543210");
    const empty = await (await fetch(`${base}/admin/leads?seller=${BETA}`, { headers: auth(PASSWORD) })).text();
    expect(empty).toContain("No leads yet.");
    const csv = await (await fetch(`${base}/admin/leads.csv?seller=${ALPHA}`, { headers: auth(PASSWORD) })).text();
    expect(csv.split("\r\n")[0]).toContain("seller");
    expect(csv).toContain(`"${ALPHA}","'=Ramesh","9876543210","Press Brake"`);
  });

  it("shows a chat transcript", async () => {
    const res = await fetch(`${base}/admin/transcript/${ALPHA}:app-test-session`, { headers: auth(PASSWORD) });
    expect(await res.text()).toContain("Thanks, our team will contact you.");
  });

  it("re-crawls on a same-site POST and blocks cross-site ones", async () => {
    const blocked = await fetch(`${base}/admin/sellers/${ALPHA}/recrawl`, { method: "POST", headers: { ...auth(PASSWORD), Origin: "https://evil.example" }, redirect: "manual" });
    expect(blocked.status).toBe(403);
    const ok = await fetch(`${base}/admin/sellers/${ALPHA}/recrawl`, { method: "POST", headers: { ...auth(PASSWORD), Origin: base }, redirect: "manual" });
    expect(ok.status).toBe(303);
    expect(recrawled).toEqual([ALPHA]);
  });
});

describe("brand persona prompts", () => {
  const form = (seller: string, fields: Record<string, string>, origin = base) =>
    fetch(`${base}/admin/sellers/${seller}/prompts`, {
      method: "POST",
      headers: { ...auth(PASSWORD), Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      redirect: "manual",
    });

  it("protects the form and blocks cross-site saves", async () => {
    expect((await fetch(`${base}/admin/sellers/${ALPHA}/prompts`)).status).toBe(401);
    expect((await fetch(`${base}/admin/sellers/nobody/prompts`, { headers: auth(PASSWORD) })).status).toBe(404);
    expect((await form(ALPHA, { system: "x", user: "y" }, "https://evil.example")).status).toBe(403);
    expect((await form(ALPHA, { system: "x".repeat(4001), user: "" })).status).toBe(400);
  });

  it("saves a persona that the next chat turn uses, for that seller only", async () => {
    const saved = await form(ALPHA, { system: "You are Ava, the Alpha Presses assistant.", user: "Always ask the sheet thickness." });
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe(`/admin/sellers/${ALPHA}/prompts?saved=1`);
    expect(db.getPrompts(ALPHA).system).toBe("You are Ava, the Alpha Presses assistant.");
    const page = await (await fetch(`${base}/admin/sellers/${ALPHA}/prompts?saved=1`, { headers: auth(PASSWORD) })).text();
    expect(page).toContain("Saved.");
    expect(page).toContain("&lt;brand_persona&gt;\nYou are Ava");

    requests.length = 0;
    await chat(ALPHA, "hello", { origin: base, sessionId: "persona-test-1", pageUrl: `${base}/s/${ALPHA}/` });
    expect(requests[0].system[0].text).toContain("<brand_persona>\nYou are Ava, the Alpha Presses assistant.\n</brand_persona>");
    expect(requests[0].messages.at(-1).content[0].text).toContain("<seller_instructions>\nAlways ask the sheet thickness.\n</seller_instructions>");

    requests.length = 0;
    await chat(BETA, "hello", { origin: base, sessionId: "persona-test-2", pageUrl: `${base}/s/${BETA}/` });
    expect(requests[0].system[0].text).not.toContain("brand_persona");
    expect(requests[0].messages.at(-1).content[0].text).not.toContain("seller_instructions");

    expect((await page_("/")).body).toContain("Brand persona set");
  });

  it("clears the persona", async () => {
    expect((await form(ALPHA, { system: "ignored", user: "ignored", clear: "1" })).status).toBe(303);
    expect(db.getPrompts(ALPHA)).toMatchObject({ system: "", user: "" });
    requests.length = 0;
    await chat(ALPHA, "hello again", { origin: base, sessionId: "persona-test-3", pageUrl: `${base}/s/${ALPHA}/` });
    expect(requests[0].system[0].text).not.toContain("brand_persona");
  });
});

describe("csvCell", () => {
  it("quotes and escapes", () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("+91 98765")).toBe("\"'+91 98765\"");
  });
});
