import Anthropic from "@anthropic-ai/sdk";
import { createApp } from "./app.js";
import { Catalogue } from "./catalogue.js";
import { config, paths } from "./config.js";
import { refreshCatalogue } from "./crawler.js";
import { ChatDb } from "./db.js";
import { loadKnowledgeBase } from "./kb.js";
import { renderSystemPrompt } from "./prompts.js";
import { SessionStore } from "./session.js";

const kb = loadKnowledgeBase();
const catalogue = Catalogue.fromDisk();
const db = new ChatDb(paths.db);
const sessions = new SessionStore(db);

const app = createApp({
  client: new Anthropic(),
  kb,
  catalogue,
  systemPrompt: renderSystemPrompt(kb),
  sessions,
  db,
});

async function refresh() {
  try {
    const entries = await refreshCatalogue((m) => console.log(`[crawl] ${m}`), paths.catalogue);
    if (entries) catalogue.load(entries);
  } catch (err) {
    console.error("[crawl] failed", err);
  }
}

function prune() {
  const removed = db.pruneSessions(30);
  if (removed) console.log(`[db] pruned ${removed} idle sessions`);
}

const server = app.listen(config.PORT, () => {
  console.log(
    `Chatbot for ${kb.businessCard.name} on http://localhost:${config.PORT} (model ${config.BOT_MODEL}, ${catalogue.size} catalogue entries, db ${paths.db})`,
  );
  if (catalogue.size === 0) console.warn("Catalogue is empty: run `npm run crawl` (needs access to the seller site) so prices and links can be shared.");
  if (!config.ADMIN_PASSWORD) console.warn("ADMIN_PASSWORD is not set: /admin/leads is disabled.");
  if (config.CRAWL_ON_START) void refresh();
  if (config.CRAWL_INTERVAL_HOURS > 0) setInterval(() => void refresh(), config.CRAWL_INTERVAL_HOURS * 3_600_000).unref();
  prune();
  setInterval(prune, 24 * 3_600_000).unref();
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Don't hang on open SSE streams.
  setTimeout(() => {
    db.close();
    process.exit(0);
  }, 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
