import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import express, { type NextFunction, type Request, type Response } from "express";
import { Catalogue } from "./catalogue.js";
import { runTurn } from "./claude.js";
import { config, paths } from "./config.js";
import { refreshCatalogue } from "./crawler.js";
import { checkInput, RateLimiter } from "./guardrails.js";
import { loadKnowledgeBase } from "./kb.js";
import { renderSystemPrompt } from "./prompts.js";
import { SessionStore } from "./session.js";

const kb = loadKnowledgeBase();
const catalogue = Catalogue.fromDisk();
const systemPrompt = renderSystemPrompt(kb);
const sessions = new SessionStore();
const client = new Anthropic();

const perSession = new RateLimiter(15, 60_000);
const perIp = new RateLimiter(60, 60_000);
const busy = new Set<string>();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "16kb" }));

/** The bot's own pages (e.g. demo.html) are always allowed; other sites must be in ALLOWED_ORIGINS. */
function originAllowed(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (config.ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
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
  res.json({ ok: true, model: config.BOT_MODEL, catalogueEntries: catalogue.size, productCards: kb.productCards.length });
});

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

app.post("/api/chat", async (req, res) => {
  if (!originAllowed(req)) {
    res.status(403).json({ error: "Origin not allowed" });
    return;
  }
  const sessionId = typeof req.body?.sessionId === "string" && SESSION_ID_RE.test(req.body.sessionId) ? req.body.sessionId : randomUUID();
  const pageUrl = typeof req.body?.pageUrl === "string" ? req.body.pageUrl.slice(0, 300) : undefined;

  const input = checkInput(req.body?.message);
  if (!input.ok) {
    res.status(400).json({ error: input.error, sessionId });
    return;
  }
  if (!perIp.allow(req.ip ?? "unknown") || !perSession.allow(sessionId)) {
    res.status(429).json({ error: "You're sending messages too quickly. Please wait a moment.", sessionId });
    return;
  }
  if (busy.has(sessionId)) {
    res.status(409).json({ error: "Please wait for the previous reply to finish.", sessionId });
    return;
  }

  busy.add(sessionId);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  send("session", { sessionId });
  try {
    const session = sessions.get(sessionId);
    const result = await runTurn(session, input.text, { client, kb, catalogue, systemPrompt }, { onText: (text) => send("text", { text }) }, { pageUrl });
    send("ui", { askFor: result.askFor, leadStage: session.lead.stage });
    if (process.env.NODE_ENV !== "production") send("debug", { usage: result.usage, interventions: result.interventions.map((i) => i.rule) });
    send("done", {});
  } catch (err) {
    console.error(err);
    send("error", { error: "Something went wrong. Please try again." });
  } finally {
    busy.delete(sessionId);
    res.end();
  }
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

async function refresh() {
  try {
    const entries = await refreshCatalogue((m) => console.log(`[crawl] ${m}`));
    if (entries) catalogue.load(entries);
  } catch (err) {
    console.error("[crawl] failed", err);
  }
}

app.listen(config.PORT, () => {
  console.log(`Chatbot for ${kb.businessCard.name} on http://localhost:${config.PORT} (model ${config.BOT_MODEL}, ${catalogue.size} catalogue entries)`);
  if (catalogue.size === 0) console.warn("Catalogue is empty: run `npm run crawl` (needs access to the seller site) so prices and links can be shared.");
  if (config.CRAWL_ON_START) void refresh();
  if (config.CRAWL_INTERVAL_HOURS > 0) setInterval(() => void refresh(), config.CRAWL_INTERVAL_HOURS * 3_600_000).unref();
});
