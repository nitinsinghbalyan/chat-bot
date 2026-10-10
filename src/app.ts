import { randomUUID, timingSafeEqual } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Catalogue } from "./catalogue.js";
import { runTurn } from "./claude.js";
import { config, paths } from "./config.js";
import type { ChatDb } from "./db.js";
import { checkInput, RateLimiter } from "./guardrails.js";
import type { KnowledgeBase } from "./kb.js";
import type { SessionStore } from "./session.js";

export interface AppDeps {
  client: Anthropic;
  kb: KnowledgeBase;
  catalogue: Catalogue;
  systemPrompt: string;
  sessions: SessionStore;
  db: ChatDb;
  allowedOrigins?: string[];
  adminPassword?: string;
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function createApp(deps: AppDeps) {
  const { kb, catalogue, db, sessions } = deps;
  const allowedOrigins = deps.allowedOrigins ?? config.ALLOWED_ORIGINS;
  const adminPassword = deps.adminPassword ?? config.ADMIN_PASSWORD;

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
    if (allowedOrigins.includes(origin)) return true;
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
      // Store what the buyer typed after redaction, never the raw payment/ID details.
      db.appendTranscript({ sessionId, role: "buyer", text: input.text });
      const result = await runTurn(
        session,
        input.text,
        {
          client: deps.client,
          kb,
          catalogue,
          systemPrompt: deps.systemPrompt,
          saveLead: (lead) => db.insertLead(lead),
          logGuardrail: (id, interventions) => db.logGuardrailEvents(id, interventions),
        },
        { onText: (text) => send("text", { text }) },
        { pageUrl },
      );
      sessions.save(session);
      db.appendTranscript({ sessionId, role: "bot", text: result.text, guardrails: result.interventions.map((i) => i.rule) });
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

  // ---- Seller admin: leads and transcripts (HTTP Basic auth, any username) ----

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

  app.get("/admin/leads.csv", requireAdmin, (_req, res) => {
    const cols = ["createdAt", "name", "mobile", "product", "requirements", "quantity", "city", "pageUrl", "sessionId"] as const;
    const lines = [cols.join(",")];
    for (const lead of db.listLeads(10_000)) lines.push(cols.map((c) => csvCell(lead[c] ?? "")).join(","));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="leads.csv"');
    res.send("﻿" + lines.join("\r\n") + "\r\n");
  });

  app.get("/admin/leads", requireAdmin, (_req, res) => {
    const rows = db
      .listLeads()
      .map(
        (l) =>
          `<tr><td>${esc(new Date(l.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }))}</td><td>${esc(l.name)}</td><td>${esc(l.mobile)}</td><td>${esc(l.product)}</td><td>${esc(l.requirements)}</td><td>${esc(l.quantity)}</td><td>${esc(l.city)}</td><td><a href="/admin/transcript/${encodeURIComponent(l.sessionId)}">chat</a></td></tr>`,
      )
      .join("");
    res.send(
      adminPage(
        "Leads",
        `<p><a href="/admin/leads.csv">Download CSV</a></p><table><thead><tr><th>When (IST)</th><th>Name</th><th>Mobile</th><th>Machine</th><th>Requirement</th><th>Qty</th><th>City</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="8">No leads yet.</td></tr>'}</tbody></table>`,
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

  return app;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Quotes a CSV cell and defuses spreadsheet formulas (a buyer could type "=HYPERLINK(...)"). */
export function csvCell(value: string): string {
  const v = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${v.replace(/"/g, '""')}"`;
}

function adminPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>body{font:14px system-ui,sans-serif;margin:16px;color:#1d2433;background:#fff}table{border-collapse:collapse;width:100%}th,td{border:1px solid #e3e8f0;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f5f7fb}.m{border:1px solid #e3e8f0;border-radius:8px;padding:8px;margin:6px 0;white-space:pre-wrap}.m.buyer{background:#eef4ff}small{color:#6b7588}</style>
</head><body><h1>${title}</h1>${body}</body></html>`;
}
