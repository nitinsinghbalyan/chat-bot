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
 *
 *   --jev                       also run each case with Jev deciding the product (src/jev.ts, mode "on"),
 *                               and print both results. Needs JEV_API_KEY (or TYPESAFE_API_KEY); costs
 *                               ~$0.04 per million input tokens. JEV_MODEL / JEV_BASE_URL as on the server.
 *   --jev-min-confidence 0.5    the confidence Jev's choice needs to be used (the JEV_MIN_CONFIDENCE default)
 *   --jev-cache <file>          where Jev's answers are kept, so reruns are free (default <dir>/.jev-cache.json)
 *   --haiku                     also ask Claude (PICK_COMPARE_MODEL, default claude-haiku-5-5) the same question with
 *                               the same options in the same order, and score it the same way. Needs ANTHROPIC_API_KEY;
 *                               about $0.0002 per case. Answers are kept in <dir>/.haiku-pick-cache.json (--haiku-cache).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Catalogue } from "../src/catalogue.js";
import type { CatalogueEntry } from "../src/crawler.js";
import { updateCategory, type IsqSource, type Place } from "../src/isqTracker.js";
import { parseMcatSpecs, parseProductCards, type McatSpec } from "../src/sellerFiles.js";
import { CardIndex, planFor } from "../src/cardQuestions.js";
import { mapCard } from "../src/mapping.js";
import { KbView, validateSellerKb } from "../src/sellerKb.js";
import type { LeadState } from "../src/session.js";
import { numberOf, readCsv } from "./lib/csv.js";
import { alternatives, keyWords, namesFocus, stem, words } from "./lib/productMatch.js";
import Anthropic from "@anthropic-ai/sdk";
import { JevClient, pickProduct, productCandidates, type PickInput, type SystemOneCaller, type SystemOneRequest, type SystemOneResult } from "../src/jev.js";
import { ClaudeProductPicker, type ModelPick } from "../src/productPick.js";
import { costDetails } from "../src/tracing.js";

/** One product pick in the eval, whoever made it. */
interface PickRecord {
  decision: Place | "keep" | null;
  reason: string;
  error?: string;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** A product picker for the eval (Jev, or Claude asked the same question), with its answers so far. */
interface PickerRun {
  label: string;
  model: string;
  ask(input: PickInput, seedText: string): Promise<PickRecord>;
  picks: PickRecord[];
}

function jevRun(caller: SystemOneCaller, minConfidence: number): PickerRun {
  return {
    label: `Jev at confidence ≥ ${minConfidence}`,
    model: caller.model,
    picks: [],
    async ask(input, seedText) {
      const p = await pickProduct(caller, input, { minConfidence, rng: seeded(seedText) });
      const u = { input: p.inputTokens ?? 0, output: p.outputTokens ?? 0, cacheRead: 0, cacheWrite: 0 };
      return { decision: p.decision, reason: p.reason, error: p.error, ms: p.ms, inputTokens: u.input, outputTokens: u.output, costUsd: costDetails(caller.model, u)?.total ?? 0 };
    },
  };
}

/** Claude asked Jev's question; answers kept on disk by question, so reruns cost nothing. */
function claudeRun(picker: ClaudeProductPicker, file: string): PickerRun {
  const cache: Record<string, ModelPick> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  return {
    label: `${picker.model} asked the same question`,
    model: picker.model,
    picks: [],
    async ask(input, seedText) {
      const key = crypto
        .createHash("sha256")
        .update(JSON.stringify({ model: picker.model, seedText, text: input.buyerText, current: input.current?.label ?? null, options: input.candidates.map((c) => c.key) }))
        .digest("hex");
      let p = cache[key];
      if (!p || p.error) {
        p = await picker.pick(input, seeded(seedText));
        if (!p.error) (cache[key] = p), fs.writeFileSync(file, JSON.stringify(cache));
      }
      const u = p.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      return { decision: p.decision, reason: p.reason, error: p.error, ms: p.ms, inputTokens: u.input + u.cacheRead + u.cacheWrite, outputTokens: u.output, costUsd: costDetails(p.model, u)?.total ?? 0 };
    },
  };
}

/** Keeps Jev's answers on disk by request, so a rerun (or a threshold sweep) costs nothing. */
class CachedCaller implements SystemOneCaller {
  readonly model: string;
  private cache: Record<string, SystemOneResult>;
  constructor(private readonly inner: SystemOneCaller, private readonly file: string) {
    this.model = inner.model;
    this.cache = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  }
  async systemOne(req: SystemOneRequest): Promise<SystemOneResult> {
    const key = crypto.createHash("sha256").update(JSON.stringify(req)).digest("hex");
    const hit = this.cache[key];
    if (hit?.ok) return hit;
    const r = await this.inner.systemOne(req);
    if (r.ok) (this.cache[key] = r), fs.writeFileSync(this.file, JSON.stringify(this.cache));
    return r;
  }
}

/** A repeatable shuffle per case (Jev leans to the first option, so the order must not favour the right one). */
function seeded(text: string): () => number {
  let a = crypto.createHash("md5").update(text).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
  /** A product card was found for the buyer's product (its must-ask specs become the questions). */
  card: number;
  pickedWrong: number;
  notPicked: number;
}

const emptyTally = (): Tally => ({ cases: 0, withHits: 0, topCorrect: 0, anyCorrect: 0, pickedCorrect: 0, card: 0, pickedWrong: 0, notPicked: 0 });

/** A scripted multi-turn case ("Turn 1: … -> Turn 2: …") is played as its first message, as a new chat sees it. */
const firstTurn = (t: string) => t.split(/\s*->\s*/)[0].replace(/^Turn\s*1\s*(?:\([^)]*\))?\s*:\s*/i, "").trim() || t.trim();
/** Suites whose cases name a product the seller may sell, so a pick there is often right, not a false pick. */
const BOUNDARY = new Set(["catalogue_boundary"]);

const find = (dir: string, re: RegExp) => fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f));

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

async function evaluateSeller(dir: string, maxMisses: number, picker?: PickerRun): Promise<SellerReport | string> {
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
  // The product cards, found the same way as in a chat (src/app.ts isqSourceFor).
  const cardsFile = find(dir, /^product_cards\.json$/i)[0];
  const parsedCards = cardsFile ? parseProductCards(JSON.parse(fs.readFileSync(cardsFile, "utf8"))) : null;
  const cardList = parsedCards?.ok ? parsedCards.value : [];
  const cards = cardList.length ? new CardIndex(cardList, new Map(cardList.map((c) => [c.product_id, (({ category, mcat }) => ({ category, mcatId: mcat?.id ?? null }))(mapCard(c, view, mcats))]))) : null;
  const locate = (e: CatalogueEntry): Place | null => {
    const p = view.locateEntry(e);
    return p ? { ...p, cardId: cards?.forProduct(e.kind === "product" ? e.title : "", p.category, p.mcatId) ?? null } : null;
  };
  const locateCard = (text: string): Place | null => {
    const id = cards?.forText(text);
    if (!id) return null;
    const at = cards!.place(id);
    return { category: at?.category ?? "", mcatId: at?.mcatId ?? null, cardId: id, named: cards!.coreWordsIn(id, text) };
  };
  const src: IsqSource = {
    plan: (category, mcatId, cardId) => planFor(view, cards, category, mcatId, cardId),
    locate,
    locateText: (text) => {
      const hit = catalogue.search(text, 1)[0];
      return (hit ? locate(hit) : null) ?? locateCard(text);
    },
    locateCard,
    places: (() => {
      let all: Array<{ place: Place; title: string }> | null = null;
      return () => {
        if (all) return all;
        const seen = new Set<string>();
        all = [];
        for (const e of view.catalogueEntries()) {
          const p = e.kind === "product" ? locate(e) : null;
          const k = p ? `${p.category}|${p.mcatId ?? ""}|${p.cardId ?? ""}` : "";
          if (p && !seen.has(k)) seen.add(k), all.push({ place: p, title: e.title });
        }
        return all;
      };
    })(),
  };

  const describe = (h: CatalogueEntry) => {
    const place = view.locateEntry(h);
    return { place, mcat: place?.mcatId ? (mcatName.get(place.mcatId) ?? null) : null };
  };
  // The top hit is the focus product when its MCAT has that name, or when at least half of one
  // alternative's distinctive words (one of them 4+ letters) appear in its title, category or MCAT name.
  const correct = (focus: string, h: CatalogueEntry): boolean => namesFocus(focus, `${h.title} ${h.category}`, describe(h).mcat);

  const report: SellerReport = { seller, cases: cases.length, product: emptyTally(), byLanguage: {}, bySuite: {}, other: { cases: 0, falsePicks: 0, boundaryPicks: 0, withHits: 0 }, misses: [], falsePicks: [], boundaryPicks: [] };
  for (const c of cases) {
    const hits = catalogue.search(c.input);
    const lead: LeadState = { stage: "captured", otpAttempts: 0, otpSends: 1 };
    let decided: Place | "keep" | undefined;
    if (picker) {
      // As runTurn does on a chat's first product message: the same candidates, the picker's decision when it is sure.
      const candidates = productCandidates(hits, src, c.input);
      if (candidates.length) {
        const pick = await picker.ask({ buyerText: c.input, candidates }, `${seller}:${c.id}:${c.input}`);
        picker.picks.push(pick);
        decided = pick.decision ?? undefined;
      }
    }
    updateCategory(lead, src, { buyerText: c.input, hits, ownHits: hits.length > 0, decided });
    const top = hits[0];
    const r: CaseResult = {
      ...c,
      hits: hits.length,
      top: top ? top.title : null,
      topMcat: top ? describe(top).mcat : null,
      topCorrect: !!top && !!c.focus && correct(c.focus, top),
      anyCorrect: !!c.focus && hits.some((h) => correct(c.focus, h)),
      picked: lead.category || lead.cardId ? `${lead.category ?? ""}${lead.mcatId ? ` · ${mcatName.get(lead.mcatId) ?? lead.mcatId}` : ""}${lead.cardId ? ` [card ${cards?.get(lead.cardId)?.canonical_name}]` : ""}` : null,
    };
    const pickedCard = cards?.get(lead.cardId);
    const topPlace = top ? locate(top) : null;
    const pickIsTop = !!topPlace && topPlace.category === (lead.category ?? "") && (topPlace.mcatId ?? null) === (lead.mcatId ?? null);
    // A card counts as right when its name or aliases name the focus product.
    const cardRight = !!pickedCard && !!c.focus && alternatives(c.focus).some((alt) => {
      const want = keyWords(alt);
      const have = new Set(words([pickedCard.canonical_name, ...(pickedCard.aliases ?? []), ...(pickedCard.flow.categories ?? [])].join(" ")));
      return want.length > 0 && want.filter((w) => have.has(stem(w))).length >= Math.ceil(want.length / 2);
    });
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
      if (pickedCard) t.card++;
      // With a card, the questions are the card's: judge the card. Without one, the catalogue's pick: the top
      // hit when the pick is its place; else (Jev chose another of the seller's products) the picked category's name.
      if (r.picked && (pickedCard ? cardRight || r.topCorrect && cards?.forProduct(top?.title ?? "", null, null) === lead.cardId : pickIsTop ? r.topCorrect : namesFocus(c.focus, lead.category ?? "", lead.mcatId ? (mcatName.get(lead.mcatId) ?? null) : null))) t.pickedCorrect++;
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
    `  ${cell(label, 18)} ${cell(String(t.cases), 6)} ${cell(pct(t.withHits, t.cases), 7)} ${cell(pct(t.topCorrect, t.cases), 7)} ${cell(pct(t.anyCorrect, t.cases), 7)} ${cell(pct(t.pickedCorrect, t.cases), 8)} ${cell(pct(t.pickedWrong, t.cases), 8)} ${cell(pct(t.notPicked, t.cases), 8)} ${pct(t.card, t.cases)}`,
  );
}

interface Totals {
  total: Tally;
  byLanguage: Record<string, Tally>;
  bySuite: Record<string, Tally>;
  otherCases: number;
  otherFalse: number;
  otherBoundary: number;
  reports: SellerReport[];
}
const emptyTotals = (): Totals => ({ total: emptyTally(), byLanguage: {}, bySuite: {}, otherCases: 0, otherFalse: 0, otherBoundary: 0, reports: [] });
const HEAD = () => `  ${cell("", 18)} ${cell("cases", 6)} ${cell("hits", 7)} ${cell("top1", 7)} ${cell("top4", 7)} ${cell("picked✓", 8)} ${cell("picked✗", 8)} ${cell("no pick", 8)} card`;

function printSeller(r: SellerReport, label: string) {
  console.log(`\n${r.seller}${label}: ${r.cases} cases (${r.product.cases} name a product, ${r.other.cases} don't)`);
  console.log(HEAD());
  printTally("all", r.product);
  for (const [lang, t] of Object.entries(r.byLanguage).sort()) printTally(lang, t);
  for (const [suite, t] of Object.entries(r.bySuite).sort()) printTally(suite, t);
  console.log(`  no product named: ${r.other.cases} cases, ${r.other.withHits} with hits, ${r.other.falsePicks} false picks (${pct(r.other.falsePicks, r.other.cases - r.other.boundaryPicks)} of the non-boundary ones), ${r.other.boundaryPicks} boundary picks`);
  for (const m of r.misses) console.log(`  ✗ [${m.language}] "${m.input}" → wanted ${m.focus}; got ${m.top ? `"${m.top}"${m.topMcat ? ` (${m.topMcat})` : ""}` : "no hit"}${m.picked ? `; picked ${m.picked}` : ""}`);
  for (const f of r.falsePicks) console.log(`  ! [${f.language}] "${f.input}" (${f.suite}) picked ${f.picked}`);
  for (const f of r.boundaryPicks) console.log(`  ? [${f.language}] "${f.input}" (${f.suite}) picked ${f.picked}`);
}

function addTo(t: Totals, r: SellerReport) {
  t.reports.push(r);
  for (const k of Object.keys(t.total) as Array<keyof Tally>) {
    t.total[k] += r.product[k];
    for (const [lang, x] of Object.entries(r.byLanguage)) (t.byLanguage[lang] ??= emptyTally())[k] += x[k];
    for (const [suite, x] of Object.entries(r.bySuite)) (t.bySuite[suite] ??= emptyTally())[k] += x[k];
  }
  t.otherCases += r.other.cases;
  t.otherFalse += r.other.falsePicks;
  t.otherBoundary += r.other.boundaryPicks;
}

function printTotals(t: Totals, label: string) {
  console.log(`\nAll ${t.reports.length} sellers${label}`);
  console.log(HEAD());
  printTally("product", t.total);
  for (const [lang, x] of Object.entries(t.byLanguage).sort()) printTally(lang, x);
  for (const [suite, x] of Object.entries(t.bySuite).sort()) printTally(suite, x);
  console.log(`  no product named: ${t.otherCases} cases, ${t.otherFalse} false picks, ${t.otherBoundary} boundary picks`);
}

async function main() {
  const args = process.argv.slice(2);
  const valueOf = (flag: string) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : undefined);
  const out = valueOf("--out") ?? null;
  const maxMisses = Number(valueOf("--misses") ?? 12);
  const withJev = args.includes("--jev");
  const withHaiku = args.includes("--haiku");
  const valued = new Set(["--out", "--misses", "--jev-min-confidence", "--jev-cache", "--haiku-cache"]);
  const dir = args.find((a, i) => !a.startsWith("--") && !valued.has(args[i - 1] ?? ""));
  if (!dir || !fs.existsSync(dir)) {
    console.error('Usage: npm run retrieval:eval -- "<dir with one folder per seller>" [--out report.json] [--misses N] [--jev [--jev-min-confidence 0.5] [--jev-cache file]] [--haiku [--haiku-cache file]]');
    process.exit(1);
  }
  const pickers: PickerRun[] = [];
  if (withJev) {
    const apiKey = (process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY ?? "").trim();
    if (!apiKey) {
      console.error("--jev needs a Jev API key in JEV_API_KEY (or TYPESAFE_API_KEY), from console.typesafe.ai.");
      process.exit(1);
    }
    const client = new JevClient({ apiKey, model: process.env.JEV_MODEL || "jev-1.14.0", baseUrl: process.env.JEV_BASE_URL || "https://api.typesafe.ai", timeoutMs: 10_000 });
    pickers.push(jevRun(new CachedCaller(client, valueOf("--jev-cache") ?? path.join(dir, ".jev-cache.json")), Number(valueOf("--jev-min-confidence") ?? 0.5)));
  }
  if (withHaiku) {
    if (!(process.env.ANTHROPIC_API_KEY ?? "").trim()) {
      console.error("--haiku needs an Anthropic API key in ANTHROPIC_API_KEY.");
      process.exit(1);
    }
    const picker = new ClaudeProductPicker(new Anthropic(), process.env.PICK_COMPARE_MODEL || "claude-haiku-5-5", 30_000);
    pickers.push(claudeRun(picker, valueOf("--haiku-cache") ?? path.join(dir, ".haiku-pick-cache.json")));
  }
  const sellerDirs = fs
    .readdirSync(dir)
    .map((f) => path.join(dir, f))
    .filter((p) => fs.statSync(p).isDirectory())
    .sort();
  const base = emptyTotals();
  const pickerTotals = pickers.map(() => emptyTotals());
  for (const sd of sellerDirs) {
    const r = await evaluateSeller(sd, maxMisses);
    if (typeof r === "string") {
      console.log(`\n${r}`);
      continue;
    }
    printSeller(r, pickers.length ? " (word matching)" : "");
    addTo(base, r);
    for (const [i, p] of pickers.entries()) {
      const rp = await evaluateSeller(sd, maxMisses, p);
      if (typeof rp !== "string") printSeller(rp, ` (${p.label})`), addTo(pickerTotals[i]!, rp);
    }
  }
  if (base.reports.length > 1 || pickers.length) printTotals(base, pickers.length ? " (word matching)" : "");
  for (const [i, p] of pickers.entries()) {
    printTotals(pickerTotals[i]!, ` (${p.label})`);
    const ok = p.picks.filter((x) => !x.error);
    const ms = ok.map((x) => x.ms).sort((a, b) => a - b);
    const sum = (f: (x: PickRecord) => number) => ok.reduce((n, x) => n + f(x), 0);
    const by = (reason: string) => p.picks.filter((x) => x.reason === reason).length;
    console.log(`\n${p.model}: ${p.picks.length} calls, ${p.picks.length - ok.length} errors; decided a product ${by("pick")}, no product ${by("not about a product")}, unsure ${by("unsure")}`);
    if (ms.length) console.log(`  latency mean ${Math.round(sum((x) => x.ms) / ms.length)} ms, p50 ${ms[Math.floor(ms.length * 0.5)]} ms, p95 ${ms[Math.floor(ms.length * 0.95)] ?? ms.at(-1)} ms (cached answers count as their first call)`);
    if (ok.length)
      console.log(
        `  input tokens ${sum((x) => x.inputTokens).toLocaleString("en-IN")} (mean ${Math.round(sum((x) => x.inputTokens) / ok.length)} per call), output ${sum((x) => x.outputTokens).toLocaleString("en-IN")}; cost $${sum((x) => x.costUsd).toFixed(4)} ($${(sum((x) => x.costUsd) / ok.length).toFixed(6)} per call)`,
      );
  }
  if (out) {
    fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), sellers: base.reports, pickers: pickers.map((p, i) => ({ label: p.label, model: p.model, sellers: pickerTotals[i]!.reports })) }, null, 2));
    console.log(`\nReport written to ${out}`);
  }
}

void main();
