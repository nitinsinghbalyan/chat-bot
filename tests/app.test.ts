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
const script: Scripted[] = [
  { content: [{ type: "tool_use", id: "a", name: "send_otp", input: { mobile: "9876543210" } }], stop_reason: "tool_use" },
  { content: [{ type: "text", text: "OTP sent. Please enter it." }], stop_reason: "end_turn" },
  { content: [{ type: "tool_use", id: "b", name: "verify_otp", input: { otp: "12345" } }], stop_reason: "tool_use" },
  { content: [{ type: "text", text: "Verified. Your name?" }], stop_reason: "end_turn" },
  { content: [{ type: "tool_use", id: "c", name: "save_lead", input: { name: "=Ramesh", product: "Press Brake", requirements: "100 ton", quantity: "1 piece", city: "Rajkot" } }], stop_reason: "tool_use" },
  { content: [{ type: "text", text: "Thanks, our team will contact you." }], stop_reason: "end_turn" },
];
const recrawled: string[] = [];
let base = "";
let close: () => void;

beforeAll(async () => {
  const sellers = SellerRegistry.load(path.join(__dirname, "fixtures", "sellers"), fs.mkdtempSync(path.join(os.tmpdir(), "app-data-")));
  const app = createApp({
    client: fakeClient(script, requests),
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
    // The same welcome for every seller, and it asks the buyer nothing.
    for (const slug of [ALPHA, BETA]) {
      const { greeting, name } = await (await fetch(`${base}/api/sellers/${slug}`)).json();
      expect(greeting).toBe(`Welcome to ${name}. I can tell you about our machines, share photos and brochures, and pass your enquiry to our team.`);
      expect(greeting).not.toContain("?");
    }
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

  it("sends the enquiry summary card once the specs are in, and keeps the chat's running cost", async () => {
    const input = { name: "Ramesh", product: "Press Brake", specs: [{ label: "Material", value: "Mild steel" }], requirements: "", quantity: "1 piece", city: "Rajkot", complete: true };
    script.push(
      { content: [{ type: "tool_use", id: "d", name: "save_lead", input }], stop_reason: "tool_use" },
      { content: [{ type: "text", text: "Our team will contact you. Anything to change?" }], stop_reason: "end_turn" },
    );
    const { body } = await chat(ALPHA, "Mild steel");
    const summary = JSON.parse(body.match(/event: summary\ndata: (.*)\n/)![1]).summary;
    expect(summary.rows).toContainEqual({ label: "Material", value: "Mild steel" });
    expect(summary.note).toBe("Our team will contact you on xxxxxx3210.");
    expect(body).not.toContain("9876543210");
    // Still one lead, now with the specs; admin's transcript shows what the buyer saw.
    expect(db.listLeads(10, ALPHA)).toHaveLength(1);
    expect(db.listLeads(10, ALPHA)[0]).toMatchObject({ requirements: "Material: Mild steel", city: "Rajkot" });
    expect(db.transcript(`${ALPHA}:app-test-session`).at(-1)!.text).toContain("[Summary: Machine: Press Brake; Material: Mild steel; Quantity: 1 piece; City: Rajkot; Name: =Ramesh; Mobile: xxxxxx3210]");
    // 4 buyer messages, 2 Claude calls each at 1 + 1 tokens, kept across restarts.
    expect(db.loadSession(`${ALPHA}:app-test-session`)?.usage).toMatchObject({ turns: 4, input: 8, output: 8, costKnown: true });
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
    expect(userText).toContain("Price: confirmed by our team on enquiry");
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

  it("lists sellers as rows whose Manage section holds the controls", async () => {
    const body = await (await fetch(`${base}/admin`, { headers: auth(PASSWORD) })).text();
    const rows = body.split('<details class="srow"').slice(1);
    expect(rows.length).toBe(2);
    const alpha = rows.find((r) => r.includes(`id="seller-${ALPHA}"`)) ?? "";
    const [summary, manage] = alpha.split("</summary>");
    expect(summary).toContain("Alpha Presses");
    expect(summary).toContain(`href="/admin/leads?seller=${ALPHA}"`);
    expect(summary).toContain(`href="/s/${ALPHA}/"`);
    expect(summary).toContain("Manage");
    expect(manage).toContain(`data-upload="/admin/sellers/${ALPHA}/kb"`);
    expect(manage).toContain(`action="/admin/sellers/${ALPHA}/recrawl"`);
    expect(manage).toContain(`href="/admin/sellers/${ALPHA}/prompts"`);
    // Repo sellers can't be deleted from admin.
    expect(manage).not.toContain("Delete seller");
    expect(body).not.toContain('id="seller-filter"');
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

describe("knowledge base upload", () => {
  const kbJson = fs.readFileSync(path.join(__dirname, "fixtures", "kb", "alpha-kb.json"), "utf8");
  const upload = (seller: string, body: string, origin = base) =>
    fetch(`${base}/admin/sellers/${seller}/kb`, { method: "POST", headers: { ...auth(PASSWORD), Origin: origin, "Content-Type": "application/json" }, body });

  it("protects the upload and blocks cross-site posts", async () => {
    expect((await fetch(`${base}/admin/sellers/${ALPHA}/kb`, { method: "POST", body: kbJson })).status).toBe(401);
    expect((await upload(ALPHA, kbJson, "https://evil.example")).status).toBe(403);
  });

  it("reports invalid JSON and schema problems by field", async () => {
    const notJson = await upload(ALPHA, "{oops");
    expect(notJson.status).toBe(400);
    expect((await notJson.json()).errors[0]).toMatch(/^Not valid JSON/);
    const bad = await upload(ALPHA, JSON.stringify({ seller: {}, products: [] }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).errors).toContain("seller.company_name: Invalid input: expected string, received undefined");
  });

  it("uploads a KB the next chat turn is grounded in, with chips, cards and no prices", async () => {
    const res = await upload(ALPHA, kbJson);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, summary: { products: 2, categories: 1, videos: 3 } });
    const adminPage = await (await fetch(`${base}/admin`, { headers: auth(PASSWORD) })).text();
    expect(adminPage).toContain("JSON knowledge base");
    expect(adminPage).toContain(`href="/admin/sellers/${ALPHA}/kb.json"`);
    expect((await fetch(`${base}/admin/kb-template.json`, { headers: auth(PASSWORD) })).status).toBe(200);
    expect((await fetch(`${base}/admin/sellers/${ALPHA}/kb.json`, { headers: auth(PASSWORD) })).status).toBe(200);

    requests.length = 0;
    script.push(
      { content: [{ type: "tool_use", id: "m1", name: "share_media", input: { product_ids: ["cnc-press-brake-a1b2c3d"], kinds: ["image"], include_related: true } }], stop_reason: "tool_use" },
      { content: [{ type: "text", text: "Here are photos. Which control type do you need?" }, { type: "tool_use", id: "o1", name: "show_options", input: { options: ["CNC", "NC"] } }], stop_reason: "tool_use" },
      { content: [], stop_reason: "end_turn" },
    );
    const { body } = await chat(ALPHA, "show me photos of the cnc press brake", { origin: base, sessionId: "kb-upload-1", pageUrl: `${base}/s/${ALPHA}/` });
    expect(requests[0].system[0].text).toContain("Product id: cnc-press-brake-a1b2c3d");
    // The server picked the machine's category and gives the bot only its spec questions.
    const turn = requests[0].messages.at(-1).content.at(-1).text as string;
    expect(turn).toContain("<spec_questions>\nMachine category: Press Brakes.");
    expect(turn).toContain("1. Control Type? Options: CNC / NC");
    expect(requests[0].system[0].text).not.toContain("4,50,000");
    expect(body).toContain("event: cards");
    expect(body).toContain('"url":"https://img.alphapresses.example/cnc.jpg"');
    // Buyer is on this site, and the KB gives every product a generated page, so related cards link there.
    expect(body).toContain(`"type":"product","title":"NC Press Brake","url":"${base}/s/${ALPHA}/p/nc-press-brake-z9y8x7w"`);
    expect(body).toContain('"chips":["CNC","NC"]');
    expect(db.transcript(`${ALPHA}:kb-upload-1`).at(-1)?.text).toContain('[Shared: image "CNC Press Brake 100 Ton"');
  });

  it("removes the upload and goes back to the KB folder", async () => {
    const res = await fetch(`${base}/admin/sellers/${ALPHA}/kb/delete`, { method: "POST", headers: { ...auth(PASSWORD), Origin: base }, redirect: "manual" });
    expect(res.status).toBe(303);
    expect((await fetch(`${base}/admin/sellers/${ALPHA}/kb.json`, { headers: auth(PASSWORD) })).status).toBe(404);
  });
});

describe("adding a seller from a KB JSON", () => {
  const kb = () => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "kb", "alpha-kb.json"), "utf8"));
  const config = { name: "Gamma Machines", slug: "gamma-machines", siteUrl: "https://www.gamma.example/", color: "#2266aa", allowedOrigins: ["https://www.gamma.example"] };
  const add = (body: unknown, origin = base) =>
    fetch(`${base}/admin/sellers`, { method: "POST", headers: { ...auth(PASSWORD), Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("is admin-only, same-site only, and rejects bad details by field", async () => {
    expect((await fetch(`${base}/admin/sellers/new`)).status).toBe(401);
    expect((await fetch(`${base}/admin/sellers/new`, { headers: auth(PASSWORD) })).status).toBe(200);
    expect((await add({ config, kb: kb() }, "https://evil.example")).status).toBe(403);
    const dup = await add({ config: { ...config, slug: ALPHA }, kb: kb() });
    expect(dup.status).toBe(400);
    expect((await dup.json()).errors).toContain(`slug: "${ALPHA}" is already used by another seller`);
    const bad = await add({ config: { ...config, slug: "Bad Slug" }, kb: { seller: {}, products: [] } });
    const errs = (await bad.json()).errors as string[];
    expect(errs.some((e) => e.startsWith("slug:"))).toBe(true);
    expect(errs).toContain("seller.company_name: Invalid input: expected string, received undefined");
  });

  it("creates the seller live: directory, website from the JSON, bot grounded in it", async () => {
    const res = await add({ config, kb: kb() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, slug: "gamma-machines" });
    expect((await page_("/")).body).toContain("Gamma Machines");
    const home = await page_("/s/gamma-machines/");
    expect(home.status).toBe(200);
    // A product page built from the JSON alone, with its listed starting price and gallery.
    const product = await page_("/s/gamma-machines/p/cnc-press-brake-a1b2c3d");
    expect(product.status).toBe(200);
    expect(product.body).toContain("CNC Press Brake 100 Ton");
    expect(product.body).toContain("Starting price ₹ 4,50,000/Piece");
    expect(product.body).toContain('data-gallery-src="https://img.alphapresses.example/cnc-side.jpg"');
    expect(product.body).not.toMatch(/GST Rate|9876543210/);
    expect((await page_("/s/gamma-machines/c/press-brakes")).body).toContain("NC Press Brake");
    requests.length = 0;
    await chat("gamma-machines", "hello", { origin: base, sessionId: "gamma-chat-1", pageUrl: `${base}/s/gamma-machines/` });
    expect(requests[0].system[0].text).toContain("Product id: cnc-press-brake-a1b2c3d");
    const admin = await (await fetch(`${base}/admin`, { headers: auth(PASSWORD) })).text();
    expect(admin).toContain('id="seller-gamma-machines"');
    expect(admin).toContain("added in admin");
    expect(admin.split('id="seller-gamma-machines"')[1].split("</details>")[0]).toContain("Delete seller");
  });

  it("adds a seller whose export has blank ids, with notes about the fixes", async () => {
    const messy = kb();
    messy.categories[0].category_id = "";
    const res = await add({ config: { ...config, slug: "delta-machines", name: "Delta Machines" }, kb: messy });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warnings).toContain("categories[0].category_id (Press Brakes): empty; generated one");
    expect((await page_("/s/delta-machines/c/press-brakes")).body).toContain("NC Press Brake");
    const del = await fetch(`${base}/admin/sellers/delta-machines/delete`, { method: "POST", headers: { ...auth(PASSWORD), Origin: base }, redirect: "manual" });
    expect(del.status).toBe(303);
  });

  it("deletes an admin-added seller but not a repo seller", async () => {
    const post = (p: string) => fetch(`${base}${p}`, { method: "POST", headers: { ...auth(PASSWORD), Origin: base }, redirect: "manual" });
    expect((await post(`/admin/sellers/${ALPHA}/delete`)).status).toBe(400);
    expect((await post("/admin/sellers/gamma-machines/delete")).status).toBe(303);
    expect((await page_("/s/gamma-machines/")).status).toBe(404);
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

    // Beta keeps its own default persona from its KB folder's persona.json.
    requests.length = 0;
    await chat(BETA, "hello", { origin: base, sessionId: "persona-test-2", pageUrl: `${base}/s/${BETA}/` });
    expect(requests[0].system[0].text).not.toContain("You are Ava");
    expect(requests[0].system[0].text).toContain("<brand_persona>\nYou are Beta Pumps' helpful pump expert.\n</brand_persona>");
    expect(requests[0].messages.at(-1).content[0].text).toContain("<seller_instructions>\nAsk the required head and flow first.\n</seller_instructions>");

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

describe("common system prompt and guardrails", () => {
  const save = (fields: Record<string, string>) =>
    fetch(`${base}/admin/prompts`, {
      method: "POST",
      headers: { ...auth(PASSWORD), Origin: base, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      redirect: "manual",
    });

  it("is admin-only and keeps the required placeholders", async () => {
    expect((await fetch(`${base}/admin/prompts`)).status).toBe(401);
    const page = await (await fetch(`${base}/admin/prompts`, { headers: auth(PASSWORD) })).text();
    expect(page).toContain("These apply to <b>all 2 sellers</b>");
    expect(page).toContain("Beta Pumps"); // has its own guardrails.md
    const bad = await save({ system: "You are a bot. {{GUARDRAILS}}", guardrails: "Be nice." });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("The system prompt must contain {{BUSINESS_CARD}}.");
  });

  it("applies saved common guardrails to every seller without its own, and resets", async () => {
    const page = await (await fetch(`${base}/admin/prompts`, { headers: auth(PASSWORD) })).text();
    const system = page.match(/<textarea id="system" name="system" rows="22">([\s\S]*?)<\/textarea>/)![1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    expect((await save({ system: `COMMON-SYSTEM-MARKER\n${system}`, guardrails: "COMMON-GUARDRAIL-MARKER: never discuss competitors." })).status).toBe(303);
    expect(db.getPlatformPrompt("guardrails")?.value).toContain("COMMON-GUARDRAIL-MARKER");

    requests.length = 0;
    await chat(ALPHA, "hi", { origin: base, sessionId: "common-1", pageUrl: `${base}/s/${ALPHA}/` });
    expect(requests[0].system[0].text).toContain("COMMON-SYSTEM-MARKER");
    expect(requests[0].system[0].text).toContain("COMMON-GUARDRAIL-MARKER");
    requests.length = 0;
    await chat(BETA, "hi", { origin: base, sessionId: "common-2", pageUrl: `${base}/s/${BETA}/` });
    expect(requests[0].system[0].text).toContain("COMMON-SYSTEM-MARKER");
    expect(requests[0].system[0].text).toContain("BETA-ONLY GUARDRAIL");
    expect(requests[0].system[0].text).not.toContain("COMMON-GUARDRAIL-MARKER");

    expect((await save({ reset: "1" })).status).toBe(303);
    expect(db.getPlatformPrompt("guardrails")).toBeNull();
    requests.length = 0;
    await chat(ALPHA, "hi again", { origin: base, sessionId: "common-3", pageUrl: `${base}/s/${ALPHA}/` });
    expect(requests[0].system[0].text).not.toContain("COMMON-SYSTEM-MARKER");
  });
});

describe("prompt versions", () => {
  const post = (url: string, fields: Record<string, string> = {}) =>
    fetch(`${base}${url}`, {
      method: "POST",
      headers: { ...auth(PASSWORD), Origin: base, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      redirect: "manual",
    });
  const get = async (url: string) => (await fetch(`${base}${url}`, { headers: auth(PASSWORD) })).text();

  it("lists each save of the common prompts, shows a diff and restores an older version", async () => {
    const page = await get("/admin/prompts");
    expect(page).toContain('id="versions"');
    expect(page).toContain("Built-in default");
    const system = (await get("/admin/prompts")).match(/<textarea id="system" name="system" rows="22">([\s\S]*?)<\/textarea>/)![1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    expect((await post("/admin/prompts", { system, guardrails: "VERSION-ONE guardrails.", note: "first try" })).status).toBe(303);
    expect((await post("/admin/prompts", { system, guardrails: "VERSION-TWO guardrails.", note: "second try" })).status).toBe(303);
    const versions = db.listPromptVersions("common");
    expect(versions.slice(0, 2).map((v) => v.note)).toEqual(["second try", "first try"]);
    const [v2, v1] = versions;

    const list = await get("/admin/prompts");
    expect(list).toContain(`<b>v${v2.number}</b> <span class="badge ok">Active</span>`);
    expect(list).toContain(`action="/admin/prompts/versions/${v1.id}/restore"`);
    const view = await get(`/admin/prompts/versions/${v1.id}`);
    expect(view).toContain('<span class="d add">+ VERSION-ONE guardrails.</span>');
    expect(view).toContain('<span class="d del">− VERSION-TWO guardrails.</span>');
    expect(view).toContain("Same as the version in use.");

    const restored = await post(`/admin/prompts/versions/${v1.id}/restore`);
    expect(restored.status).toBe(303);
    expect(restored.headers.get("location")).toBe(`/admin/prompts?restored=${v1.number}`);
    expect(db.getPlatformPrompt("guardrails")?.value).toBe("VERSION-ONE guardrails.");
    expect(db.listPromptVersions("common")[0]).toMatchObject({ source: "restored", note: `Restored v${v1.number}` });
    requests.length = 0;
    await chat(ALPHA, "hi", { origin: base, sessionId: "versions-1", pageUrl: `${base}/s/${ALPHA}/` });
    expect(requests[0].system[0].text).toContain("VERSION-ONE guardrails.");

    expect((await post("/admin/prompts", { reset: "1" })).status).toBe(303);
    expect(db.listPromptVersions("common")[0].source).toBe("reset");
    expect((await fetch(`${base}/admin/prompts/versions/${v1.id}/restore`, { method: "POST", headers: { ...auth(PASSWORD), Origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(`${base}/admin/prompts/versions/999999`, { headers: auth(PASSWORD) })).status).toBe(404);
  });

  it("keeps versions of each seller's brand persona, back to its persona.json default", async () => {
    expect((await post(`/admin/sellers/${BETA}/prompts`, { system: "BETA-PERSONA-EDIT", user: "Ask the flow rate.", note: "pilot" })).status).toBe(303);
    const versions = db.listPromptVersions(`seller:${BETA}`);
    expect(versions[0]).toMatchObject({ a: "BETA-PERSONA-EDIT", note: "pilot", source: "saved" });
    const builtIn = versions.find((v) => v.source === "built-in")!;
    const page = await get(`/admin/sellers/${BETA}/prompts`);
    expect(page).toContain(`action="/admin/prompts/versions/${builtIn.id}/restore"`);
    expect((await post(`/admin/prompts/versions/${builtIn.id}/restore`)).headers.get("location")).toBe(`/admin/sellers/${BETA}/prompts?restored=${builtIn.number}`);
    // Restoring the shipped default clears the override, so later persona.json changes still apply.
    expect(db.getPrompts(BETA)).toMatchObject({ system: "", user: "" });
    expect(await get(`/admin/sellers/${BETA}/prompts`)).toContain(`<b>v${db.listPromptVersions(`seller:${BETA}`)[0].number}</b> <span class="badge ok">Active</span>`);
  });
});

describe("csvCell", () => {
  it("quotes and escapes", () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("+91 98765")).toBe("\"'+91 98765\"");
  });
});
