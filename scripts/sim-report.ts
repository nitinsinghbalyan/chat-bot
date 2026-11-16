/**
 * Report for a simulation run (scripts/simulate.ts): tokens, latency and cost per call type, and the
 * product-pick comparison (word rules, Jev, Haiku asked the same question) against each scenario's product.
 *
 *   npm run sim:report -- runs/<run-id> [--out report.md]
 *
 * Writes report.md, calls.csv (one row per model call) and accuracy.csv (one row per compared turn)
 * into the run folder, and prints the report.
 */
import fs from "node:fs";
import path from "node:path";
import { readJsonl, type ConversationRow, type TurnRow } from "./lib/sim.js";
import { accuracyCsv, callsCsv, finishedTurns, renderReport } from "./lib/simReport.js";

const args = process.argv.slice(2);
const dir = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
if (!dir || !fs.existsSync(path.join(dir, "turns.jsonl"))) {
  console.error("Usage: npm run sim:report -- runs/<run-id> [--out report.md]");
  process.exit(1);
}
const out = args.includes("--out") ? args[args.indexOf("--out") + 1]! : path.join(dir, "report.md");
const run = fs.existsSync(path.join(dir, "run.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")) : { runId: path.basename(dir) };
const conversations = readJsonl<ConversationRow>(path.join(dir, "conversations.jsonl"));
const turns = finishedTurns(readJsonl<TurnRow>(path.join(dir, "turns.jsonl")), conversations);
const md = renderReport(run, turns, conversations);
fs.writeFileSync(out, md);
fs.writeFileSync(path.join(dir, "calls.csv"), callsCsv(turns));
fs.writeFileSync(path.join(dir, "accuracy.csv"), accuracyCsv(turns));
console.log(md);
console.log(`\nWritten: ${out}, ${path.join(dir, "calls.csv")}, ${path.join(dir, "accuracy.csv")}`);
