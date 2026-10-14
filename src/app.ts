import { randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import express, { type NextFunction, type Request, type Response } from "express";
import { runTurn } from "./claude.js";
import { config, paths } from "./config.js";
import type { CatalogueEntry } from "./crawler.js";
import type { ChatDb, SellerPersona } from "./db.js";
import { checkInput, RateLimiter } from "./guardrails.js";
import type { SellerContext, SellerRegistry } from "./sellers.js";
import type { SessionStore } from "./session.js";
import { SELLER_KB_TEMPLATE, validateSellerKb } from "./sellerKb.js";
import { defaultSystemTemplate, REQUIRED_PLACEHOLDERS, sharedGuardrails, validateSystemTemplate } from "./prompts.js";
import { shareMedia } from "./shareMedia.js";
import { esc } from "./site/html.js";
import { aboutPage, categoryPage, contactPage, directoryPage, notFoundPage, productPage, productsPage, searchPage, sellerHomePage } from "./site/pages.js";

export interface AppDeps {
  client: Anthropic;
  sellers: SellerRegistry;
  sessions: SessionStore;
  db: ChatDb;
  /** Re-crawls one seller's sitemap into their catalogue (wired to the crawler in server.ts). */
  recrawl?: (seller: SellerContext) => Promise<void>;
  /** Fallback origins allowed for every seller, in addition to each seller's own `allowedOrigins`. */
  allowedOrigins?: string[];
  adminPassword?: string;
}

/** Maximum characters for each brand persona prompt. */
export const PERSONA_LIMITS = { system: 4000, user: 2000 } as const;

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function createApp(deps: AppDeps) {
  const { sellers, db, sessions } = deps;
  const globalOrigins = deps.allowedOrigins ?? config.ALLOWED_ORIGINS;
  const adminPassword = deps.adminPassword ?? config.ADMIN_PASSWORD;

  const perSession = new RateLimiter(15, 60_000);
  const perIp = new RateLimiter(60, 60_000);
  const busy = new Set<string>();

  // The common system prompt and guardrails edited in admin apply to every seller.
  {
    const system = db.getPlatformPrompt("system")?.value;
    const guardrails = db.getPlatformPrompt("guardrails")?.value;
    const systemOk = system !== undefined && validateSystemTemplate(system).length === 0;
    if (system !== undefined && !systemOk) console.error("[prompts] the saved common system prompt is invalid; using prompts/system.md");
    if (systemOk || guardrails) sellers.setCommonPrompts({ ...(systemOk ? { system } : {}), ...(guardrails ? { guardrails } : {}) });
  }

  // Brand personas saved in admin live in the database, so they survive restarts and redeploys.
  for (const s of sellers.list()) {
    const p = db.getPrompts(s.config.slug);
    if (p.system || p.user) sellers.setPersona(s.config.slug, p);
  }

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  // Chat requests are small; the admin KB upload has its own, larger limit.
  app.use("/api", express.json({ limit: "16kb" }));

  const sameHost = (req: Request, url: string | undefined): boolean => {
    if (!url) return false;
    try {
      return new URL(url).host === req.headers.host;
    } catch {
      return false;
    }
  };

  /** This platform's own pages may call the API for any seller; other sites only for sellers that list them. */
  function originAllowed(req: Request, seller?: SellerContext): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (sameHost(req, origin) || globalOrigins.includes(origin)) return true;
    if (seller) return seller.config.allowedOrigins.some((o) => o.replace(/\/$/, "") === origin);
    return sellers.list().some((s) => s.config.allowedOrigins.some((o) => o.replace(/\/$/, "") === origin));
  }

  function cors(req: Request, res: Response, next: NextFunction) {
    const origin = req.headers.origin;
    if (origin && originAllowed(req)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(originAllowed(req) ? 204 : 403);
      return;
    }
    next();
  }

  app.use("/api", cors);

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      model: config.BOT_MODEL,
      sellers: sellers.list().map((s) => ({ slug: s.config.slug, catalogueEntries: s.catalogue.size, productCards: s.kb.productCards.length })),
    });
  });

  // ---- Chat API ----

  app.get("/api/sellers/:seller", (req, res) => {
    const seller = sellers.get(String(req.params.seller));
    if (!seller) {
      res.status(404).json({ error: "Unknown seller" });
      return;
    }
    const c = seller.config;
    // No SMS gateway is wired yet, so the widget shows the demo OTP hint.
    res.json({ slug: c.slug, name: c.name, color: c.color, greeting: c.greeting ?? null, chips: c.chips ?? seller.kb.productCards.map((p) => p.canonical_name).slice(0, 4), position: c.widgetPosition, demo: true });
  });

  /** Works out which catalogue page the buyer is on: a page of this site or the seller's own page. */
  function pageEntryFor(seller: SellerContext, pageUrl: string | undefined): CatalogueEntry | null {
    if (!pageUrl) return null;
    let u: URL;
    try {
      u = new URL(pageUrl);
    } catch {
      return null;
    }
    const m = u.pathname.match(/^\/s\/([^/]+)\/(p|c)\/([^/]+)\/?$/);
    if (m && m[1] === seller.config.slug) return seller.catalogue.get(m[2] === "p" ? "product" : "category", decodeURIComponent(m[3]));
    return seller.catalogue.byPageUrl(u.origin + u.pathname);
  }

  app.post("/api/chat", async (req, res) => {
    const seller = typeof req.body?.seller === "string" ? sellers.get(req.body.seller) : undefined;
    if (!seller) {
      res.status(404).json({ error: "Unknown seller" });
      return;
    }
    if (!originAllowed(req, seller)) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }
    const slug = seller.config.slug;
    const sessionId = typeof req.body?.sessionId === "string" && SESSION_ID_RE.test(req.body.sessionId) ? req.body.sessionId : randomUUID();
    const pageUrl = typeof req.body?.pageUrl === "string" ? req.body.pageUrl.slice(0, 300) : undefined;
    // The buyer is on this platform's generated site (not the seller's own website).
    const onPlatform = sameHost(req, pageUrl);

    const input = checkInput(req.body?.message);
    if (!input.ok) {
      res.status(400).json({ error: input.error, sessionId });
      return;
    }
    const key = `${slug}:${sessionId}`;
    if (!perIp.allow(req.ip ?? "unknown") || !perSession.allow(key)) {
      res.status(429).json({ error: "You're sending messages too quickly. Please wait a moment.", sessionId });
      return;
    }
    if (busy.has(key)) {
      res.status(409).json({ error: "Please wait for the previous reply to finish.", sessionId });
      return;
    }

    busy.add(key);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    send("session", { sessionId });
    try {
      const session = sessions.get(slug, sessionId);
      // Store what the buyer typed after redaction, never the raw payment/ID details.
      db.appendTranscript({ seller: slug, sessionId: session.id, role: "buyer", text: input.text });
      const result = await runTurn(
        session,
        input.text,
        {
          client: deps.client,
          kb: seller.kb,
          catalogue: seller.catalogue,
          systemPrompt: seller.systemPrompt,
          sellerInstructions: seller.persona.user,
          shareMedia: (ids, kinds, related) => shareMedia(seller, ids, kinds, related, { siteOrigin: onPlatform ? `${req.protocol}://${req.headers.host}` : null }),
          saveLead: (lead) => db.insertLead(lead),
          logGuardrail: (id, interventions) => db.logGuardrailEvents(slug, id, interventions),
        },
        { onText: (text) => send("text", { text }) },
        { pageUrl, pageEntry: pageEntryFor(seller, pageUrl) },
      );
      sessions.save(session);
      const sharedNote = result.cards.length ? `\n[Shared: ${result.cards.map((c) => `${c.type} "${c.title}"`).join(", ")}]` : "";
      db.appendTranscript({ seller: slug, sessionId: session.id, role: "bot", text: result.text + sharedNote, guardrails: result.interventions.map((i) => i.rule) });
      if (result.cards.length) send("cards", { cards: result.cards });
      send("ui", { askFor: result.askFor, leadStage: session.lead.stage, chips: result.chips });
      if (process.env.NODE_ENV !== "production") send("debug", { usage: result.usage, interventions: result.interventions.map((i) => i.rule) });
      send("done", {});
    } catch (err) {
      console.error(err);
      send("error", { error: "Something went wrong. Please try again." });
    } finally {
      busy.delete(key);
      res.end();
    }
  });

  // ---- Website: seller directory and each seller's mini-site ----

  const html = (res: Response, body: string, status = 200) => res.status(status).type("html").send(body);

  function withSeller(handler: (seller: SellerContext, req: Request, res: Response) => void) {
    return (req: Request, res: Response) => {
      const seller = sellers.get(String(req.params.seller));
      if (!seller) return html(res, notFoundPage("Seller not found"), 404);
      handler(seller, req, res);
    };
  }

  app.get("/", (_req, res) => html(res, directoryPage(sellers.list(), { adminEnabled: !!adminPassword })));
  // Routing isn't strict, so this serves both /s/<seller> and /s/<seller>/.
  app.get("/s/:seller/", withSeller((seller, _req, res) => html(res, sellerHomePage(seller))));
  app.get("/s/:seller/about", withSeller((seller, _req, res) => html(res, aboutPage(seller))));
  app.get("/s/:seller/products", withSeller((seller, _req, res) => html(res, productsPage(seller))));
  app.get("/s/:seller/contact", withSeller((seller, _req, res) => html(res, contactPage(seller))));
  app.get(
    "/s/:seller/c/:slug",
    withSeller((seller, req, res) => {
      const c = seller.catalogue.get("category", String(req.params.slug));
      return c ? html(res, categoryPage(seller, c)) : html(res, notFoundPage("Category not found"), 404);
    }),
  );
  app.get(
    "/s/:seller/p/:slug",
    withSeller((seller, req, res) => {
      const p = seller.catalogue.get("product", String(req.params.slug));
      return p ? html(res, productPage(seller, p)) : html(res, notFoundPage("Product not found"), 404);
    }),
  );
  app.get(
    "/s/:seller/search",
    withSeller((seller, req, res) => html(res, searchPage(seller, typeof req.query.q === "string" ? req.query.q.slice(0, 100) : ""))),
  );

  // ---- Admin: sellers, leads and transcripts (HTTP Basic auth, any username) ----

  function requireAdmin(req: Request, res: Response, next: NextFunction) {
    if (!adminPassword) {
      res.status(404).send("Not found");
      return;
    }
    const header = req.headers.authorization ?? "";
    const supplied = header.startsWith("Basic ") ? Buffer.from(header.slice(6), "base64").toString("utf8").split(":").slice(1).join(":") : "";
    const a = Buffer.from(supplied);
    const b = Buffer.from(adminPassword);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Chatbot admin", charset="UTF-8"');
      res.status(401).send("Authentication required");
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex");
    next();
  }

  /** Browsers resend Basic auth automatically, so admin POSTs must come from this site (CSRF guard). */
  function sameOriginPost(req: Request, res: Response, next: NextFunction) {
    if (!sameHost(req, req.headers.origin ?? req.headers.referer)) {
      res.status(403).send("Cross-site request blocked");
      return;
    }
    next();
  }

  const sellerFilter = (req: Request): string | undefined => {
    const s = typeof req.query.seller === "string" ? req.query.seller : undefined;
    return s && sellers.get(s) ? s : undefined;
  };

  app.get("/admin", requireAdmin, (_req, res) => {
    const counts = db.leadCounts();
    const rows = sellers
      .list()
      .map((s) => {
        const c = s.lastCrawl;
        return `<tr><td><a href="/s/${esc(s.config.slug)}/">${esc(s.config.name)}</a><br><small>${esc(s.config.slug)}</small></td>
<td><a href="/admin/leads?seller=${encodeURIComponent(s.config.slug)}">${counts[s.config.slug] ?? 0}</a></td>
<td>${s.catalogue.size} <small>(${s.catalogue.list("product").length} products, ${s.catalogue.list("category").length} categories)</small><br><small>${s.sitemapPages} in sitemap · updated ${esc(s.catalogue.updatedAt?.toISOString() ?? "never")}</small></td>
<td>${c ? `${c.ok ? "OK" : "Failed"} <small>${esc(c.at)}</small><br><small>${esc(c.message)}</small>` : "<small>none this run</small>"}</td>
<td>${kbCell(s)}</td>
<td><a href="/admin/sellers/${esc(s.config.slug)}/prompts">${s.persona.system || s.persona.user ? "Edit" : "Set"} prompts</a></td>
<td><form method="post" action="/admin/sellers/${esc(s.config.slug)}/recrawl"><button${deps.recrawl ? "" : " disabled"}>Re-crawl now</button></form></td></tr>`;
      })
      .join("");
    res.send(
      adminPage(
        "Sellers",
        `<p><a href="/admin/leads">All leads</a> · <a href="/admin/prompts">Common system prompt and guardrails (all sellers)</a> · <a href="/">Public directory</a></p><table><thead><tr><th>Seller</th><th>Leads</th><th>Catalogue</th><th>Last crawl</th><th>Knowledge base (JSON)</th><th>Brand persona</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7">No sellers.</td></tr>'}</tbody></table>
<p><small>The knowledge base JSON is the seller export (version 3.0: seller, company_pages, photo_gallery, categories, products). <a href="/admin/kb-template.json">Download a template</a>. Prices, delivery and payment terms, turnover, staff numbers, year of establishment, GST, bank and rating details in it are never used by the bot.</small></p>
${KB_UPLOAD_SCRIPT}`,
      ),
    );
  });

  function kbCell(s: SellerContext): string {
    const slug = esc(s.config.slug);
    const u = s.uploaded;
    const status = u
      ? `<b>Uploaded JSON</b><br><small>${u.summary.products} products, ${u.summary.categories} categories, ${u.summary.images} photos, ${u.summary.videos} videos, ${u.summary.documents} PDFs<br>${esc(u.uploadedAt)}</small><br>
<a href="/admin/sellers/${slug}/kb.json">Download</a> · <form method="post" action="/admin/sellers/${slug}/kb/delete" style="display:inline" onsubmit="return confirm('Remove the uploaded knowledge base? The bot goes back to the KB folder files.')"><button class="link">Remove</button></form>`
      : `<small>Using the KB folder files (${s.fileKb.productCards.length} product cards)</small>`;
    return `${status}
<form class="kb-upload" data-slug="${slug}"><input type="file" accept=".json,application/json" required aria-label="Knowledge base JSON for ${esc(s.config.name)}"> <button type="submit">${u ? "Replace" : "Upload"} JSON</button></form>
<div class="kb-result" aria-live="polite"></div>`;
  }

  app.get("/admin/kb-template.json", requireAdmin, (_req, res) => {
    res.setHeader("Content-Disposition", 'attachment; filename="seller-kb-template.json"');
    res.json(SELLER_KB_TEMPLATE);
  });

  app.get("/admin/sellers/:seller/kb.json", requireAdmin, (req, res) => {
    const seller = sellers.get(String(req.params.seller));
    if (!seller?.uploaded) {
      res.status(404).send("No uploaded knowledge base");
      return;
    }
    res.setHeader("Content-Disposition", `attachment; filename="${seller.config.slug}-kb.json"`);
    res.json(seller.uploaded.view.kb);
  });

  // Upload: the raw JSON is the request body (the /admin page reads the file and posts it).
  app.post("/admin/sellers/:seller/kb", requireAdmin, sameOriginPost, express.text({ type: "*/*", limit: "10mb" }), (req, res) => {
    const seller = sellers.get(String(req.params.seller));
    if (!seller) {
      res.status(404).json({ ok: false, errors: ["Unknown seller"] });
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(typeof req.body === "string" ? req.body : "");
    } catch (err) {
      res.status(400).json({ ok: false, errors: [`Not valid JSON: ${(err as Error).message}`] });
      return;
    }
    const result = validateSellerKb(data);
    if (!result.ok) {
      res.status(400).json({ ok: false, errors: result.errors });
      return;
    }
    // Write atomically so a crash mid-write never leaves a half file on the disk.
    fs.mkdirSync(path.dirname(seller.uploadedKbFile), { recursive: true });
    const tmp = `${seller.uploadedKbFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, seller.uploadedKbFile);
    sellers.setUploadedKb(seller.config.slug, result.kb);
    res.json({ ok: true, summary: result.summary, warnings: result.warnings });
  });

  app.post("/admin/sellers/:seller/kb/delete", requireAdmin, sameOriginPost, (req, res) => {
    const seller = sellers.get(String(req.params.seller));
    if (!seller) {
      res.status(404).send("Not found");
      return;
    }
    fs.rmSync(seller.uploadedKbFile, { force: true });
    sellers.setUploadedKb(seller.config.slug, null);
    res.redirect(303, "/admin");
  });

  app.post("/admin/sellers/:seller/recrawl", requireAdmin, sameOriginPost, (req, res) => {
    const seller = sellers.get(String(req.params.seller));
    if (!seller || !deps.recrawl) {
      res.status(404).send("Not found");
      return;
    }
    // Crawling takes minutes; run it in the background and show the result on /admin.
    void deps.recrawl(seller);
    res.redirect(303, "/admin");
  });

  // ---- Brand persona prompts (per seller) ----

  function promptsForm(seller: SellerContext, values: SellerPersona, opts: { saved?: boolean; error?: string } = {}): string {
    const slug = esc(seller.config.slug);
    const updated = db.getPrompts(seller.config.slug).updatedAt;
    const box = (name: "system" | "user", label: string, help: string, placeholder: string) => `
<label for="${name}"><b>${label}</b></label>
<p><small>${help}</small></p>
<textarea id="${name}" name="${name}" rows="${name === "system" ? 12 : 6}" maxlength="${PERSONA_LIMITS[name]}" placeholder="${esc(placeholder)}" data-count="${name}-count">${esc(values[name])}</textarea>
<p><small><span id="${name}-count">${values[name].length}</span> / ${PERSONA_LIMITS[name]} characters</small></p>`;
    return adminPage(
      `Brand persona: ${esc(seller.config.name)}`,
      `<p><a href="/admin">← Sellers</a> · <a href="/s/${slug}/">Open site</a></p>
${opts.saved ? '<p class="ok">Saved. New chat turns use these prompts straight away.</p>' : ""}
${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ""}
${seller.defaultPersona.system || seller.defaultPersona.user ? `<p><small>Default from <code>kb/sellers/${slug}/persona.json</code> is used until you save here; <b>Reset to default</b> goes back to it.</small></p>` : ""}
<p>These prompts are added on top of the <a href="/admin/prompts">common system prompt and guardrails</a>. The 9 guardrails, the knowledge sources and the OTP enquiry steps always apply and win if anything here conflicts with them.</p>
<form method="post" action="/admin/sellers/${slug}/prompts" class="prompts">
${box(
  "system",
  "System prompt: brand persona",
  "Who the assistant is and how it should come across: its name, tone, greeting style, what to emphasise about the brand. Added to the system prompt once.",
  "Example: You are Jay, the friendly assistant for Jayshree Machinetools. Speak like an experienced machine-tool engineer: practical, confident and concise. Mention our in-house manufacturing in Rajkot when buyers compare options.",
)}
${box(
  "user",
  "User prompt: added to every buyer message",
  "A short standing instruction re-sent with each buyer message. Use it for things the assistant must keep in mind on every reply.",
  "Example: Always ask which material and thickness the buyer works with before suggesting a machine.",
)}
<p><button type="submit">Save</button> <button type="submit" name="clear" value="1" onclick="return confirm('Reset both prompts to this seller\\'s default?')">Reset to default</button>${updated ? ` <small>Last saved ${esc(new Date(updated).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }))} IST</small>` : ""}</p>
</form>
<details><summary>Full system prompt preview (as the assistant sees it)</summary><pre>${esc(seller.systemPrompt)}</pre></details>
<script>document.querySelectorAll("textarea[data-count]").forEach(function (t) { t.addEventListener("input", function () { document.getElementById(t.getAttribute("data-count")).textContent = t.value.length; }); });</script>`,
    );
  }

  // ---- Common system prompt and guardrails (every seller) ----

  function commonForm(values: { system: string; guardrails: string }, opts: { saved?: boolean; errors?: string[] } = {}): string {
    const sys = db.getPlatformPrompt("system");
    const gr = db.getPlatformPrompt("guardrails");
    const own = sellers.list().filter((s) => s.ownGuardrails !== null);
    const preview = sellers.list()[0];
    return adminPage(
      "Common system prompt and guardrails",
      `<p><a href="/admin">← Sellers</a></p>
${opts.saved ? '<p class="ok">Saved. Every seller uses these from the next chat turn.</p>' : ""}
${opts.errors?.length ? `<div class="err"><p>Not saved:</p><ul>${opts.errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : ""}
<p>These apply to <b>${sellers.size === 1 ? "the 1 seller" : `all ${sellers.size} sellers`}</b>. Each seller adds its own knowledge base and <a href="/admin">brand persona</a> on top.${own.length ? ` Sellers with their own <code>guardrails.md</code> keep it: ${own.map((s) => esc(s.config.name)).join(", ")}.` : ""}</p>
<form method="post" action="/admin/prompts" class="prompts">
<label for="system"><b>System prompt (common)</b> ${sys ? `<small>edited ${esc(sys.updatedAt)}</small>` : "<small>default: prompts/system.md</small>"}</label>
<p><small>Placeholders filled per seller: ${REQUIRED_PLACEHOLDERS.map((p) => `<code>{{${p}}}</code>`).join(" ")} (required) and <code>{{SELLER_NAME}}</code>.</small></p>
<textarea id="system" name="system" rows="22">${esc(values.system)}</textarea>
<label for="guardrails"><b>Chat guardrails (common)</b> ${gr ? `<small>edited ${esc(gr.updatedAt)}</small>` : "<small>default: prompts/guardrails.md</small>"}</label>
<p><small>Inserted at <code>{{GUARDRAILS}}</code>. Code-level checks (prices, freight, contacts, stock, payment/ID, delivery, GST) run on every reply whatever this text says.</small></p>
<textarea id="guardrails" name="guardrails" rows="18">${esc(values.guardrails)}</textarea>
<p><button type="submit">Save for all sellers</button> <button type="submit" name="reset" value="1" onclick="return confirm('Reset both to the defaults in prompts/?')">Reset to defaults</button></p>
</form>
${preview ? `<details><summary>Preview: full system prompt for ${esc(preview.config.name)}</summary><pre>${esc(preview.systemPrompt)}</pre></details>` : ""}`,
    );
  }

  app.get("/admin/prompts", requireAdmin, (req, res) => {
    res.send(commonForm(sellers.common, { saved: req.query.saved === "1" }));
  });

  app.post("/admin/prompts", requireAdmin, sameOriginPost, express.urlencoded({ extended: false, limit: "256kb" }), (req, res) => {
    if (req.body?.reset === "1") {
      db.setPlatformPrompt("system", null);
      db.setPlatformPrompt("guardrails", null);
      sellers.setCommonPrompts({ system: null, guardrails: null });
      res.redirect(303, "/admin/prompts?saved=1");
      return;
    }
    const system = String(req.body?.system ?? "").replace(/\r\n/g, "\n");
    const guardrails = String(req.body?.guardrails ?? "").replace(/\r\n/g, "\n").trim();
    const errors = validateSystemTemplate(system);
    if (!guardrails) errors.push("The guardrails must not be empty.");
    if (guardrails.length > 20_000) errors.push(`The guardrails are too long (${guardrails.length} of 20,000 characters).`);
    if (errors.length) {
      res.status(400).send(commonForm({ system, guardrails }, { errors }));
      return;
    }
    // Store only what differs from the defaults, so later edits to prompts/ still apply.
    db.setPlatformPrompt("system", system.trim() === defaultSystemTemplate().trim() ? null : system);
    db.setPlatformPrompt("guardrails", guardrails === sharedGuardrails() ? null : guardrails);
    sellers.setCommonPrompts({ system, guardrails });
    res.redirect(303, "/admin/prompts?saved=1");
  });

  app.get("/admin/sellers/:seller/prompts", requireAdmin, (req, res) => {
    const seller = sellers.get(String(req.params.seller));
    if (!seller) {
      res.status(404).send("Not found");
      return;
    }
    res.send(promptsForm(seller, seller.persona, { saved: req.query.saved === "1" }));
  });

  app.post("/admin/sellers/:seller/prompts", requireAdmin, sameOriginPost, express.urlencoded({ extended: false, limit: "64kb" }), (req, res) => {
    const seller = sellers.get(String(req.params.seller));
    if (!seller) {
      res.status(404).send("Not found");
      return;
    }
    const clear = req.body?.clear === "1";
    const values: SellerPersona = clear
      ? { system: "", user: "" }
      : { system: String(req.body?.system ?? "").replace(/\r\n/g, "\n").trim(), user: String(req.body?.user ?? "").replace(/\r\n/g, "\n").trim() };
    const tooLong = (["system", "user"] as const).find((k) => values[k].length > PERSONA_LIMITS[k]);
    if (tooLong) {
      res.status(400).send(promptsForm(seller, values, { error: `The ${tooLong} prompt is too long (${values[tooLong].length} of ${PERSONA_LIMITS[tooLong]} characters).` }));
      return;
    }
    db.savePrompts(seller.config.slug, values);
    // Clearing (or saving both empty) goes back to the seller's default persona from persona.json.
    sellers.setPersona(seller.config.slug, values.system || values.user ? values : seller.defaultPersona);
    res.redirect(303, `/admin/sellers/${encodeURIComponent(seller.config.slug)}/prompts?saved=1`);
  });

  app.get("/admin/leads.csv", requireAdmin, (req, res) => {
    const cols = ["createdAt", "seller", "name", "mobile", "product", "requirements", "quantity", "city", "pageUrl", "sessionId"] as const;
    const lines = [cols.join(",")];
    for (const lead of db.listLeads(10_000, sellerFilter(req))) lines.push(cols.map((c) => csvCell(lead[c] ?? "")).join(","));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="leads${sellerFilter(req) ? `-${sellerFilter(req)}` : ""}.csv"`);
    res.send("﻿" + lines.join("\r\n") + "\r\n");
  });

  app.get("/admin/leads", requireAdmin, (req, res) => {
    const filter = sellerFilter(req);
    const name = (slug: string) => sellers.get(slug)?.config.name ?? slug;
    const rows = db
      .listLeads(500, filter)
      .map(
        (l) =>
          `<tr><td>${esc(new Date(l.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }))}</td><td>${esc(name(l.seller))}</td><td>${esc(l.name)}</td><td>${esc(l.mobile)}</td><td>${esc(l.product)}</td><td>${esc(l.requirements)}</td><td>${esc(l.quantity)}</td><td>${esc(l.city)}</td><td><a href="/admin/transcript/${encodeURIComponent(l.sessionId)}">chat</a></td></tr>`,
      )
      .join("");
    const options = [`<option value="">All sellers</option>`, ...sellers.list().map((s) => `<option value="${esc(s.config.slug)}"${s.config.slug === filter ? " selected" : ""}>${esc(s.config.name)}</option>`)].join("");
    res.send(
      adminPage(
        filter ? `Leads: ${esc(name(filter))}` : "Leads",
        `<p><a href="/admin">← Sellers</a></p><form method="get"><select name="seller" onchange="this.form.submit()">${options}</select> <a href="/admin/leads.csv${filter ? `?seller=${encodeURIComponent(filter)}` : ""}">Download CSV</a></form><br><table><thead><tr><th>When (IST)</th><th>Seller</th><th>Name</th><th>Mobile</th><th>Product</th><th>Requirement</th><th>Qty</th><th>City</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="9">No leads yet.</td></tr>'}</tbody></table>`,
      ),
    );
  });

  app.get("/admin/transcript/:sessionId", requireAdmin, (req, res) => {
    const id = String(req.params.sessionId);
    const lines = db
      .transcript(id)
      .map((t) => `<div class="m ${t.role}"><b>${t.role === "buyer" ? "Buyer" : "Bot"}</b> <small>${esc(t.at)}${t.guardrails ? ` · corrected: ${esc(t.guardrails)}` : ""}</small><div>${esc(t.text)}</div></div>`)
      .join("");
    res.send(adminPage(`Chat ${esc(id)}`, `<p><a href="/admin/leads">← Leads</a></p>${lines || "<p>No messages.</p>"}`));
  });

  app.use(
    express.static(paths.public, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith("widget.js")) {
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Cache-Control", "public, max-age=300");
        }
      },
    }),
  );

  app.use((_req, res) => html(res, notFoundPage(), 404));

  return app;
}

/** Quotes a CSV cell and defuses spreadsheet formulas (a buyer could type "=HYPERLINK(...)"). */
export function csvCell(value: string): string {
  const v = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${v.replace(/"/g, '""')}"`;
}

const KB_UPLOAD_SCRIPT = `<script>
document.querySelectorAll("form.kb-upload").forEach(function (form) {
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var out = form.nextElementSibling;
    var file = form.querySelector("input[type=file]").files[0];
    var button = form.querySelector("button");
    if (!file) return;
    out.className = "kb-result";
    out.textContent = "Checking " + file.name + "…";
    button.disabled = true;
    file.text().then(function (text) {
      try { JSON.parse(text); } catch (err) { throw new Error("This file is not valid JSON: " + err.message); }
      return fetch("/admin/sellers/" + encodeURIComponent(form.getAttribute("data-slug")) + "/kb", { method: "POST", headers: { "Content-Type": "application/json" }, body: text, credentials: "same-origin" });
    }).then(function (res) {
      return res.json().catch(function () { return { ok: false, errors: ["Upload failed (HTTP " + res.status + ")"] }; });
    }).then(function (r) {
      out.innerHTML = "";
      var p = document.createElement("p");
      if (r.ok) {
        out.className = "kb-result ok";
        p.textContent = "Uploaded: " + r.summary.products + " products, " + r.summary.categories + " categories, " + r.summary.images + " photos, " + r.summary.videos + " videos, " + r.summary.documents + " PDFs. The bot uses it from the next message.";
      } else {
        out.className = "kb-result err";
        p.textContent = "Not uploaded. Fix these and try again:";
      }
      out.appendChild(p);
      var items = r.ok ? r.warnings : r.errors;
      if (items && items.length) {
        var ul = document.createElement("ul");
        items.slice(0, 20).forEach(function (m) { var li = document.createElement("li"); li.textContent = m; ul.appendChild(li); });
        out.appendChild(ul);
      }
      if (r.ok) setTimeout(function () { location.reload(); }, 2500);
    }).catch(function (err) {
      out.className = "kb-result err";
      out.textContent = err.message;
    }).then(function () { button.disabled = false; });
  });
});
</script>`;

function adminPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><link rel="icon" href="data:,"><title>${title}</title>
<style>body{font:14px system-ui,sans-serif;margin:16px;color:#1d2433;background:#fff}table{border-collapse:collapse;width:100%}th,td{border:1px solid #e3e8f0;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f5f7fb}.m{border:1px solid #e3e8f0;border-radius:8px;padding:8px;margin:6px 0;white-space:pre-wrap}.m.buyer{background:#eef4ff}small{color:#6b7588}textarea{box-sizing:border-box;width:100%;max-width:900px;font:14px/1.5 ui-monospace,Menlo,monospace;padding:8px;border:1px solid #cfd6e2;border-radius:6px}form.prompts label{display:block;margin-top:16px}form.prompts p{margin:4px 0}button{font:inherit;padding:6px 14px;cursor:pointer}.ok{background:#e9f7ef;border:1px solid #9bd3b0;padding:8px 10px;border-radius:6px}.err{background:#fdecec;border:1px solid #f0a8a8;padding:8px 10px;border-radius:6px}.kb-upload{margin-top:6px}.kb-result.ok,.kb-result.err{margin-top:6px;font-size:13px}.kb-result ul{margin:4px 0 0;padding-left:18px}button.link{background:none;border:0;padding:0;color:#0b5cad;text-decoration:underline;cursor:pointer;font:inherit}pre{white-space:pre-wrap;background:#f5f7fb;border:1px solid #e3e8f0;padding:10px;border-radius:6px;max-height:480px;overflow:auto}</style>
</head><body><h1>${title}</h1>${body}</body></html>`;
}
