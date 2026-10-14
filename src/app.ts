import { createHash, randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import express, { type NextFunction, type Request, type Response } from "express";
import { runTurn, type TurnResult } from "./claude.js";
import { config, paths } from "./config.js";
import type { CatalogueEntry } from "./crawler.js";
import type { ChatDb } from "./db.js";
import { checkInput, RateLimiter } from "./guardrails.js";
import type { SellerContext, SellerRegistry } from "./sellers.js";
import type { Session, SessionStore } from "./session.js";
import { mountAdmin } from "./admin.js";
import { validateSystemTemplate } from "./prompts.js";
import { activeVersionId, COMMON_SCOPE, recordStartupVersions, sellerScope } from "./promptVersions.js";
import { maskMobile, noTracing, OTP_MASK, type Tracing } from "./tracing.js";
import { shareMedia } from "./shareMedia.js";
import type { EnquirySummary } from "./tools.js";
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
  /** Langfuse tracing (see src/tracing.ts); off by default. */
  tracing?: Tracing;
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function createApp(deps: AppDeps) {
  const { sellers, db, sessions } = deps;
  const tracing = deps.tracing ?? noTracing;
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

  // Version history: record shipped defaults that changed with this deploy, and older edits.
  recordStartupVersions(db, sellers);

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
      tracing: { state: tracing.status.state, host: tracing.status.host, exportErrors: tracing.status.exportErrors },
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
    res.json({ slug: c.slug, name: c.name, color: c.color, greeting: c.greeting ?? null, chips: c.chips ?? seller.kb.productCards.map((p) => p.canonical_name).slice(0, 4), position: c.widgetPosition, demo: true, feedback: tracing.enabled });
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

  /** Which prompt versions a seller's system prompt is built from, for trace metadata (recomputed only when it changes). */
  const promptInfoCache = new Map<string, { systemPrompt: string; info: Record<string, unknown> }>();
  function promptInfo(seller: SellerContext): Record<string, unknown> {
    const hit = promptInfoCache.get(seller.config.slug);
    if (hit?.systemPrompt === seller.systemPrompt) return hit.info;
    const version = (scope: string, a: string, b: string) => {
      const list = db.listPromptVersions(scope);
      const id = activeVersionId(list, a, b);
      return id ? `v${list.find((v) => v.id === id)!.number}` : null;
    };
    const info = {
      commonPrompt: version(COMMON_SCOPE, sellers.common.system, sellers.common.guardrails),
      persona: seller.persona.system || seller.persona.user ? version(sellerScope(seller.config.slug), seller.persona.system, seller.persona.user) : "none",
      knowledgeBase: seller.uploaded ? `JSON (${seller.uploaded.view.promptPlan().mode})` : "KB folder",
      systemPromptChars: seller.systemPrompt.length,
      ownGuardrails: seller.ownGuardrails !== null,
    };
    promptInfoCache.set(seller.config.slug, { systemPrompt: seller.systemPrompt, info });
    return info;
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
      const stageBefore = session.lead.stage;
      const traceCtx = {
        sessionId: session.id,
        userId: session.lead.mobile && session.lead.stage !== "otp_sent" ? maskMobile(session.lead.mobile) : undefined,
        tags: [slug, onPlatform ? "on-platform" : "embedded"],
        // While an OTP is expected, the buyer's message is the code.
        input: stageBefore === "otp_sent" ? OTP_MASK : input.text,
        metadata: { seller: slug, pageUrl: pageUrl ?? null, leadStageBefore: stageBefore, turn: session.turns + 1, prompt: promptInfo(seller), redacted: input.redacted },
      };
      const { result, traceId } = await tracing.trace("chat-turn", traceCtx, async (root) => {
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
            saveLead: (lead) => void (lead.update ? db.updateLead(lead.seller, lead.sessionId, lead) || db.insertLead(lead) : db.insertLead(lead)),
            logGuardrail: (id, interventions) => db.logGuardrailEvents(slug, id, interventions),
            trace: tracing,
          },
          { onText: (text) => send("text", { text }) },
          { pageUrl, pageEntry: pageEntryFor(seller, pageUrl) },
        );
        const chat = addChatUsage(session, result);
        root.update({
          output: {
            reply: result.text,
            chips: result.chips,
            cards: result.cards.map((c) => `${c.type}: ${c.title}`),
            askFor: result.askFor,
            ...(result.summary ? { summary: result.summary } : {}),
          },
          metadata: {
            leadStageAfter: session.lead.stage,
            usage: result.usage,
            turnCostUsd: roundUsd(result.costUsd),
            chatCostUsd: roundUsd(chat.costUsd),
            chatTokens: chatTokens(chat),
            chatTurns: chat.turns,
            ...(chat.costKnown ? {} : { costIncomplete: "a model without a known price was used" }),
          },
          ...(result.fallbackReply ? { level: "WARNING" as const, statusMessage: "Buyer got a canned fallback reply" } : {}),
        });
        if (tracing.enabled && root.traceId) {
          for (const e of result.leadEvents ?? []) tracing.score({ traceId: root.traceId, name: e === "captured" ? "lead_captured" : "lead_updated", value: 1, dataType: "BOOLEAN" });
          if (result.interventions.length) tracing.score({ traceId: root.traceId, name: "guardrail_fired", value: result.interventions.length, dataType: "NUMERIC" });
          if (result.fallbackReply) tracing.score({ traceId: root.traceId, name: "fallback_reply", value: 1, dataType: "BOOLEAN" });
          if (result.summary) tracing.score({ traceId: root.traceId, name: "summary_shown", value: 1, dataType: "BOOLEAN" });
        }
        if (tracing.enabled) {
          // One score per chat, replaced every message, so the Langfuse session shows the running total.
          tracing.score({
            sessionId: session.id,
            id: chatCostScoreId(session.id),
            name: "chat_cost_usd",
            value: roundUsd(chat.costUsd),
            dataType: "NUMERIC",
            comment: `${chat.turns} buyer message${chat.turns === 1 ? "" : "s"}, ${chatTokens(chat).toLocaleString("en-US")} tokens${chat.costKnown ? "" : " (some calls unpriced)"}`,
          });
        }
        return { result, traceId: root.traceId };
      });
      sessions.save(session);
      const sharedNote = result.cards.length ? `\n[Shared: ${result.cards.map((c) => `${c.type} "${c.title}"`).join(", ")}]` : "";
      const summaryNote = result.summary ? `\n[Summary: ${summaryLine(result.summary)}]` : "";
      db.appendTranscript({ seller: slug, sessionId: session.id, role: "bot", text: result.text + sharedNote + summaryNote, guardrails: result.interventions.map((i) => i.rule), traceId: traceId || undefined });
      if (traceId) send("trace", { traceId });
      if (result.cards.length) send("cards", { cards: result.cards });
      if (result.summary) send("summary", { summary: result.summary });
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

  /** Buyer feedback (👍 / 👎) on one bot reply, recorded as a Langfuse score on that reply's trace. */
  const feedbackLimiter = new RateLimiter(30, 60_000);
  app.post("/api/feedback", (req, res) => {
    if (!tracing.enabled) {
      res.status(404).json({ error: "Feedback is not enabled" });
      return;
    }
    const seller = typeof req.body?.seller === "string" ? sellers.get(req.body.seller) : undefined;
    const sessionId = typeof req.body?.sessionId === "string" && SESSION_ID_RE.test(req.body.sessionId) ? req.body.sessionId : null;
    const traceId = typeof req.body?.traceId === "string" && /^[0-9a-f]{32}$/.test(req.body.traceId) ? req.body.traceId : null;
    const value = req.body?.value === 1 || req.body?.value === -1 ? (req.body.value as 1 | -1) : null;
    if (!seller || !sessionId || !traceId || value === null) {
      res.status(400).json({ error: "Invalid feedback" });
      return;
    }
    if (!originAllowed(req, seller)) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }
    if (!feedbackLimiter.allow(req.ip ?? "unknown")) {
      res.status(429).json({ error: "Too many requests" });
      return;
    }
    // Buyers may only rate replies from their own chat.
    if (!db.hasTrace(`${seller.config.slug}:${sessionId}`, traceId)) {
      res.status(403).json({ error: "Unknown reply" });
      return;
    }
    // The same score id per reply, so changing a vote replaces it instead of adding another.
    tracing.score({ traceId, name: "buyer_feedback", value, dataType: "NUMERIC", id: `${traceId}-buyer-feedback` });
    res.sendStatus(204);
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

  // ---- Admin (team only) ----
  mountAdmin(app, { sellers, db, adminPassword, recrawl: deps.recrawl, sameHost, tracing: tracing.status });

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

/** Adds one turn's tokens and cost to the chat's running totals. */
function addChatUsage(session: Session, result: TurnResult) {
  const u = session.usage;
  u.input += result.usage.input;
  u.output += result.usage.output;
  u.cacheRead += result.usage.cacheRead;
  u.cacheWrite += result.usage.cacheWrite;
  u.costUsd += result.costUsd;
  u.turns++;
  if (!result.costKnown) u.costKnown = false;
  return u;
}

const roundUsd = (usd: number) => Math.round(usd * 1e6) / 1e6;
const chatTokens = (u: Session["usage"]) => u.input + u.output + u.cacheRead + u.cacheWrite;
/** A stable score id per chat, so each new value replaces the last. */
const chatCostScoreId = (sessionId: string) => `chat-cost-${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`;
const summaryLine = (s: EnquirySummary) => s.rows.map((r) => `${r.label}: ${r.value}`).join("; ");

export { csvCell, PERSONA_LIMITS } from "./admin.js";
