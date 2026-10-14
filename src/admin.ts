/**
 * Team-only admin pages (HTTP Basic auth, any username, ADMIN_PASSWORD): sellers, adding a seller
 * from a KB JSON, knowledge base uploads, crawls, brand personas, the common prompts, leads and
 * chat transcripts.
 */
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { ChatDb, SellerPersona } from "./db.js";
import { defaultSystemTemplate, REQUIRED_PLACEHOLDERS, sharedGuardrails, validateSystemTemplate } from "./prompts.js";
import { SELLER_KB_TEMPLATE, validateSellerKb } from "./sellerKb.js";
import { sellerConfigSchema, SLUG_RE, type SellerContext, type SellerRegistry } from "./sellers.js";
import { esc } from "./site/html.js";

/** Maximum characters for each brand persona prompt. */
export const PERSONA_LIMITS = { system: 4000, user: 2000 } as const;

export interface AdminDeps {
  sellers: SellerRegistry;
  db: ChatDb;
  adminPassword?: string;
  recrawl?: (seller: SellerContext) => Promise<void>;
  /** True when `url` points at this server (same host as the request). */
  sameHost: (req: Request, url: string | undefined) => boolean;
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

/** Upload script shared by the seller cards (replace a KB) and the Add seller page. */
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
          adminShow(out, "ok", "✓ Uploaded: " + r.summary.products + " products, " + r.summary.categories + " categories, " + r.summary.images + " photos, " + r.summary.videos + " videos, " + r.summary.documents + " PDFs. Live from the next chat message.", r.warnings, "Notes");
          setTimeout(function () { location.href = "/admin?kb=" + encodeURIComponent(zone.getAttribute("data-slug")) + "#seller-" + zone.getAttribute("data-slug"); }, 1800);
        } else adminShow(out, "err", "Not uploaded. Fix these and try again:", r.errors);
      }).catch(function (err) { adminShow(out, "err", err.message); });
    });
  });
})();
</script>`;

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
  function writeAtomic(file: string, data: string) {
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

  function sellerCard(s: SellerContext, leads: number): string {
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
    return `<article class="scard" id="seller-${slug}">
  <header class="scard-head">
    <span class="avatar" style="--c:${esc(s.config.color)}">${esc(s.config.name.charAt(0).toUpperCase())}</span>
    <div class="who"><h2>${esc(s.config.name)}</h2><div class="muted small">${slug} · ${s.source === "admin" ? "added in admin" : "KB folder in the repo"}</div></div>
    <a class="btn small" href="/s/${slug}/" target="_blank" rel="noopener">View site ↗</a>
  </header>
  <div class="badges">${u ? badge("JSON knowledge base", "ok") : badge("KB folder files", "info")}${crawlBadge(s)}${badge(persona.label, persona.tone)}</div>
  <div class="stats">
    <a class="stat" href="/admin/leads?seller=${slug}"><b>${leads}</b><span>Leads</span></a>
    <div class="stat"><b>${products}</b><span>Products</span></div>
    <div class="stat"><b>${categories}</b><span>Categories</span></div>
    <div class="stat"><b>${u?.summary.images ?? "–"}</b><span>Photos</span></div>
    <div class="stat"><b>${u?.summary.videos ?? "–"}</b><span>Videos</span></div>
    <div class="stat"><b>${u?.summary.documents ?? "–"}</b><span>PDFs</span></div>
  </div>
  <div class="blocks">${kbBlock}${catalogueBlock}${personaBlock}</div>
  ${
    s.source === "admin"
      ? `<footer class="scard-foot"><form class="inline" method="post" action="/admin/sellers/${slug}/delete" onsubmit="return confirm('Delete ${esc(s.config.name).replace(/'/g, "\\'")}? Its website and bot stop working. Leads and chats are kept.')"><button class="btn danger small" type="submit">Delete seller</button></form></footer>`
      : ""
  }
</article>`;
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
${list.length ? `<div class="cards">${list.map((s) => sellerCard(s, counts[s.config.slug] ?? 0)).join("")}</div>` : `<div class="panel empty">No sellers yet. <a href="/admin/sellers/new">Add the first one</a> by uploading its JSON.</div>`}
<p class="note">The knowledge base JSON is the seller export (version 3.0: <code>seller</code>, <code>company_pages</code>, <code>photo_gallery</code>, <code>categories</code>, <code>products</code>). Prices, delivery and payment terms, turnover, staff numbers, year of establishment, GST, bank and rating details in it are never given to the bot. The website still shows listed starting prices.</p>
${DROPZONE_SCRIPT}`,
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
        if (r.ok) location.href = "/admin?added=" + encodeURIComponent(r.slug) + "#seller-" + r.slug;
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

  app.post("/admin/sellers", requireAdmin, sameOriginPost, express.json({ limit: "12mb" }), (req, res) => {
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
  app.post("/admin/sellers/:seller/kb", requireAdmin, sameOriginPost, express.text({ type: "*/*", limit: "10mb" }), (req, res) => {
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

  function promptsForm(seller: SellerContext, values: SellerPersona, opts: { saved?: boolean; error?: string } = {}): string {
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
<div class="btn-row"><button class="btn primary" type="submit">Save</button><button class="btn" type="submit" name="clear" value="1" onclick="return confirm('Reset both prompts to this seller\\'s default?')">Reset to default</button><span class="muted small">${updated ? `Last saved ${esc(fmtIST(updated))}` : hasDefault ? `Using the default from <code>persona.json</code>` : "Not saved yet"}</span></div>
</form>
<details class="panel preview"><summary>Full system prompt preview (as the assistant sees it)</summary><pre>${esc(seller.systemPrompt)}</pre></details>
${counterScript()}`,
      "sellers",
    );
  }

  app.get("/admin/sellers/:seller/prompts", requireAdmin, (req, res) => {
    const seller = sellerParam(req);
    if (!seller) return void notFound(res);
    res.send(promptsForm(seller, seller.persona, { saved: req.query.saved === "1" }));
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
    db.savePrompts(seller.config.slug, values);
    // Clearing (or saving both empty) goes back to the seller's default persona from persona.json.
    sellers.setPersona(seller.config.slug, values.system || values.user ? values : seller.defaultPersona);
    res.redirect(303, `/admin/sellers/${encodeURIComponent(seller.config.slug)}/prompts?saved=1`);
  });

  // ---- Common system prompt and guardrails (every seller) ----

  function commonForm(values: { system: string; guardrails: string }, opts: { saved?: boolean; errors?: string[] } = {}): string {
    const sys = db.getPlatformPrompt("system");
    const gr = db.getPlatformPrompt("guardrails");
    const own = sellers.list().filter((s) => s.ownGuardrails !== null);
    const preview = sellers.list()[0];
    return shell(
      "Common prompts",
      `<div class="page-head"><div><h1>Common system prompt and guardrails</h1><p class="muted">These apply to <b>${sellers.size === 1 ? "the 1 seller" : `all ${sellers.size} sellers`}</b>. Each seller adds its own knowledge base and brand persona on top.${own.length ? ` Sellers with their own <code>guardrails.md</code> keep it: ${own.map((s) => esc(s.config.name)).join(", ")}.` : ""}</p></div></div>
${opts.saved ? '<div class="flash ok">✓ Saved. Every seller uses these from the next chat turn.</div>' : ""}
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
<div class="btn-row"><button class="btn primary" type="submit">Save for all sellers</button><button class="btn" type="submit" name="reset" value="1" onclick="return confirm('Reset both to the defaults in prompts/?')">Reset to defaults</button></div>
</form>
${preview ? `<details class="panel preview"><summary>Preview: full system prompt for ${esc(preview.config.name)}</summary><pre>${esc(preview.systemPrompt)}</pre></details>` : ""}`,
      "prompts",
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

  // ---- Leads and transcripts ----

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
    const leads = db.listLeads(500, filter);
    const rows = leads
      .map(
        (l) =>
          `<tr><td>${esc(fmtIST(l.createdAt))}</td><td>${esc(name(l.seller))}</td><td>${esc(l.name)}</td><td>${esc(l.mobile)}</td><td>${esc(l.product)}</td><td>${esc(l.requirements)}</td><td>${esc(l.quantity)}</td><td>${esc(l.city)}</td><td><a class="btn small" href="/admin/transcript/${encodeURIComponent(l.sessionId)}">Chat</a></td></tr>`,
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

  app.get("/admin/transcript/:sessionId", requireAdmin, (req, res) => {
    const id = String(req.params.sessionId);
    const seller = sellers.get(id.split(":")[0]);
    const lines = db
      .transcript(id)
      .map((t) => {
        const m = t.text.match(/\n\[Shared: (.*)\]$/s);
        const text = m ? t.text.slice(0, m.index) : t.text;
        const shared = m ? [...m[1].matchAll(/(\w+) "([^"]*)"/g)].map((x) => `<span>${esc(x[1])}: ${esc(x[2])}</span>`).join("") : "";
        return `<div class="msg ${t.role}"><div class="meta">${t.role === "buyer" ? "Buyer" : "Assistant"} · ${esc(fmtIST(t.at))}${t.guardrails ? ` · corrected: ${esc(t.guardrails)}` : ""}</div>${esc(text)}${shared ? `<div class="shared">${shared}</div>` : ""}</div>`;
      })
      .join("");
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
