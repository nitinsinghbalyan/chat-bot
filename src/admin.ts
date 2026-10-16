/**
 * Team-only admin pages (HTTP Basic auth, any username, ADMIN_PASSWORD): sellers, adding a seller
 * from a KB JSON, knowledge base uploads, crawls, brand personas, the common prompts, leads and
 * chat transcripts.
 */
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { ChatDb, PromptVersion, SellerPersona } from "./db.js";
import { diffLines } from "./diff.js";
import { activeVersionId, COMMON_SCOPE, newerBuiltIn, recordVersion, sellerScope } from "./promptVersions.js";
import { defaultSystemTemplate, REQUIRED_PLACEHOLDERS, sharedGuardrails, validateSystemTemplate } from "./prompts.js";
import { SELLER_KB_TEMPLATE, validateSellerKb } from "./sellerKb.js";
import { FAQ_LIMIT_BYTES, parseFaq, type FaqStore } from "./faq.js";
import { isSellerFileKind, SELLER_FILES, type SellerFileKind } from "./sellerFiles.js";
import { parseSellerFile, sellerConfigSchema, SLUG_RE, type SellerContext, type SellerRegistry } from "./sellers.js";
import { esc } from "./site/html.js";
import { langfuseSessionUrl, type ConnectionTest, type TracingStatus } from "./tracing.js";

/** Maximum characters for each brand persona prompt. */
export const PERSONA_LIMITS = { system: 4000, user: 2000 } as const;

export interface AdminDeps {
  sellers: SellerRegistry;
  db: ChatDb;
  adminPassword?: string;
  recrawl?: (seller: SellerContext) => Promise<void>;
  /** True when `url` points at this server (same host as the request). */
  sameHost: (req: Request, url: string | undefined) => boolean;
  /** Langfuse status, shown on the dashboard when traces are not getting through. */
  tracing?: TracingStatus;
  /** Runs the "Test Langfuse" check (see Tracing.testConnection). */
  testTracing?: () => Promise<ConnectionTest>;
  /** The common FAQ (Excel), managed on /admin/prompts. */
  faq?: FaqStore;
}

/** Quotes a CSV cell and defuses spreadsheet formulas (a buyer could type "=HYPERLINK(...)"). */
export function csvCell(value: string): string {
  const v = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${v.replace(/"/g, '""')}"`;
}

/** "14 Oct 2026, 12:48 pm IST". */
export function fmtIST(value: string | Date | null | undefined): string {
  if (!value) return "never";
  const d = typeof value === "string" ? new Date(value) : value;
  if (isNaN(d.getTime())) return "never";
  return `${d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true })} IST`;
}

/** "5 min ago", "3 h ago", "2 days ago". */
export function ago(value: string | Date | null | undefined): string {
  if (!value) return "";
  const d = typeof value === "string" ? new Date(value) : value;
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (isNaN(mins)) return "";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

type Nav = "sellers" | "leads" | "prompts" | "";

function shell(title: string, body: string, active: Nav = ""): string {
  const link = (key: Nav, href: string, label: string) => `<a href="${href}"${active === key ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><link rel="icon" href="data:,"><title>${esc(title)} · Admin</title><link rel="stylesheet" href="/admin.css"></head>
<body>
<header class="bar"><div class="wrap bar-row"><a class="logo" href="/admin">Seller assistants <span>Admin</span></a><nav aria-label="Admin">${link("sellers", "/admin", "Sellers")}${link("leads", "/admin/leads", "Leads")}${link("prompts", "/admin/prompts", "Common prompts")}<a href="/" target="_blank" rel="noopener">Public site ↗</a></nav></div></header>
<main class="wrap">${body}</main>
</body></html>`;
}

const badge = (text: string, tone: "ok" | "warn" | "err" | "info" | "" = "", title?: string) =>
  `<span class="badge ${tone}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`;

const plural = (n: number, word: string, pl = `${word}s`) => `${n.toLocaleString("en-IN")} ${n === 1 ? word : pl}`;

/** Opens the seller row named in the URL (after an add, upload or crawl) and filters rows by name or slug. */
const ROWS_SCRIPT = `<script>
(function () {
  var q = new URLSearchParams(location.search);
  var slug = q.get("added") || q.get("kb") || q.get("crawl") || (location.hash.indexOf("#seller-") === 0 ? location.hash.slice(8) : "");
  var row = slug && document.getElementById("seller-" + slug);
  if (row) { row.open = true; row.scrollIntoView({ block: "start" }); }
  var f = document.getElementById("seller-filter");
  if (!f) return;
  f.addEventListener("input", function () {
    var t = f.value.trim().toLowerCase(), shown = 0;
    document.querySelectorAll(".srow").forEach(function (r) {
      var hit = !t || r.getAttribute("data-search").indexOf(t) !== -1;
      r.hidden = !hit;
      if (hit) shown++;
    });
    document.querySelector(".empty-filter").hidden = shown > 0;
  });
})();
</script>`;

/** Upload script shared by the seller rows (replace a KB) and the Add seller page. */
const DROPZONE_SCRIPT = `<script>
(function () {
  function list(out, items, label) {
    if (!items || !items.length) return;
    var wrap = document.createElement(label ? "details" : "div");
    if (label) { var s = document.createElement("summary"); s.textContent = label; wrap.appendChild(s); }
    var ul = document.createElement("ul");
    items.slice(0, 25).forEach(function (m) { var li = document.createElement("li"); li.textContent = m; ul.appendChild(li); });
    wrap.appendChild(ul);
    out.appendChild(wrap);
  }
  /** Notes about records the importer repaired or skipped (not the standing guardrail note). */
  window.fixCount = function (warnings) {
    return (warnings || []).filter(function (w) { return /generated|skipped|ignored|used twice/.test(w); }).length;
  };
  window.isLarge = function (warnings) {
    return (warnings || []).some(function (w) { return /^Large catalogue/.test(w); });
  };
  window.adminShow = function (out, kind, text, items, itemsLabel) {
    out.className = "dz-result " + kind;
    out.textContent = text;
    list(out, items, itemsLabel);
  };
  document.querySelectorAll(".dropzone").forEach(function (zone) {
    var input = zone.querySelector("input[type=file]");
    ["dragenter", "dragover"].forEach(function (t) { zone.addEventListener(t, function (e) { e.preventDefault(); zone.classList.add("drag"); }); });
    ["dragleave", "drop"].forEach(function (t) { zone.addEventListener(t, function () { zone.classList.remove("drag"); }); });
    zone.addEventListener("drop", function (e) {
      e.preventDefault();
      if (e.dataTransfer.files[0]) zone.dispatchEvent(new CustomEvent("file", { detail: e.dataTransfer.files[0] }));
    });
    input.addEventListener("change", function () { if (input.files[0]) zone.dispatchEvent(new CustomEvent("file", { detail: input.files[0] })); });
  });
  // Extra files and the FAQ: text, JSON or binary bodies; the server answers {ok, summary, warnings} or {ok:false, errors}.
  document.querySelectorAll(".dropzone[data-file-upload]").forEach(function (zone) {
    var out = zone.parentNode.querySelector(".dz-result");
    var format = zone.getAttribute("data-format");
    zone.addEventListener("file", function (e) {
      var file = e.detail;
      adminShow(out, "busy", "Checking " + file.name + "…");
      (format === "binary" ? file.arrayBuffer() : file.text()).then(function (body) {
        if (format === "json") { try { JSON.parse(body); } catch (err) { throw new Error("This file is not valid JSON: " + err.message); } }
        var type = format === "binary" ? "application/octet-stream" : format === "json" ? "application/json" : "text/plain";
        return fetch(zone.getAttribute("data-file-upload"), { method: "POST", headers: { "Content-Type": type }, body: body, credentials: "same-origin" });
      }).then(function (res) {
        return res.json().catch(function () { return { ok: false, errors: ["Upload failed (HTTP " + res.status + ")"] }; });
      }).then(function (r) {
        if (r.ok) {
          adminShow(out, "ok", "✓ Uploaded: " + r.summary + ". Live from the next chat message.", r.warnings, "Notes");
          setTimeout(function () {
            var u = new URL(zone.getAttribute("data-done"), location.href);
            if (u.pathname === location.pathname && u.search === location.search) { location.hash = u.hash; location.reload(); } else location.href = u.href;
          }, r.warnings && r.warnings.length ? 6000 : 1800);
        } else adminShow(out, "err", "Not uploaded. Fix these and try again:", r.errors);
      }).catch(function (err) { adminShow(out, "err", err.message); });
    });
  });
  document.querySelectorAll(".dropzone[data-upload]").forEach(function (zone) {
    var out = zone.parentNode.querySelector(".dz-result");
    zone.addEventListener("file", function (e) {
      var file = e.detail;
      adminShow(out, "busy", "Checking " + file.name + "…");
      file.text().then(function (text) {
        try { JSON.parse(text); } catch (err) { throw new Error("This file is not valid JSON: " + err.message); }
        return fetch(zone.getAttribute("data-upload"), { method: "POST", headers: { "Content-Type": "application/json" }, body: text, credentials: "same-origin" });
      }).then(function (res) {
        return res.json().catch(function () { return { ok: false, errors: ["Upload failed (HTTP " + res.status + ")"] }; });
      }).then(function (r) {
        if (r.ok) {
          var fixed = fixCount(r.warnings), large = isLarge(r.warnings);
          adminShow(out, "ok", "✓ Uploaded: " + r.summary.products + " products, " + r.summary.categories + " categories, " + r.summary.images + " photos, " + r.summary.videos + " videos, " + r.summary.documents + " PDFs. Live from the next chat message." + (fixed ? " " + fixed + " record" + (fixed === 1 ? " was" : "s were") + " fixed or skipped: see Notes." : "") + (large ? " Large catalogue: see Notes." : ""), r.warnings, "Notes");
          setTimeout(function () { location.href = "/admin?kb=" + encodeURIComponent(zone.getAttribute("data-slug")) + "#seller-" + zone.getAttribute("data-slug"); }, fixed || large ? 6000 : 1800);
        } else adminShow(out, "err", "Not uploaded. Fix these and try again:", r.errors);
      }).catch(function (err) { adminShow(out, "err", err.message); });
    });
  });
})();
</script>`;

/** The Langfuse panel on the dashboard: status, the latest upload, a Test Langfuse button and its last result. */
function tracingNote(t: TracingStatus | undefined, canTest: boolean): string {
  if (!t) return "";
  if (t.state === "off") return `<p class="muted small">Langfuse tracing is off: add LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY on Render to turn it on.</p>`;
  const button = canTest
    ? `<form class="inline" method="post" action="/admin/tracing/test"><button class="btn small" type="submit" onclick="this.disabled=true;this.textContent='Testing… (up to 30s)';this.form.submit()">Test Langfuse</button></form>`
    : "";
  const uploads = t.lastExportAt
    ? `Last upload ${t.lastExportOk ? "OK" : "failed"} at ${esc(fmtIST(t.lastExportAt))} · ${t.exports} upload${t.exports === 1 ? "" : "s"}, ${t.spansExported.toLocaleString("en-IN")} span${t.spansExported === 1 ? "" : "s"}${t.exportErrors ? `, ${t.exportErrors} failed` : ""} since the last deploy.`
    : "No uploads since the last deploy yet (one is sent within a few seconds of a chat message).";
  const where = `${esc(t.host ?? "")}${t.version ? `, Langfuse ${esc(t.version)}` : ""}`;
  let head: string;
  if (t.state === "auth_failed") head = `<div class="flash err"><b>Langfuse traces are not being recorded.</b> ${esc(t.message)}</div>`;
  else if (t.exportErrors && !t.lastExportOk) head = `<div class="flash warn"><b>Trace uploads to Langfuse are failing</b> (${where}). Last error: ${esc(t.lastExportError ?? "unknown")}</div>`;
  else if (t.state === "unreachable" || /no OpenTelemetry endpoint/.test(t.message)) head = `<div class="flash warn">${esc(t.message)}</div>`;
  else head = "";
  const test = t.lastTest ? testResult(t.lastTest) : "";
  return `${head}<div class="tracing-note" id="tracing"><p class="muted small">Langfuse tracing is on (${where}). ${uploads}</p>${button}</div>${test}`;
}

function testResult(r: ConnectionTest): string {
  const icon = (ok: boolean | null) => (ok === true ? "✓" : ok === false ? "✗" : "–");
  return `<div class="flash ${r.ok ? "ok" : "warn"} tracing-test"><b>Langfuse test, ${esc(fmtIST(r.at))}:</b> ${esc(r.verdict)}
<ul>${r.steps.map((s) => `<li><span class="step-${s.ok === true ? "ok" : s.ok === false ? "bad" : "na"}">${icon(s.ok)}</span> <b>${esc(s.label)}</b>: ${esc(s.detail)}</li>`).join("")}</ul>
${r.traceUrl ? `<a class="btn small" href="${esc(r.traceUrl)}" target="_blank" rel="noopener">Open the test trace in Langfuse ↗</a>` : ""}</div>`;
}

export function mountAdmin(app: Express, d: AdminDeps) {
  const { sellers, db, adminPassword } = d;

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
    if (!d.sameHost(req, req.headers.origin ?? req.headers.referer)) {
      res.status(403).send("Cross-site request blocked");
      return;
    }
    next();
  }

  const sellerParam = (req: Request) => sellers.get(String(req.params.seller));
  const sellerFilter = (req: Request): string | undefined => {
    const s = typeof req.query.seller === "string" ? req.query.seller : undefined;
    return s && sellers.get(s) ? s : undefined;
  };
  const notFound = (res: Response) => res.status(404).send(shell("Not found", `<div class="panel empty">Not found. <a href="/admin">Back to sellers</a></div>`));

  /** Writes a file atomically so a crash mid-write never leaves half a file on the disk. */
  function writeAtomic(file: string, data: string | Buffer) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  }

  // ---- Sellers ----

  function crawlBadge(s: SellerContext): string {
    const c = s.lastCrawl;
    if (!c) return badge(s.crawled.length ? "Crawl: not run since restart" : "Crawl: not run yet", "", s.crawledAt ? `Last good crawl ${fmtIST(s.crawledAt)}` : undefined);
    if (c.status === "ok") return badge("Crawl OK", "ok", `${c.message} · ${fmtIST(c.at)}`);
    if (c.status === "partial") return badge("Crawl partial", "warn", `${c.message} · ${fmtIST(c.at)}`);
    return badge("Crawl failed", "err", `${c.message} · ${fmtIST(c.at)}`);
  }

  function personaState(s: SellerContext): { label: string; tone: "ok" | "info" | ""; text: string } {
    const saved = db.getPrompts(s.config.slug);
    if (saved.system || saved.user) return { label: "Persona: custom", tone: "ok", text: saved.system || saved.user };
    if (s.defaultPersona.system || s.defaultPersona.user) return { label: "Persona: default", tone: "info", text: s.defaultPersona.system || s.defaultPersona.user };
    return { label: "No persona", tone: "", text: "" };
  }

  const fileCount = (s: SellerContext) => Object.keys(s.files).length;
  const FILE_KEY: Record<SellerFileKind, keyof SellerContext["files"]> = { "business-card": "businessCard", mcat: "mcat", "product-cards": "productCards" };

  /** The Extra files block: business card (.md), MCAT specifications and product cards, each optional. */
  function extraFilesBlock(s: SellerContext): string {
    const slug = esc(s.config.slug);
    const hints: Record<SellerFileKind, string> = {
      "business-card": "Added to the business card the bot uses. GST, bank, turnover, staff, ratings, prices and terms are left out.",
      mcat: "Spec questions (ISQs) for categories and product cards that have none, from the MCATs that match this seller.",
      "product-cards": s.uploaded ? "Added to the products from the knowledge base JSON." : "Replaces the KB folder's product_cards.json.",
    };
    const items = (Object.keys(SELLER_FILES) as SellerFileKind[]).map((kind) => {
      const meta = SELLER_FILES[kind];
      const f = s.files[FILE_KEY[kind]];
      const base = `/admin/sellers/${slug}/files/${kind}`;
      const status = f ? `${esc(f.summary)} · uploaded ${esc(ago(f.uploadedAt))}` : "Not uploaded";
      let use = "";
      if (kind === "mcat" && f) {
        const u = s.mcatUse;
        use = u.matched.length
          ? `Matches this seller: ${esc(u.matched.slice(0, 8).join(", "))}${u.matched.length > 8 ? ` and ${u.matched.length - 8} more` : ""}.${u.filled.length ? ` ISQs added to: ${esc(u.filled.slice(0, 8).join("; "))}${u.filled.length > 8 ? ` and ${u.filled.length - 8} more` : ""}.` : " Every matching category already has its own ISQs."}`
          : "No MCAT in the file matches what this seller deals in.";
      }
      const notes = f?.warnings.length ? `<details class="notes"><summary>Notes</summary><ul>${f.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></details>` : "";
      return `<div class="xfile">
  <div class="row"><p><b>${esc(meta.label)}</b><br><span class="muted small">${status}</span></p>
  <div class="btn-row">${f ? `<a class="btn small" href="${base}">Download</a><form class="inline" method="post" action="${base}/delete" onsubmit="return confirm('Remove this file? The bot stops using it from the next message.')"><button class="btn small" type="submit">Remove</button></form>` : ""}</div></div>
  ${use ? `<p class="use">${use}</p>` : ""}<p class="hint">${hints[kind]}</p>${notes}
  <div class="dropzone small" data-file-upload="${base}" data-format="${meta.format}" data-done="/admin?kb=${slug}#seller-${slug}">
    <input type="file" accept="${meta.accept}" aria-label="${f ? "Replace" : "Upload"} the ${esc(meta.label.toLowerCase())} for ${esc(s.config.name)}">
    <div class="dz-text">Drop a file or <b>choose one</b> to ${f ? "replace" : "upload"}</div>
  </div>
  <div class="dz-result" aria-live="polite"></div>
</div>`;
    });
    return `<section class="block files"><h3>Extra files <span class="muted small">(optional)</span></h3>${items.join("")}</section>`;
  }

  function sellerRow(s: SellerContext, leads: number): string {
    const slug = esc(s.config.slug);
    const u = s.uploaded;
    const persona = personaState(s);
    const products = s.catalogue.list("product").length;
    const categories = s.catalogue.list("category").length;
    const fromKb = u ? u.view.catalogueEntries().length : 0;
    const crawl = s.lastCrawl;
    const kbBlock = `<section class="block">
  <h3>Knowledge base</h3>
  <div class="row">
    <p>${u ? `JSON uploaded ${esc(ago(u.uploadedAt))} <span class="muted small">(${esc(fmtIST(u.uploadedAt))})</span>` : `Using the KB folder files <span class="muted small">(${plural(s.fileKb.productCards.length, "product card")})</span>`}</p>
    <div class="btn-row">${u ? `<a class="btn small" href="/admin/sellers/${slug}/kb.json">Download</a>` : ""}${
      u && s.source === "repo"
        ? `<form class="inline" method="post" action="/admin/sellers/${slug}/kb/delete" onsubmit="return confirm('Remove the uploaded knowledge base? The bot goes back to the KB folder files.')"><button class="btn small" type="submit">Remove</button></form>`
        : ""
    }</div>
  </div>
  <div class="dropzone" data-upload="/admin/sellers/${slug}/kb" data-slug="${slug}">
    <input type="file" accept=".json,application/json" aria-label="${u ? "Replace" : "Upload"} the knowledge base JSON for ${esc(s.config.name)}">
    <div class="dz-text">Drop a JSON file here or <b>choose a file</b> to ${u ? "replace" : "upload"} the knowledge base</div>
  </div>
  <div class="dz-result" aria-live="polite"></div>
</section>`;
    const filesBlock = extraFilesBlock(s);
    const catalogueBlock = `<section class="block">
  <h3>Website catalogue</h3>
  <div class="row">
    <p>${plural(s.catalogue.size, "page")}${u ? ` <span class="muted small">· ${fromKb} from the JSON · ${s.crawled.length} crawled</span>` : ` <span class="muted small">· crawled ${esc(ago(s.crawledAt) || "never")}</span>`}</p>
    <form class="inline" method="post" action="/admin/sellers/${slug}/recrawl"><button class="btn small" type="submit"${d.recrawl && sellers.crawlUrls(s).length ? "" : " disabled"}>Re-crawl now</button></form>
  </div>
  <p class="muted small">${crawl ? `Last crawl ${esc(fmtIST(crawl.at))}: ${esc(crawl.message)}` : s.crawledAt ? `Last good crawl ${esc(fmtIST(s.crawledAt))}. Crawls run on start and every 24 hours.` : "Not crawled yet. Crawls run on start and every 24 hours."}</p>
</section>`;
    const personaBlock = `<section class="block">
  <h3>Brand persona</h3>
  <div class="row">
    <p class="muted small">${persona.text ? esc(persona.text.length > 160 ? `${persona.text.slice(0, 160)}…` : persona.text) : "No brand persona yet: the bot uses the common prompt only."}</p>
    <a class="btn small" href="/admin/sellers/${slug}/prompts">${persona.text ? "Edit" : "Set up"}</a>
  </div>
</section>`;
    const updated = u ? `JSON ${ago(u.uploadedAt)}` : s.crawledAt ? `Crawled ${ago(s.crawledAt)}` : "Not crawled";
    const updatedTitle = u ? fmtIST(u.uploadedAt) : s.crawledAt ? fmtIST(s.crawledAt) : "";
    return `<details class="srow" id="seller-${slug}" data-search="${esc(`${s.config.name} ${s.config.slug}`.toLowerCase())}">
  <summary>
    <div class="seller"><span class="avatar" style="--c:${esc(s.config.color)}">${esc(s.config.name.charAt(0).toUpperCase())}</span><div class="who"><h2>${esc(s.config.name)}</h2><div class="muted small">${slug} · ${s.source === "admin" ? "added in admin" : "KB folder in the repo"}</div></div></div>
    <div class="badges">${u ? badge("JSON knowledge base", "ok") : badge("KB folder files", "info")}${crawlBadge(s)}${badge(persona.label, persona.tone)}${fileCount(s) ? badge(`+${plural(fileCount(s), "file")}`, "info") : ""}</div>
    <div class="nums">
      <a class="num" href="/admin/leads?seller=${slug}" title="Leads"><b>${leads}</b><span>Leads</span></a>
      <span class="num"><b>${products}</b><span>Products</span></span>
      <span class="num"><b>${categories}</b><span>Categories</span></span>
    </div>
    <span class="updated muted small"${updatedTitle ? ` title="${esc(updatedTitle)}"` : ""}>${esc(updated)}</span>
    <div class="row-actions">
      <a class="btn small" href="/s/${slug}/" target="_blank" rel="noopener">View site ↗</a>
      <span class="btn small manage" aria-hidden="true">Manage <span class="chev">▾</span></span>
    </div>
  </summary>
  <div class="srow-body">
    <div class="stats">
      <a class="stat" href="/admin/leads?seller=${slug}"><b>${leads}</b><span>Leads</span></a>
      <div class="stat"><b>${products}</b><span>Products</span></div>
      <div class="stat"><b>${categories}</b><span>Categories</span></div>
      <div class="stat"><b>${u?.summary.images ?? "–"}</b><span>Photos</span></div>
      <div class="stat"><b>${u?.summary.videos ?? "–"}</b><span>Videos</span></div>
      <div class="stat"><b>${u?.summary.documents ?? "–"}</b><span>PDFs</span></div>
    </div>
    <div class="blocks">${kbBlock}${filesBlock}${catalogueBlock}${personaBlock}</div>
    ${
      s.source === "admin"
        ? `<footer class="srow-foot"><form class="inline" method="post" action="/admin/sellers/${slug}/delete" onsubmit="return confirm('Delete ${esc(s.config.name).replace(/'/g, "\\'")}? Its website and bot stop working. Leads and chats are kept.')"><button class="btn danger small" type="submit">Delete seller</button></form></footer>`
        : ""
    }
  </div>
</details>`;
  }

  app.get("/admin", requireAdmin, (req, res) => {
    const counts = db.leadCounts();
    const list = sellers.list();
    const totalLeads = Object.values(counts).reduce((a, b) => a + b, 0);
    const q = (k: string) => (typeof req.query[k] === "string" ? String(req.query[k]) : "");
    const flash = q("added")
      ? `<div class="flash ok">✓ ${esc(sellers.get(q("added"))?.config.name ?? q("added"))} was added. <a href="/s/${esc(q("added"))}/" target="_blank" rel="noopener">Open its website ↗</a></div>`
      : q("deleted")
        ? `<div class="flash ok">✓ ${esc(q("deleted"))} was deleted. Its leads and chats are kept.</div>`
        : q("kb")
          ? `<div class="flash ok">✓ The knowledge base for ${esc(sellers.get(q("kb"))?.config.name ?? q("kb"))} was updated.</div>`
          : q("crawl")
            ? `<div class="flash ok">Re-crawl started for ${esc(sellers.get(q("crawl"))?.config.name ?? q("crawl"))}. It takes a few minutes; refresh this page to see the result.</div>`
            : "";
    res.send(
      shell(
        "Sellers",
        `<div class="page-head"><div><h1>Sellers</h1><p class="muted">${plural(list.length, "seller")} · ${plural(totalLeads, "lead")}</p></div>
<div class="btn-row"><a class="btn" href="/admin/kb-template.json">Download JSON template</a><a class="btn primary" href="/admin/sellers/new">+ Add seller</a></div></div>
${flash}
${tracingNote(d.tracing, !!d.testTracing)}
${
  list.length
    ? `${list.length > 3 ? `<input id="seller-filter" class="filter" type="search" placeholder="Filter sellers by name or slug" aria-label="Filter sellers">` : ""}
<div class="srows">
  <div class="srows-head" aria-hidden="true"><span>Seller</span><span>Status</span><span>Totals</span><span>Updated</span><span></span></div>
  ${list.map((s) => sellerRow(s, counts[s.config.slug] ?? 0)).join("")}
</div>
<p class="muted small empty-filter" hidden>No seller matches that filter.</p>`
    : `<div class="panel empty">No sellers yet. <a href="/admin/sellers/new">Add the first one</a> by uploading its JSON.</div>`
}
<p class="note">The knowledge base JSON is the seller export (version 3.0: <code>seller</code>, <code>company_pages</code>, <code>photo_gallery</code>, <code>categories</code>, <code>products</code>). Prices, delivery and payment terms, turnover, staff numbers, year of establishment, GST, bank and rating details in it are never given to the bot. The website still shows listed starting prices.</p>
${DROPZONE_SCRIPT}${ROWS_SCRIPT}`,
        "sellers",
      ),
    );
  });

  // ---- Add a seller from a KB JSON ----

  app.get("/admin/sellers/new", requireAdmin, (_req, res) => {
    const taken = JSON.stringify(sellers.list().map((s) => s.config.slug));
    res.send(
      shell(
        "Add seller",
        `<div class="crumb"><a href="/admin">← Sellers</a></div>
<div class="page-head"><div><h1>Add a seller</h1><p class="muted">Upload the seller's knowledge base JSON. Their website, chat assistant and lead capture go live straight away; no deploy needed.</p></div></div>
<form class="panel" id="add-seller" novalidate>
  <div class="field">
    <label>1. Knowledge base JSON</label>
    <div class="dropzone" id="add-drop">
      <input type="file" accept=".json,application/json" aria-label="Seller knowledge base JSON">
      <div class="dz-text">Drop the seller's JSON here or <b>choose a file</b></div>
    </div>
    <div class="dz-result" id="add-file" aria-live="polite"></div>
    <span class="hint">Format: the seller export, version 3.0. <a href="/admin/kb-template.json">Download a template</a>.</span>
  </div>
  <fieldset id="details" disabled style="border:0;padding:0;margin:0">
    <div class="field"><label>2. Check the details</label><span class="hint">Filled in from the file; change anything you need.</span></div>
    <div class="grid-2">
      <div class="field"><label for="name">Display name</label><input type="text" id="name" required maxlength="120"></div>
      <div class="field"><label for="slug">Web address</label><input type="text" id="slug" required maxlength="60" pattern="[a-z0-9][a-z0-9-]*"><span class="hint" id="slug-hint">/s/<b>…</b>/ · lowercase letters, digits and dashes</span></div>
      <div class="field"><label for="siteUrl">Seller's website</label><input type="url" id="siteUrl" required placeholder="https://www.example.com/"></div>
      <div class="field"><label for="origins">Websites allowed to embed the chat</label><input type="text" id="origins" placeholder="https://www.example.com"><span class="hint">Comma-separated. The seller's own website goes here.</span></div>
      <div class="field"><label for="color">Brand colour</label><div class="btn-row"><input type="color" id="color" value="#0b5cad"><span class="hint">Used for the website header, buttons and chat.</span></div></div>
    </div>
    <div class="btn-row"><button class="btn primary" type="submit" id="create">Add seller</button><a class="btn" href="/admin">Cancel</a></div>
    <div class="dz-result" id="add-result" aria-live="polite"></div>
  </fieldset>
</form>
${DROPZONE_SCRIPT}
<script>
(function () {
  var taken = ${taken};
  var kb = null, slugEdited = false;
  var $ = function (id) { return document.getElementById(id); };
  function slugify(s) {
    return String(s || "").toLowerCase().replace(/\\b(private|pvt|limited|ltd|llp|inc)\\b\\.?/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  }
  function slugHint() {
    var v = $("slug").value, bad = !/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/.test(v), dup = taken.indexOf(v) >= 0;
    $("slug-hint").innerHTML = "";
    $("slug-hint").appendChild(document.createTextNode(dup ? "Already used by another seller; pick another." : bad ? "Use lowercase letters, digits and dashes." : "Website: /s/" + v + "/"));
    $("slug-hint").style.color = dup || bad ? "var(--err)" : "";
    return !dup && !bad;
  }
  $("slug").addEventListener("input", function () { slugEdited = true; slugHint(); });
  $("name").addEventListener("input", function () { if (!slugEdited) { $("slug").value = slugify($("name").value); slugHint(); } });
  $("add-drop").addEventListener("file", function (e) {
    var out = $("add-file");
    adminShow(out, "busy", "Reading " + e.detail.name + "…");
    e.detail.text().then(function (text) {
      try { kb = JSON.parse(text); } catch (err) { kb = null; throw new Error("This file is not valid JSON: " + err.message); }
      var s = kb && kb.seller || {};
      var products = Array.isArray(kb.products) ? kb.products.length : 0, cats = Array.isArray(kb.categories) ? kb.categories.length : 0;
      if (!s.company_name || !products) throw new Error("This doesn't look like a seller export: it needs seller.company_name and at least one product.");
      adminShow(out, "ok", "✓ " + e.detail.name + ": " + s.company_name + " · " + products + " products · " + cats + " categories");
      $("details").disabled = false;
      $("name").value = String(s.company_name).trim();
      if (!slugEdited) $("slug").value = slugify(s.company_name);
      slugHint();
      var site = String(s.website_url || "").trim();
      $("siteUrl").value = site;
      try { $("origins").value = site ? new URL(site).origin : ""; } catch (_) {}
      $("name").focus();
    }).catch(function (err) { $("details").disabled = true; adminShow(out, "err", err.message); });
  });
  $("add-seller").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!kb || !slugHint()) return;
    var out = $("add-result");
    var config = {
      name: $("name").value.trim(),
      slug: $("slug").value.trim(),
      siteUrl: $("siteUrl").value.trim(),
      color: $("color").value,
      allowedOrigins: $("origins").value.split(",").map(function (o) { return o.trim(); }).filter(Boolean),
    };
    $("create").disabled = true;
    adminShow(out, "busy", "Checking the knowledge base and creating the seller…");
    fetch("/admin/sellers", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ config: config, kb: kb }) })
      .then(function (res) { return res.json().catch(function () { return { ok: false, errors: ["Failed (HTTP " + res.status + ")"] }; }); })
      .then(function (r) {
        if (r.ok) {
          var fixed = fixCount(r.warnings), go = function () { location.href = "/admin?added=" + encodeURIComponent(r.slug) + "#seller-" + r.slug; };
          var large = isLarge(r.warnings);
          if (!fixed && !large) return go();
          adminShow(out, "ok", "✓ Added." + (fixed ? " " + fixed + " record" + (fixed === 1 ? " was" : "s were") + " fixed or skipped (see Notes)." : "") + (large ? " Large catalogue (see Notes)." : "") + " Opening the sellers page…", r.warnings, "Notes");
          out.querySelector("details").open = true;
          setTimeout(go, 6000);
        }
        else { adminShow(out, "err", "Not added. Fix these and try again:", r.errors); $("create").disabled = false; }
      })
      .catch(function (err) { adminShow(out, "err", err.message); $("create").disabled = false; });
  });
})();
</script>`,
        "sellers",
      ),
    );
  });

  app.post("/admin/tracing/test", requireAdmin, sameOriginPost, async (_req, res) => {
    if (!d.testTracing) {
      res.status(404).send("Not found");
      return;
    }
    // The result is kept on the tracing status, so the dashboard shows it after the redirect.
    await d.testTracing().catch((err) => console.error("[tracing] test failed", err));
    res.redirect(303, "/admin#tracing");
  });

  app.post("/admin/sellers", requireAdmin, sameOriginPost, express.json({ limit: "40mb" }), (req, res) => {
    const errors: string[] = [];
    const cfg = sellerConfigSchema.safeParse(req.body?.config);
    if (!cfg.success) for (const i of cfg.error.issues) errors.push(`${i.path.join(".") || "details"}: ${i.message}`);
    else if (!SLUG_RE.test(cfg.data.slug)) errors.push("slug: use lowercase letters, digits and dashes");
    else if (sellers.has(cfg.data.slug)) errors.push(`slug: "${cfg.data.slug}" is already used by another seller`);
    const kb = validateSellerKb(req.body?.kb);
    if (!kb.ok) errors.push(...kb.errors);
    if (errors.length || !cfg.success || !kb.ok) {
      res.status(400).json({ ok: false, errors });
      return;
    }
    const dir = path.join(sellers.dataRootDir(), cfg.data.slug);
    writeAtomic(path.join(dir, "seller_kb.json"), JSON.stringify(req.body.kb));
    writeAtomic(path.join(dir, "seller.json"), JSON.stringify(cfg.data, null, 2) + "\n");
    const s = sellers.addSeller(cfg.data, kb.kb);
    res.json({ ok: true, slug: s.config.slug, summary: kb.summary, warnings: kb.warnings });
  });

  app.post("/admin/sellers/:seller/delete", requireAdmin, sameOriginPost, (req, res) => {
    const s = sellerParam(req);
    if (!s || s.source !== "admin") {
      res.status(s ? 400 : 404).send(s ? "Only sellers added in admin can be deleted here; remove a repo seller's KB folder instead." : "Not found");
      return;
    }
    sellers.removeSeller(s.config.slug);
    fs.rmSync(s.dataDir, { recursive: true, force: true });
    res.redirect(303, `/admin?deleted=${encodeURIComponent(s.config.name)}`);
  });

  // ---- Extra files (per seller): business card .md, MCAT specifications, product cards ----

  const fileKind = (req: Request): SellerFileKind | null => (isSellerFileKind(String(req.params.kind)) ? (String(req.params.kind) as SellerFileKind) : null);

  app.post("/admin/sellers/:seller/files/:kind", requireAdmin, sameOriginPost, express.text({ type: "*/*", limit: "10mb" }), (req, res) => {
    const s = sellerParam(req);
    const kind = fileKind(req);
    if (!s || !kind) return void notFound(res);
    const raw = typeof req.body === "string" ? req.body : "";
    const r = parseSellerFile(kind, raw);
    if (!r.ok) {
      res.status(400).json({ ok: false, errors: r.errors });
      return;
    }
    writeAtomic(path.join(s.filesDir, SELLER_FILES[kind].file), raw);
    sellers.setSellerFile(s.config.slug, kind, { value: r.value, uploadedAt: new Date().toISOString(), summary: r.summary, warnings: r.warnings });
    let summary = r.summary;
    if (kind === "mcat") summary += s.mcatUse.matched.length ? `, ${s.mcatUse.matched.length} match${s.mcatUse.matched.length === 1 ? "es" : ""} this seller, ISQs added to ${plural(s.mcatUse.filled.length, "category or card", "categories or cards")}` : ", none match this seller";
    res.json({ ok: true, summary, warnings: r.warnings });
  });

  app.get("/admin/sellers/:seller/files/:kind", requireAdmin, (req, res) => {
    const s = sellerParam(req);
    const kind = fileKind(req);
    const file = s && kind ? path.join(s.filesDir, SELLER_FILES[kind].file) : "";
    if (!s || !kind || !fs.existsSync(file)) return void notFound(res);
    res.setHeader("Content-Disposition", `attachment; filename="${s.config.slug}-${SELLER_FILES[kind].file}"`);
    res.type(SELLER_FILES[kind].format === "json" ? "application/json" : "text/markdown").send(fs.readFileSync(file));
  });

  app.post("/admin/sellers/:seller/files/:kind/delete", requireAdmin, sameOriginPost, (req, res) => {
    const s = sellerParam(req);
    const kind = fileKind(req);
    if (!s || !kind) return void notFound(res);
    fs.rmSync(path.join(s.filesDir, SELLER_FILES[kind].file), { force: true });
    sellers.setSellerFile(s.config.slug, kind, null);
    res.redirect(303, `/admin?kb=${encodeURIComponent(s.config.slug)}#seller-${encodeURIComponent(s.config.slug)}`);
  });

  // ---- Common FAQ (Excel or CSV) ----

  app.post("/admin/faq", requireAdmin, sameOriginPost, express.raw({ type: "*/*", limit: FAQ_LIMIT_BYTES }), async (req, res) => {
    const faq = d.faq;
    if (!faq) return void notFound(res);
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const r = await parseFaq(buf);
    if (!r.ok) {
      res.status(400).json({ ok: false, errors: r.errors });
      return;
    }
    const format = r.format ?? "xlsx";
    writeAtomic(faq.pathFor(format), buf);
    fs.rmSync(faq.pathFor(format === "xlsx" ? "csv" : "xlsx"), { force: true });
    faq.set({ rows: r.value, uploadedAt: new Date().toISOString(), format, summary: r.summary, warnings: r.warnings });
    res.json({ ok: true, summary: r.summary, warnings: r.warnings });
  });

  app.get("/admin/faq.:format", requireAdmin, (req, res) => {
    const faq = d.faq;
    const format = req.params.format === "csv" ? "csv" : req.params.format === "xlsx" ? "xlsx" : null;
    if (!faq || !format || !fs.existsSync(faq.pathFor(format))) return void notFound(res);
    res.setHeader("Content-Disposition", `attachment; filename="common-faq.${format}"`);
    res.type(format === "csv" ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").send(fs.readFileSync(faq.pathFor(format)));
  });

  app.post("/admin/faq/delete", requireAdmin, sameOriginPost, (_req, res) => {
    const faq = d.faq;
    if (!faq) return void notFound(res);
    for (const f of ["xlsx", "csv"] as const) fs.rmSync(faq.pathFor(f), { force: true });
    faq.set(null);
    res.redirect(303, "/admin/prompts#faq");
  });

  /** The Common FAQ panel on /admin/prompts. */
  function faqPanel(): string {
    const faq = d.faq;
    if (!faq) return "";
    const f = faq.file;
    const perSeller = f
      ? sellers
          .list()
          .map((s) => `${esc(s.config.name)}: ${faq.forSeller(s.kb, { ...s.terms, mcats: s.mcatUse.matched }, s.config.name)?.size ?? 0}`)
          .join(" · ")
      : "";
    const preview = f
      ? `<details class="notes"><summary>First ${Math.min(10, f.rows.length)} of ${plural(f.rows.length, "row")}</summary><table class="faq-preview"><thead><tr><th>Question</th><th>Answer</th><th>Category</th></tr></thead><tbody>${f.rows
          .slice(0, 10)
          .map((r) => `<tr><td>${esc(r.question)}</td><td>${esc(r.answer)}</td><td>${esc(r.categories.join(", ") || "all sellers")}</td></tr>`)
          .join("")}</tbody></table></details>`
      : "";
    return `<section class="panel" id="faq">
<div class="row"><div><h2>Common FAQ (Excel)</h2><p class="muted small">One sheet for every seller with the columns <b>Question</b>, <b>Answer</b> and an optional <b>Category</b>. A row with a category is used only for sellers that deal in it; <code>{seller_name}</code> is filled in. The bot looks up the rows that match each buyer message; the guardrails still apply, and rows that state a price are left out.</p></div>
<div class="btn-row">${f ? `<a class="btn small" href="/admin/faq.${f.format}">Download</a><form class="inline" method="post" action="/admin/faq/delete" onsubmit="return confirm('Remove the common FAQ? The bot stops using it from the next message.')"><button class="btn small" type="submit">Remove</button></form>` : ""}</div></div>
<p>${f ? `${esc(f.summary)} · uploaded ${esc(ago(f.uploadedAt))} <span class="muted small">(${esc(fmtIST(f.uploadedAt))})</span>` : "No FAQ uploaded."}</p>
${perSeller ? `<p class="muted small">Rows used per seller: ${perSeller}</p>` : ""}
${f?.warnings.length ? `<details class="notes" open><summary>Notes</summary><ul>${f.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></details>` : ""}
${preview}
<div class="dropzone" data-file-upload="/admin/faq" data-format="binary" data-done="/admin/prompts#faq">
  <input type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" aria-label="${f ? "Replace" : "Upload"} the common FAQ">
  <div class="dz-text">Drop an Excel (.xlsx) or CSV file here or <b>choose a file</b> to ${f ? "replace" : "upload"} the FAQ</div>
</div>
<div class="dz-result" aria-live="polite"></div>
</section>`;
  }

  // ---- Knowledge base JSON (per seller) ----

  app.get("/admin/kb-template.json", requireAdmin, (_req, res) => {
    res.setHeader("Content-Disposition", 'attachment; filename="seller-kb-template.json"');
    res.json(SELLER_KB_TEMPLATE);
  });

  app.get("/admin/sellers/:seller/kb.json", requireAdmin, (req, res) => {
    const seller = sellerParam(req);
    if (!seller?.uploaded) {
      res.status(404).send("No uploaded knowledge base");
      return;
    }
    res.setHeader("Content-Disposition", `attachment; filename="${seller.config.slug}-kb.json"`);
    res.json(seller.uploaded.view.kb);
  });

  // Upload: the raw JSON is the request body (the /admin page reads the file and posts it).
  app.post("/admin/sellers/:seller/kb", requireAdmin, sameOriginPost, express.text({ type: "*/*", limit: "40mb" }), (req, res) => {
    const seller = sellerParam(req);
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
    writeAtomic(seller.uploadedKbFile, JSON.stringify(data));
    sellers.setUploadedKb(seller.config.slug, result.kb);
    res.json({ ok: true, summary: result.summary, warnings: result.warnings });
  });

  app.post("/admin/sellers/:seller/kb/delete", requireAdmin, sameOriginPost, (req, res) => {
    const seller = sellerParam(req);
    if (!seller) return void notFound(res);
    if (seller.source === "admin") {
      res.status(400).send("A seller added in admin needs its knowledge base; replace it instead, or delete the seller.");
      return;
    }
    fs.rmSync(seller.uploadedKbFile, { force: true });
    sellers.setUploadedKb(seller.config.slug, null);
    res.redirect(303, `/admin?kb=${encodeURIComponent(seller.config.slug)}#seller-${encodeURIComponent(seller.config.slug)}`);
  });

  app.post("/admin/sellers/:seller/recrawl", requireAdmin, sameOriginPost, (req, res) => {
    const seller = sellerParam(req);
    if (!seller || !d.recrawl) return void notFound(res);
    // Crawling takes minutes; run it in the background and show the result on /admin.
    void d.recrawl(seller);
    res.redirect(303, `/admin?crawl=${encodeURIComponent(seller.config.slug)}#seller-${encodeURIComponent(seller.config.slug)}`);
  });

  // ---- Brand persona prompts (per seller) ----

  function counterScript() {
    return `<script>document.querySelectorAll("textarea[data-count]").forEach(function (t) { var c = document.getElementById(t.getAttribute("data-count")); t.addEventListener("input", function () { c.textContent = t.value.length; }); });</script>`;
  }

  // ---- Prompt version history ----

  const SOURCE_LABEL: Record<PromptVersion["source"], [string, "ok" | "info" | "warn" | ""]> = {
    saved: ["Saved", ""],
    reset: ["Reset to default", "warn"],
    restored: ["Restored", "info"],
    "built-in": ["Built-in default", "info"],
  };
  const noteField = `<div class="field note-field"><label for="note">What changed? <span class="muted small">(optional, kept in the version history)</span></label><input type="text" id="note" name="note" maxlength="200" placeholder="e.g. shorter replies, ask mobile number first"></div>`;
  const versionLabel = (v: PromptVersion) => `v${v.number}`;

  /** The Versions panel: newest first, the one in use badged Active, each with View and Restore. */
  function versionsPanel(scope: string, current: { a: string; b: string }): string {
    const versions = db.listPromptVersions(scope);
    if (!versions.length) return "";
    const active = activeVersionId(versions, current.a, current.b);
    const rows = versions
      .map((v) => {
        const [label, tone] = SOURCE_LABEL[v.source];
        return `<tr${v.id === active ? ' class="active"' : ""}>
  <td><b>${versionLabel(v)}</b>${v.id === active ? ` ${badge("Active", "ok")}` : ""}</td>
  <td class="nowrap">${esc(fmtIST(v.createdAt))}</td>
  <td>${badge(label, tone)}</td>
  <td class="muted">${esc(v.note)}</td>
  <td class="nowrap actions"><a class="btn small" href="/admin/prompts/versions/${v.id}">View</a>${
    v.id === active
      ? ""
      : `<form class="inline" method="post" action="/admin/prompts/versions/${v.id}/restore" onsubmit="return confirm('Restore ${versionLabel(v)}? It becomes the prompt in use straight away.')"><button class="btn small" type="submit">Restore</button></form>`
  }</td>
</tr>`;
      })
      .join("");
    return `<section class="panel versions" id="versions"><h2>Versions</h2>
<p class="muted small">Every save, reset, restore and shipped default is kept (the newest 50). View compares a version with what's in use now.</p>
<div class="table-wrap"><table><thead><tr><th>Version</th><th>When</th><th>Type</th><th>Note</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  /** Changed lines with 2 lines of context; longer unchanged stretches fold into one "… N unchanged lines" row. */
  function diffHtml(lines: ReturnType<typeof diffLines>): string {
    const near = lines.map((_, i) => lines.slice(Math.max(0, i - 2), i + 3).some((l) => l.op !== "same"));
    const out: string[] = [];
    let skipped = 0;
    const flush = () => {
      if (skipped) out.push(`<span class="d skip">… ${skipped} unchanged line${skipped === 1 ? "" : "s"}</span>`);
      skipped = 0;
    };
    lines.forEach((l, i) => {
      if (!near[i]) return void skipped++;
      flush();
      out.push(`<span class="d ${l.op}">${l.op === "add" ? "+ " : l.op === "del" ? "− " : "  "}${esc(l.text) || " "}</span>`);
    });
    flush();
    return out.join("");
  }

  function diffBlock(title: string, from: string, to: string): string {
    if (from.trim() === to.trim()) return `<div class="field"><label>${esc(title)}</label><p class="muted small">Same as the version in use.</p></div>`;
    const lines = diffLines(to, from);
    const added = lines.filter((l) => l.op === "add").length;
    const removed = lines.filter((l) => l.op === "del").length;
    return `<div class="field"><label>${esc(title)} <span class="muted small">compared with the version in use: <span class="d-add">+${added}</span> <span class="d-del">−${removed}</span> lines</span></label>
<pre class="diff">${diffHtml(lines)}</pre></div>`;
  }

  /** Scope "seller:<slug>" → that seller (or null if it was deleted). */
  const sellerOfScope = (scope: string) => (scope.startsWith("seller:") ? (sellers.get(scope.slice(7)) ?? null) : null);

  function currentOf(scope: string): { a: string; b: string } | null {
    if (scope === COMMON_SCOPE) return { a: sellers.common.system, b: sellers.common.guardrails };
    const s = sellerOfScope(scope);
    return s ? { a: s.persona.system, b: s.persona.user } : null;
  }

  app.get("/admin/prompts/versions/:id", requireAdmin, (req, res) => {
    const v = db.getPromptVersion(Number(req.params.id));
    const current = v && currentOf(v.scope);
    if (!v || !current) return void notFound(res);
    const seller = sellerOfScope(v.scope);
    const labels = seller ? ["System prompt: brand persona", "User prompt: added to every buyer message"] : ["System prompt (common)", "Chat guardrails (common)"];
    const back = seller ? `/admin/sellers/${encodeURIComponent(seller.config.slug)}/prompts#versions` : "/admin/prompts#versions";
    const isActive = activeVersionId(db.listPromptVersions(v.scope), current.a, current.b) === v.id;
    const [label, tone] = SOURCE_LABEL[v.source];
    res.send(
      shell(
        `${versionLabel(v)}: ${seller ? seller.config.name : "Common prompts"}`,
        `<div class="crumb"><a href="${back}">← ${seller ? `Brand persona: ${esc(seller.config.name)}` : "Common prompts"}</a></div>
<div class="page-head"><div><h1>${versionLabel(v)} ${isActive ? badge("Active", "ok") : ""}</h1><p class="muted">${esc(seller ? `Brand persona for ${seller.config.name}` : "Common system prompt and guardrails")} · ${esc(fmtIST(v.createdAt))} · ${badge(label, tone)}${v.note ? ` · ${esc(v.note)}` : ""}</p></div>
${isActive ? "" : `<form method="post" action="/admin/prompts/versions/${v.id}/restore" onsubmit="return confirm('Restore ${versionLabel(v)}? It becomes the prompt in use straight away.')"><button class="btn primary" type="submit">Restore this version</button></form>`}</div>
<div class="panel">${diffBlock(labels[0], v.a, current.a)}${diffBlock(labels[1], v.b, current.b)}</div>
<details class="panel preview"><summary>Full text of ${versionLabel(v)}</summary><h3>${esc(labels[0])}</h3><pre>${esc(v.a) || "<i>(empty)</i>"}</pre><h3>${esc(labels[1])}</h3><pre>${esc(v.b) || "<i>(empty)</i>"}</pre></details>`,
        seller ? "sellers" : "prompts",
      ),
    );
  });

  app.post("/admin/prompts/versions/:id/restore", requireAdmin, sameOriginPost, (req, res) => {
    const v = db.getPromptVersion(Number(req.params.id));
    if (!v || !currentOf(v.scope)) return void notFound(res);
    const note = `Restored ${versionLabel(v)}`;
    if (v.scope === COMMON_SCOPE) {
      const errors = validateSystemTemplate(v.a);
      if (!v.b.trim()) errors.push("The guardrails must not be empty.");
      if (errors.length) {
        res.status(400).send(commonForm({ system: v.a, guardrails: v.b }, { errors }));
        return;
      }
      applyCommon(v.a, v.b.trim());
      recordVersion(db, COMMON_SCOPE, sellers.common.system, sellers.common.guardrails, "restored", note);
      res.redirect(303, `/admin/prompts?restored=${v.number}`);
      return;
    }
    const seller = sellerOfScope(v.scope)!;
    const values: SellerPersona = { system: v.a.trim(), user: v.b.trim() };
    const tooLong = (["system", "user"] as const).find((k) => values[k].length > PERSONA_LIMITS[k]);
    if (tooLong) {
      res.status(400).send(promptsForm(seller, values, { error: `The ${tooLong} prompt is too long to restore (${values[tooLong].length} of ${PERSONA_LIMITS[tooLong]} characters).` }));
      return;
    }
    applyPersona(seller, values);
    recordVersion(db, v.scope, seller.persona.system, seller.persona.user, "restored", note);
    res.redirect(303, `/admin/sellers/${encodeURIComponent(seller.config.slug)}/prompts?restored=${v.number}`);
  });

  /** Saves a persona; the seller's own default (persona.json) is stored as "no override". */
  function applyPersona(seller: SellerContext, values: SellerPersona) {
    const d = seller.defaultPersona;
    const isDefault = values.system === d.system.trim() && values.user === d.user.trim();
    db.savePrompts(seller.config.slug, isDefault ? { system: "", user: "" } : values);
    // Clearing (or saving both empty) goes back to the seller's default persona from persona.json.
    sellers.setPersona(seller.config.slug, isDefault || !(values.system || values.user) ? d : values);
  }

  /** Saves the common prompts, storing only what differs from the defaults so later edits to prompts/ still apply. */
  function applyCommon(system: string, guardrails: string) {
    db.setPlatformPrompt("system", system.trim() === defaultSystemTemplate().trim() ? null : system);
    db.setPlatformPrompt("guardrails", guardrails === sharedGuardrails() ? null : guardrails);
    sellers.setCommonPrompts({ system, guardrails });
  }

  function promptsForm(seller: SellerContext, values: SellerPersona, opts: { saved?: boolean; error?: string; restored?: string } = {}): string {
    const slug = esc(seller.config.slug);
    const updated = db.getPrompts(seller.config.slug).updatedAt;
    const box = (name: "system" | "user", label: string, help: string, placeholder: string, rows: number) => `
<div class="field">
  <label for="${name}">${label}</label>
  <span class="hint">${help}</span>
  <textarea id="${name}" name="${name}" rows="${rows}" maxlength="${PERSONA_LIMITS[name]}" placeholder="${esc(placeholder)}" data-count="${name}-count">${esc(values[name])}</textarea>
  <div class="counter"><span id="${name}-count">${values[name].length}</span> / ${PERSONA_LIMITS[name]} characters</div>
</div>`;
    const hasDefault = seller.defaultPersona.system || seller.defaultPersona.user;
    return shell(
      `Brand persona: ${seller.config.name}`,
      `<div class="crumb"><a href="/admin#seller-${slug}">← Sellers</a></div>
<div class="page-head"><div><h1>Brand persona</h1><p class="muted">${esc(seller.config.name)} · added on top of the <a href="/admin/prompts">common system prompt and guardrails</a>, which always win if anything conflicts.</p></div>
<a class="btn" href="/s/${slug}/" target="_blank" rel="noopener">View site ↗</a></div>
${opts.saved ? '<div class="flash ok">✓ Saved. New chat turns use these prompts straight away.</div>' : ""}
${opts.restored ? `<div class="flash ok">✓ Restored v${esc(opts.restored)}. New chat turns use it straight away.</div>` : ""}
${opts.error ? `<div class="flash err">${esc(opts.error)}</div>` : ""}
<form method="post" action="/admin/sellers/${slug}/prompts" class="panel">
${box(
  "system",
  "System prompt: brand persona",
  "Who the assistant is and how it should come across: its name, tone, greeting style, what to emphasise about the brand. Added to the system prompt once.",
  "Example: You are Jay, the friendly assistant for Jayshree Machinetools. Speak like an experienced machine-tool engineer: practical, confident and concise.",
  12,
)}
${box(
  "user",
  "User prompt: added to every buyer message",
  "A short standing instruction re-sent with each buyer message, for things the assistant must keep in mind on every reply.",
  "Example: Always ask which material and thickness the buyer works with before suggesting a machine.",
  5,
)}
${noteField}
<div class="btn-row"><button class="btn primary" type="submit">Save</button><button class="btn" type="submit" name="clear" value="1" onclick="return confirm('Reset both prompts to this seller\\'s default?')">Reset to default</button><span class="muted small">${updated ? `Last saved ${esc(fmtIST(updated))}` : hasDefault ? `Using the default from <code>persona.json</code>` : "Not saved yet"}</span></div>
</form>
${versionsPanel(sellerScope(seller.config.slug), { a: seller.persona.system, b: seller.persona.user })}
<details class="panel preview"><summary>Full system prompt preview (as the assistant sees it)</summary><pre>${esc(seller.systemPrompt)}</pre></details>
${counterScript()}`,
      "sellers",
    );
  }

  app.get("/admin/sellers/:seller/prompts", requireAdmin, (req, res) => {
    const seller = sellerParam(req);
    if (!seller) return void notFound(res);
    const restored = typeof req.query.restored === "string" && /^\d+$/.test(req.query.restored) ? req.query.restored : undefined;
    res.send(promptsForm(seller, seller.persona, { saved: req.query.saved === "1", restored }));
  });

  app.post("/admin/sellers/:seller/prompts", requireAdmin, sameOriginPost, express.urlencoded({ extended: false, limit: "64kb" }), (req, res) => {
    const seller = sellerParam(req);
    if (!seller) return void notFound(res);
    const clear = req.body?.clear === "1";
    const values: SellerPersona = clear
      ? { system: "", user: "" }
      : { system: String(req.body?.system ?? "").replace(/\r\n/g, "\n").trim(), user: String(req.body?.user ?? "").replace(/\r\n/g, "\n").trim() };
    const tooLong = (["system", "user"] as const).find((k) => values[k].length > PERSONA_LIMITS[k]);
    if (tooLong) {
      res.status(400).send(promptsForm(seller, values, { error: `The ${tooLong} prompt is too long (${values[tooLong].length} of ${PERSONA_LIMITS[tooLong]} characters).` }));
      return;
    }
    applyPersona(seller, values);
    recordVersion(db, sellerScope(seller.config.slug), seller.persona.system, seller.persona.user, clear ? "reset" : "saved", String(req.body?.note ?? "").trim());
    res.redirect(303, `/admin/sellers/${encodeURIComponent(seller.config.slug)}/prompts?saved=1`);
  });

  // ---- Common system prompt and guardrails (every seller) ----

  function commonForm(values: { system: string; guardrails: string }, opts: { saved?: boolean; errors?: string[]; restored?: string } = {}): string {
    const sys = db.getPlatformPrompt("system");
    const gr = db.getPlatformPrompt("guardrails");
    const own = sellers.list().filter((s) => s.ownGuardrails !== null);
    const preview = sellers.list()[0];
    return shell(
      "Common prompts",
      `<div class="page-head"><div><h1>Common system prompt and guardrails</h1><p class="muted">These apply to <b>${sellers.size === 1 ? "the 1 seller" : `all ${sellers.size} sellers`}</b>. Each seller adds its own knowledge base and brand persona on top.${own.length ? ` Sellers with their own <code>guardrails.md</code> keep it: ${own.map((s) => esc(s.config.name)).join(", ")}.` : ""}</p></div></div>
${opts.saved ? '<div class="flash ok">✓ Saved. Every seller uses these from the next chat turn.</div>' : ""}
${opts.restored ? `<div class="flash ok">✓ Restored v${esc(opts.restored)}. Every seller uses it from the next chat turn.</div>` : ""}
${builtInBanner()}
${opts.errors?.length ? `<div class="flash err">Not saved:<ul>${opts.errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : ""}
<form method="post" action="/admin/prompts" class="panel">
<div class="field">
  <label for="system">System prompt (common) ${badge(sys ? `edited ${fmtIST(sys.updatedAt)}` : "default: prompts/system.md", sys ? "info" : "")}</label>
  <span class="hint">Placeholders filled per seller: ${REQUIRED_PLACEHOLDERS.map((p) => `<code>{{${p}}}</code>`).join(" ")} (required) and <code>{{SELLER_NAME}}</code>.</span>
  <textarea id="system" name="system" rows="22">${esc(values.system)}</textarea>
</div>
<div class="field">
  <label for="guardrails">Chat guardrails (common) ${badge(gr ? `edited ${fmtIST(gr.updatedAt)}` : "default: prompts/guardrails.md", gr ? "info" : "")}</label>
  <span class="hint">Inserted at <code>{{GUARDRAILS}}</code>. Code-level checks (prices, freight, contacts, stock, payment and ID, delivery, GST) run on every reply whatever this text says.</span>
  <textarea id="guardrails" name="guardrails" rows="18">${esc(values.guardrails)}</textarea>
</div>
${noteField}
<div class="btn-row"><button class="btn primary" type="submit">Save for all sellers</button><button class="btn" type="submit" name="reset" value="1" onclick="return confirm('Reset both to the defaults in prompts/?')">Reset to defaults</button></div>
</form>
${versionsPanel(COMMON_SCOPE, { a: sellers.common.system, b: sellers.common.guardrails })}
${faqPanel()}
${DROPZONE_SCRIPT}
${preview ? `<details class="panel preview"><summary>Preview: full system prompt for ${esc(preview.config.name)}</summary><pre>${esc(preview.systemPrompt)}</pre></details>` : ""}`,
      "prompts",
    );
  }

  /** Shown when an edited common prompt is in use but a deploy has shipped a newer built-in default. */
  function builtInBanner(): string {
    const v = newerBuiltIn(db, sellers);
    if (!v) return "";
    return `<div class="flash warn"><b>A newer built-in prompt was deployed on ${esc(fmtIST(v.createdAt))}.</b> You're using an edited version, so the bot isn't using the new default yet.
<div class="btn-row" style="margin-top:8px"><a class="btn small" href="/admin/prompts/versions/${v.id}">Compare</a><form class="inline" method="post" action="/admin/prompts/versions/${v.id}/restore" onsubmit="return confirm('Use the new built-in prompt for all sellers? Your edited version stays in the history.')"><button class="btn small primary" type="submit">Use the new built-in</button></form></div></div>`;
  }

  app.get("/admin/prompts", requireAdmin, (req, res) => {
    const restored = typeof req.query.restored === "string" && /^\d+$/.test(req.query.restored) ? req.query.restored : undefined;
    res.send(commonForm(sellers.common, { saved: req.query.saved === "1", restored }));
  });

  app.post("/admin/prompts", requireAdmin, sameOriginPost, express.urlencoded({ extended: false, limit: "256kb" }), (req, res) => {
    if (req.body?.reset === "1") {
      db.setPlatformPrompt("system", null);
      db.setPlatformPrompt("guardrails", null);
      sellers.setCommonPrompts({ system: null, guardrails: null });
      recordVersion(db, COMMON_SCOPE, sellers.common.system, sellers.common.guardrails, "reset", String(req.body?.note ?? "").trim());
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
    applyCommon(system, guardrails);
    recordVersion(db, COMMON_SCOPE, sellers.common.system, sellers.common.guardrails, "saved", String(req.body?.note ?? "").trim());
    res.redirect(303, "/admin/prompts?saved=1");
  });

  // ---- Leads and transcripts ----

  app.get("/admin/leads.csv", requireAdmin, (req, res) => {
    const cols = ["createdAt", "seller", "name", "mobile", "product", "requirements", "quantity", "city", "pageUrl", "sessionId"] as const;
    const lines = [[...cols, "langfuseSession"].join(",")];
    for (const lead of db.listLeads(10_000, sellerFilter(req))) {
      lines.push([...cols.map((c) => csvCell(lead[c] ?? "")), csvCell(lead.chatId ? `${lead.seller}:${lead.chatId}` : "")].join(","));
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="leads${sellerFilter(req) ? `-${sellerFilter(req)}` : ""}.csv"`);
    res.send("﻿" + lines.join("\r\n") + "\r\n");
  });

  app.get("/admin/leads", requireAdmin, (req, res) => {
    const filter = sellerFilter(req);
    const name = (slug: string) => sellers.get(slug)?.config.name ?? slug;
    const leads = db.listLeads(500, filter);
    const rows = leads
      .map(
        (l) =>
          `<tr><td>${esc(fmtIST(l.createdAt))}</td><td>${esc(name(l.seller))}</td><td>${esc(l.name)}</td><td>${esc(l.mobile)}</td><td>${esc(l.product)}</td><td>${esc(l.requirements)}</td><td>${esc(l.quantity)}</td><td>${esc(l.city)}</td><td><a class="btn small" href="/admin/transcript/${encodeURIComponent(l.sessionId)}${l.chatId ? `?chat=${encodeURIComponent(l.chatId)}` : ""}">Chat</a>${sessionLink(l.chatId ? `${l.seller}:${l.chatId}` : null)}</td></tr>`,
      )
      .join("");
    const options = [`<option value="">All sellers</option>`, ...sellers.list().map((s) => `<option value="${esc(s.config.slug)}"${s.config.slug === filter ? " selected" : ""}>${esc(s.config.name)}</option>`)].join("");
    res.send(
      shell(
        filter ? `Leads: ${name(filter)}` : "Leads",
        `<div class="page-head"><div><h1>Leads</h1><p class="muted">${plural(leads.length, "verified lead")}${filter ? ` for ${esc(name(filter))}` : ""}, newest first</p></div></div>
<form method="get" class="toolbar"><select name="seller" aria-label="Seller" onchange="this.form.submit()">${options}</select><a class="btn" href="/admin/leads.csv${filter ? `?seller=${encodeURIComponent(filter)}` : ""}">Download CSV</a></form>
<div class="table-wrap">${
          rows
            ? `<table><thead><tr><th>When</th><th>Seller</th><th>Name</th><th>Mobile</th><th>Product</th><th>Requirement</th><th>Qty</th><th>City</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
            : '<div class="empty">No leads yet.</div>'
        }</div>`,
        "leads",
      ),
    );
  });

  /** A link to the chat's session in Langfuse, when tracing is on and the project is known. */
  function sessionLink(langfuseSession: string | null): string {
    const url = langfuseSession && d.tracing ? langfuseSessionUrl(d.tracing, langfuseSession) : null;
    return url ? ` <a class="btn small" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(langfuseSession!)}">Langfuse ↗</a>` : "";
  }

  app.get("/admin/transcript/:sessionId", requireAdmin, (req, res) => {
    const id = String(req.params.sessionId);
    const seller = sellers.get(id.split(":")[0]);
    const onlyChat = typeof req.query.chat === "string" ? req.query.chat : null;
    const all = db.transcript(id);
    const rows = onlyChat ? all.filter((t) => t.chatId === onlyChat) : all;
    // A browser's conversations, in order; each is one Langfuse session "<seller>:<chat id>".
    let lastChat: string | null | undefined;
    const lines = rows
      .map((t) => {
        let head = "";
        if (t.chatId !== lastChat) {
          lastChat = t.chatId;
          const lf = t.chatId ? `${id.split(":")[0]}:${t.chatId}` : null;
          head = `<div class="chat-head muted small">${lf ? `Conversation · Langfuse session <code>${esc(lf)}</code>${sessionLink(lf)}` : "Conversation (from before chat ids)"}</div>`;
        }
        return head + render(t);
      })
      .join("");
    function render(t: (typeof all)[number]) {
        const m = t.text.match(/\n\[Shared: (.*)\]$/s);
        const text = m ? t.text.slice(0, m.index) : t.text;
        const shared = m ? [...m[1].matchAll(/(\w+) "([^"]*)"/g)].map((x) => `<span>${esc(x[1])}: ${esc(x[2])}</span>`).join("") : "";
        return `<div class="msg ${t.role}"><div class="meta">${t.role === "buyer" ? "Buyer" : "Assistant"} · ${esc(fmtIST(t.at))}${t.guardrails ? ` · corrected: ${esc(t.guardrails)}` : ""}</div>${esc(text)}${shared ? `<div class="shared">${shared}</div>` : ""}</div>`;
    }
    res.send(
      shell(
        "Chat",
        `<div class="crumb"><a href="/admin/leads">← Leads</a></div><div class="page-head"><div><h1>Chat</h1><p class="muted">${seller ? `${esc(seller.config.name)} · ` : ""}<code>${esc(id)}</code></p></div></div>
<div class="chat">${lines || '<div class="panel empty">No messages.</div>'}</div>`,
        "leads",
      ),
    );
  });
}
