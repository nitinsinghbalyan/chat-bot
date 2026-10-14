import { randomUUID, timingSafeEqual } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import express, { type NextFunction, type Request, type Response } from "express";
import { runTurn } from "./claude.js";
import { config, paths } from "./config.js";
import type { CatalogueEntry } from "./crawler.js";
import type { ChatDb, SellerPersona } from "./db.js";
import { checkInput, RateLimiter } from "./guardrails.js";
import type { SellerContext, SellerRegistry } from "./sellers.js";
import type { SessionStore } from "./session.js";
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

  // Brand personas saved in admin live in the database, so they survive restarts and redeploys.
  for (const s of sellers.list()) {
    const p = db.getPrompts(s.config.slug);
    if (p.system || p.user) sellers.setPersona(s.config.slug, p);
  }

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "16kb" }));

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
          saveLead: (lead) => db.insertLead(lead),
          logGuardrail: (id, interventions) => db.logGuardrailEvents(slug, id, interventions),
        },
        { onText: (text) => send("text", { text }) },
        { pageUrl, pageEntry: pageEntryFor(seller, pageUrl) },
      );
      sessions.save(session);
      db.appendTranscript({ seller: slug, sessionId: session.id, role: "bot", text: result.text, guardrails: result.interventions.map((i) => i.rule) });
      send("ui", { askFor: result.askFor, leadStage: session.lead.stage });
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
<td><a href="/admin/sellers/${esc(s.config.slug)}/prompts">${s.persona.system || s.persona.user ? "Edit" : "Set"} prompts</a></td>
<td><form method="post" action="/admin/sellers/${esc(s.config.slug)}/recrawl"><button${deps.recrawl ? "" : " disabled"}>Re-crawl now</button></form></td></tr>`;
      })
      .join("");
    res.send(
      adminPage(
        "Sellers",
        `<p><a href="/admin/leads">All leads</a> · <a href="/">Public directory</a></p><table><thead><tr><th>Seller</th><th>Leads</th><th>Catalogue</th><th>Last crawl</th><th>Brand persona</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="6">No sellers.</td></tr>'}</tbody></table>`,
      ),
    );
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
<p>These prompts are added on top of the built-in assistant. The 9 guardrails, the knowledge sources and the OTP enquiry steps always apply and win if anything here conflicts with them.</p>
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
<p><button type="submit">Save</button> <button type="submit" name="clear" value="1" onclick="return confirm('Clear both prompts for this seller?')">Clear</button>${updated ? ` <small>Last saved ${esc(new Date(updated).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }))} IST</small>` : ""}</p>
</form>
<details><summary>Full system prompt preview (as the assistant sees it)</summary><pre>${esc(seller.systemPrompt)}</pre></details>
<script>document.querySelectorAll("textarea[data-count]").forEach(function (t) { t.addEventListener("input", function () { document.getElementById(t.getAttribute("data-count")).textContent = t.value.length; }); });</script>`,
    );
  }

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
    sellers.setPersona(seller.config.slug, values);
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

function adminPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><link rel="icon" href="data:,"><title>${title}</title>
<style>body{font:14px system-ui,sans-serif;margin:16px;color:#1d2433;background:#fff}table{border-collapse:collapse;width:100%}th,td{border:1px solid #e3e8f0;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f5f7fb}.m{border:1px solid #e3e8f0;border-radius:8px;padding:8px;margin:6px 0;white-space:pre-wrap}.m.buyer{background:#eef4ff}small{color:#6b7588}textarea{box-sizing:border-box;width:100%;max-width:900px;font:14px/1.5 ui-monospace,Menlo,monospace;padding:8px;border:1px solid #cfd6e2;border-radius:6px}form.prompts label{display:block;margin-top:16px}form.prompts p{margin:4px 0}button{font:inherit;padding:6px 14px;cursor:pointer}.ok{background:#e9f7ef;border:1px solid #9bd3b0;padding:8px 10px;border-radius:6px}.err{background:#fdecec;border:1px solid #f0a8a8;padding:8px 10px;border-radius:6px}pre{white-space:pre-wrap;background:#f5f7fb;border:1px solid #e3e8f0;padding:10px;border-radius:6px;max-height:480px;overflow:auto}</style>
</head><body><h1>${title}</h1>${body}</body></html>`;
}
