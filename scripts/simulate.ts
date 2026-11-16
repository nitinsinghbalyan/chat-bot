/**
 * Conversation simulator: one chat per test scenario, against a running bot through the Bot API.
 * Claude (Haiku by default) plays the buyer from each scenario's persona brief; the bot answers as it
 * does for anyone. Use a **Test** key per seller: test leads, traces tagged eval/simulator, and each
 * reply carries the turn's model calls (tokens, latency, cost) and every picker's product.
 *
 *   ANTHROPIC_API_KEY=… KEY_JAYSHREE=sa_live_… npm run simulate -- --config sim.config.json \
 *     [--seller jayshree-machinetools] [--scenario price] [--limit 10] [--concurrency 4] \
 *     [--max-turns 14] [--out runs] [--run-id 2026-11-17-a] [--buyer-model claude-haiku-5-5]
 *
 * The config (see scripts/sim.config.example.json) names the bot's base URL and, per seller, its slug,
 * the environment variable holding its Test key and its *_Scenarios.json. Results go to
 * <out>/<run-id>/ (turns.jsonl, conversations.jsonl, run.json); rerunning with the same --run-id skips
 * finished scenarios. Then: npm run sim:report -- <out>/<run-id>
 */
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { appendJsonl, buyerBrief, claudeBuyer, httpBotApi, loadConfig, loadScenarios, mobileFor, resumeState, runConversation, type ConversationRow, type Scenario } from "./lib/sim.js";

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

async function main() {
  const args = process.argv.slice(2);
  const valueOf = (flag: string) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : undefined);
  const configFile = valueOf("--config");
  if (!configFile || !fs.existsSync(configFile)) {
    console.error("Usage: npm run simulate -- --config sim.config.json [--seller slug] [--scenario text] [--limit N] [--concurrency 4] [--max-turns 14] [--out runs] [--run-id id] [--buyer-model claude-haiku-5-5]");
    process.exit(1);
  }
  if (!(process.env.ANTHROPIC_API_KEY ?? "").trim()) {
    console.error("The simulated buyer needs an Anthropic API key in ANTHROPIC_API_KEY.");
    process.exit(1);
  }
  const config = loadConfig(configFile);
  const runId = valueOf("--run-id") ?? new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const outDir = path.join(valueOf("--out") ?? "runs", runId);
  const limit = Number(valueOf("--limit") ?? Infinity);
  const concurrency = Number(valueOf("--concurrency") ?? 4);
  const maxTurns = Number(valueOf("--max-turns") ?? 14);
  const buyerModel = valueOf("--buyer-model") ?? "claude-haiku-5-5";
  const onlySeller = valueOf("--seller");
  const scenarioFilter = valueOf("--scenario")?.toLowerCase();
  fs.mkdirSync(outDir, { recursive: true });

  const api = httpBotApi(config.baseUrl);
  const health = await fetch(`${config.baseUrl}/health`)
    .then((r) => r.json())
    .catch(() => null);
  const runFile = path.join(outDir, "run.json");
  if (!fs.existsSync(runFile)) fs.writeFileSync(runFile, JSON.stringify({ runId, startedAt: new Date().toISOString(), baseUrl: config.baseUrl, buyerModel, maxTurns, health }, null, 2));
  console.log(`Run ${runId} → ${outDir}`);
  if (health) console.log(`Bot: build ${health.build?.commit ?? "?"}, model ${health.model}, Jev ${health.jev?.mode ?? "?"}`);
  if (health?.jev?.mode === "off") console.log("Note: Jev is Off on this bot, so neither Jev nor the Haiku comparison pick will run. Set it to Shadow on /admin.");

  const client = new Anthropic();
  const turnsFile = path.join(outDir, "turns.jsonl");
  const convFile = path.join(outDir, "conversations.jsonl");
  const resume = resumeState(outDir);
  const totals = { conversations: 0, turns: 0, summaries: 0, failed: 0 };

  for (const seller of config.sellers) {
    if (onlySeller && seller.slug !== onlySeller) continue;
    const key = (process.env[seller.keyEnv] ?? "").trim();
    if (!key) {
      console.error(`${seller.slug}: no Test key in ${seller.keyEnv}, skipped`);
      continue;
    }
    const bot = await api.details(seller.slug, key);
    let scenarios: Scenario[] = loadScenarios(seller.scenarios).filter((s) => !resume.done.has(`${seller.slug}|${s.scenario_id}`));
    if (scenarioFilter) scenarios = scenarios.filter((s) => s.scenario_id.toLowerCase().includes(scenarioFilter));
    scenarios = scenarios.slice(0, limit);
    console.log(`\n${seller.slug}: ${scenarios.length} scenario(s) to run`);
    await pool(scenarios, concurrency, async (s) => {
      const buyer = claudeBuyer(client, buyerModel, buyerBrief(s, { mobile: mobileFor(s.scenario_id), otp: bot.demoOtp }));
      let row: ConversationRow;
      try {
        row = await runConversation({
          runId,
          slug: seller.slug,
          key,
          scenario: s,
          attempt: resume.nextAttempt(seller.slug, s.scenario_id),
          api,
          buyer,
          greeting: bot.greeting,
          maxTurns,
          onTurn: (t) => appendJsonl(turnsFile, t),
        });
      } catch (err) {
        totals.failed++;
        console.log(`  ✗ ${s.scenario_id}: ${(err as Error).message.slice(0, 160)} (will be retried on the next run)`);
        return;
      }
      appendJsonl(convFile, row);
      totals.conversations++;
      totals.turns += row.turns;
      if (row.summary) totals.summaries++;
      console.log(`  ${row.stop === "errors" ? "✗" : "✓"} ${s.scenario_id}: ${row.turns} turns, ${row.stop}${row.finalProduct ? `, product ${row.finalProduct}` : ""}${row.error ? ` (${row.error.slice(0, 120)})` : ""}`);
    });
  }
  console.log(`\nDone: ${totals.conversations} conversations, ${totals.turns} bot turns, ${totals.summaries} reached the summary${totals.failed ? `, ${totals.failed} failed (rerun with --run-id ${runId} to retry them)` : ""}.`);
  console.log(`Report: npm run sim:report -- ${outDir}`);
}

void main();
