/**
 * Retrieval eval: how well the catalogue search and the server's product pick handle real buyer
 * text, measured on the sellers' own test cases. No model calls, no cost.
 *
 *   npm run retrieval:eval -- "<dir>" [--out report.json] [--misses 12]
 *
 * <dir> holds one folder per seller with the export (*_v5.json), the MCAT specs file
 * (mcat_specifications*.json), the test cases (*_Bot_Test_Cases.csv: Buyer_Input, Language) and
 * the scenarios (*_Scenarios.json: focus_product, suite). The files stay local: they hold GST and
 * bank details. A folder without test cases is listed and skipped.
 *
 * Each buyer input is treated as the first message of a new chat, exactly as runTurn does:
 * catalogue.search(text) → updateCategory(...). A case with a focus product counts as correct
 * when the top hit is that product: its MCAT has that name, or the focus words appear in the hit's
 * title, category or MCAT name. A case without one (out of scope, greeting) must not pick a product.
 */
import fs from "node:fs";
import path from "node:path";
import { Catalogue } from "../src/catalogue.js";
import type { CatalogueEntry } from "../src/crawler.js";
import { updateCategory, type IsqSource } from "../src/isqTracker.js";
import { parseMcatSpecs, type McatSpec } from "../src/sellerFiles.js";
import { KbView, validateSellerKb } from "../src/sellerKb.js";
import type { LeadState } from "../src/session.js";

interface Case {
  id: string;
  input: string;
  language: string;
  focus: string;
  suite: string;
}

interface CaseResult extends Case {
  hits: number;
  top: string | null;
  topMcat: string | null;
  topCorrect: boolean;
  anyCorrect: boolean;
  picked: string | null;
}

interface SellerReport {
  seller: string;
  cases: number;
  product: Tally;
  byLanguage: Record<string, Tally>;
  /** By the scenario suite (product_discovery describes a need without naming the product; spec_deep_dive names it). */
  bySuite: Record<string, Tally>;
  /** Cases that name no product: picks there are false, except on boundary suites where the buyer names a product the seller may sell. */
  other: { cases: number; falsePicks: number; boundaryPicks: number; withHits: number };
  misses: CaseResult[];
  falsePicks: CaseResult[];
  boundaryPicks: CaseResult[];
}

interface Tally {
  cases: number;
  withHits: number;
  topCorrect: number;
  anyCorrect: number;
  pickedCorrect: number;
  pickedWrong: number;
  notPicked: number;
}

const emptyTally = (): Tally => ({ cases: 0, withHits: 0, topCorrect: 0, anyCorrect: 0, pickedCorrect: 0, pickedWrong: 0, notPicked: 0 });

/** Words that don't tell products apart in a focus name ("Stainless Steel Mugs" → "mugs"). */
const GENERIC = new Set("machine machines service services stainless steel ss metal industrial heavy duty manual automatic semi electric hand new premium".split(" "));
const stem = (w: string) => w.replace(/(ses|xes|ches|shes)$/, "s").replace(/ies$/, "y").replace(/s$/, "").slice(0, 5);
const words = (t: string) => (t.toLowerCase().match(/[a-z]{3,}/g) ?? []).map(stem);
/** Distinctive words of a focus name, as stems; "bar" (3 letters) counts only beside a longer word. */
const keyWords = (t: string) => [...new Set((t.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !GENERIC.has(w)))];
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** "Cutlery (Spoons & Forks)" names three things; any one of them is the product. */
const alternatives = (focus: string) => focus.split(/\s*(?:&|\/|,|\(|\))\s*/).map((s) => s.trim()).filter(Boolean);
/** A scripted multi-turn case ("Turn 1: … -> Turn 2: …") is played as its first message, as a new chat sees it. */
const firstTurn = (t: string) => t.split(/\s*->\s*/)[0].replace(/^Turn\s*1\s*(?:\([^)]*\))?\s*:\s*/i, "").trim() || t.trim();
/** Suites whose cases name a product the seller may sell, so a pick there is often right, not a false pick. */
const BOUNDARY = new Set(["catalogue_boundary"]);

/** Minimal RFC 4180 reader: quoted fields may hold commas, quotes ("") and newlines. */
function readCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") row.push(field), (field = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) row.push(field), rows.push(row);
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ""])));
}

const find = (dir: string, re: RegExp) => fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f));
const numberOf = (id: string) => Number(/(\d+)/.exec(id)?.[1] ?? NaN);

function loadCases(dir: string): Case[] | null {
  const csv = find(dir, /_Bot_Test_Cases\.csv$/i)[0];
  if (!csv) return null;
  const rows = readCsv(fs.readFileSync(csv, "utf8"));
  const scenarioFile = find(dir, /_Scenarios\.json$/i)[0];
  const scenarios: Array<Record<string, unknown>> = scenarioFile ? JSON.parse(fs.readFileSync(scenarioFile, "utf8")) : [];
  const byNumber = new Map(scenarios.map((s) => [numberOf(String(s.scenario_id ?? "")), s]));
  return rows
    .filter((r) => r.Buyer_Input?.trim())
    .map((r) => {
      const s = byNumber.get(numberOf(r.Test_ID ?? ""));
      return {
        id: r.Test_ID ?? "",
        input: firstTurn(r.Buyer_Input),
        language: (r.Language || String(s?.language ?? "")).trim() || "unknown",
        focus: String(s?.focus_product ?? "").trim(),
        suite: String(s?.suite ?? r.Category_Name ?? "").trim(),
      };
    });
}

function evaluateSeller(dir: string, maxMisses: number): SellerReport | string {
  const seller = path.basename(dir);
  const kbFile = find(dir, /_v5\.json$/i)[0] ?? find(dir, /botpress.*\.json$/i)[0];
  if (!kbFile) return `${seller}: no export JSON`;
  const cases = loadCases(dir);
  if (!cases) return `${seller}: no test cases (*_Bot_Test_Cases.csv), skipped`;
  const parsed = validateSellerKb(JSON.parse(fs.readFileSync(kbFile, "utf8")));
  if (!parsed.ok) return `${seller}: export rejected: ${parsed.errors.join("; ")}`;
  let mcats: McatSpec[] = [];
  const mcatFile = find(dir, /^mcat_specifications.*\.json$/i)[0];
  if (mcatFile) {
    const m = parseMcatSpecs(JSON.parse(fs.readFileSync(mcatFile, "utf8")));
    if (m.ok) mcats = m.value;
  }
  const view = new KbView(parsed.kb, { mcats });
  const catalogue = new Catalogue(view.catalogueEntries());
  const mcatName = new Map(mcats.map((m) => [m.id, m.name]));
  const src: IsqSource = {
    plan: (category, mcatId) => {
      const c = view.categoryNamed(category);
      return c ? view.isqPlan(c, mcatId) : null;
    },
    locate: (e) => view.locateEntry(e),
    locateText: (text) => {
      const hit = catalogue.search(text, 1)[0];
      return hit ? view.locateEntry(hit) : null;
    },
  };

  const describe = (h: CatalogueEntry) => {
    const place = view.locateEntry(h);
    return { place, mcat: place?.mcatId ? (mcatName.get(place.mcatId) ?? null) : null };
  };
  // The top hit is the focus product when its MCAT has that name, or when at least half of one
  // alternative's distinctive words (one of them 4+ letters) appear in its title, category or MCAT name.
  const correct = (focus: string, h: CatalogueEntry): boolean => {
    const { mcat } = describe(h);
    if (mcat && norm(mcat) === norm(focus)) return true;
    const have = new Set(words(`${h.title} ${h.category} ${mcat ?? ""}`));
    return alternatives(focus).some((alt) => {
      const want = keyWords(alt);
      const shared = want.filter((w) => have.has(stem(w)));
      return want.length > 0 && shared.length >= Math.ceil(want.length / 2) && shared.some((w) => w.length >= 4);
    });
  };

  const report: SellerReport = { seller, cases: cases.length, product: emptyTally(), byLanguage: {}, bySuite: {}, other: { cases: 0, falsePicks: 0, boundaryPicks: 0, withHits: 0 }, misses: [], falsePicks: [], boundaryPicks: [] };
  for (const c of cases) {
    const hits = catalogue.search(c.input);
    const lead: LeadState = { stage: "none", otpAttempts: 0, otpSends: 0 };
    updateCategory(lead, src, { buyerText: c.input, hits, ownHits: hits.length > 0 });
    const top = hits[0];
    const r: CaseResult = {
      ...c,
      hits: hits.length,
      top: top ? top.title : null,
      topMcat: top ? describe(top).mcat : null,
      topCorrect: !!top && !!c.focus && correct(c.focus, top),
      anyCorrect: !!c.focus && hits.some((h) => correct(c.focus, h)),
      picked: lead.category ? `${lead.category}${lead.mcatId ? ` · ${mcatName.get(lead.mcatId) ?? lead.mcatId}` : ""}` : null,
    };
    if (!c.focus) {
      report.other.cases++;
      if (hits.length) report.other.withHits++;
      if (r.picked && BOUNDARY.has(c.suite)) report.other.boundaryPicks++, report.boundaryPicks.push(r);
      else if (r.picked) report.other.falsePicks++, report.falsePicks.push(r);
      continue;
    }
    for (const t of [report.product, (report.byLanguage[c.language] ??= emptyTally()), (report.bySuite[c.suite || "unknown"] ??= emptyTally())]) {
      t.cases++;
      if (hits.length) t.withHits++;
      if (r.topCorrect) t.topCorrect++;
      if (r.anyCorrect) t.anyCorrect++;
      if (r.picked && r.topCorrect) t.pickedCorrect++;
      else if (r.picked) t.pickedWrong++;
      else t.notPicked++;
    }
    if (!r.topCorrect) report.misses.push(r);
  }
  report.misses = report.misses.slice(0, maxMisses);
  return report;
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "–");
const cell = (s: string, w: number) => s.padEnd(w);

function printTally(label: string, t: Tally) {
  console.log(
    `  ${cell(label, 18)} ${cell(String(t.cases), 6)} ${cell(pct(t.withHits, t.cases), 7)} ${cell(pct(t.topCorrect, t.cases), 7)} ${cell(pct(t.anyCorrect, t.cases), 7)} ${cell(pct(t.pickedCorrect, t.cases), 8)} ${cell(pct(t.pickedWrong, t.cases), 8)} ${pct(t.notPicked, t.cases)}`,
  );
}

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? args[outIdx + 1] : null;
  const missIdx = args.indexOf("--misses");
  const maxMisses = missIdx >= 0 ? Number(args[missIdx + 1]) : 12;
  const dir = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--out" && args[i - 1] !== "--misses");
  if (!dir || !fs.existsSync(dir)) {
    console.error('Usage: npm run retrieval:eval -- "<dir with one folder per seller>" [--out report.json] [--misses N]');
    process.exit(1);
  }
  const sellerDirs = fs
    .readdirSync(dir)
    .map((f) => path.join(dir, f))
    .filter((p) => fs.statSync(p).isDirectory())
    .sort();
  const reports: SellerReport[] = [];
  const total = emptyTally();
  const byLanguage: Record<string, Tally> = {};
  const bySuite: Record<string, Tally> = {};
  let otherCases = 0;
  let otherFalse = 0;
  let otherBoundary = 0;
  for (const sd of sellerDirs) {
    const r = evaluateSeller(sd, maxMisses);
    if (typeof r === "string") {
      console.log(`\n${r}`);
      continue;
    }
    reports.push(r);
    console.log(`\n${r.seller}: ${r.cases} cases (${r.product.cases} name a product, ${r.other.cases} don't)`);
    console.log(`  ${cell("", 18)} ${cell("cases", 6)} ${cell("hits", 7)} ${cell("top1", 7)} ${cell("top4", 7)} ${cell("picked✓", 8)} ${cell("picked✗", 8)} no pick`);
    printTally("all", r.product);
    for (const [lang, t] of Object.entries(r.byLanguage).sort()) printTally(lang, t);
    for (const [suite, t] of Object.entries(r.bySuite).sort()) printTally(suite, t);
    console.log(
      `  no product named: ${r.other.cases} cases, ${r.other.withHits} with hits, ${r.other.falsePicks} false picks (${pct(r.other.falsePicks, r.other.cases - r.other.boundaryPicks)} of the non-boundary ones), ${r.other.boundaryPicks} boundary picks`,
    );
    for (const m of r.misses) console.log(`  ✗ [${m.language}] "${m.input}" → wanted ${m.focus}; got ${m.top ? `"${m.top}"${m.topMcat ? ` (${m.topMcat})` : ""}` : "no hit"}${m.picked ? `; picked ${m.picked}` : ""}`);
    for (const f of r.falsePicks) console.log(`  ! [${f.language}] "${f.input}" (${f.suite}) picked ${f.picked}`);
    for (const f of r.boundaryPicks) console.log(`  ? [${f.language}] "${f.input}" (${f.suite}) picked ${f.picked}`);
    for (const k of Object.keys(total) as Array<keyof Tally>) {
      total[k] += r.product[k];
      for (const [lang, t] of Object.entries(r.byLanguage)) (byLanguage[lang] ??= emptyTally())[k] += t[k];
      for (const [suite, t] of Object.entries(r.bySuite)) (bySuite[suite] ??= emptyTally())[k] += t[k];
    }
    otherCases += r.other.cases;
    otherFalse += r.other.falsePicks;
    otherBoundary += r.other.boundaryPicks;
  }
  if (reports.length > 1) {
    console.log(`\nAll ${reports.length} sellers`);
    console.log(`  ${cell("", 18)} ${cell("cases", 6)} ${cell("hits", 7)} ${cell("top1", 7)} ${cell("top4", 7)} ${cell("picked✓", 8)} ${cell("picked✗", 8)} no pick`);
    printTally("product", total);
    for (const [lang, t] of Object.entries(byLanguage).sort()) printTally(lang, t);
    for (const [suite, t] of Object.entries(bySuite).sort()) printTally(suite, t);
    console.log(`  no product named: ${otherCases} cases, ${otherFalse} false picks, ${otherBoundary} boundary picks`);
  }
  if (out) {
    fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), sellers: reports }, null, 2));
    console.log(`\nReport written to ${out}`);
  }
}

main();
