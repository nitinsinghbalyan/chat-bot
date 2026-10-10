import Anthropic from "@anthropic-ai/sdk";
import { createApp } from "./app.js";
import { config, paths } from "./config.js";
import { refreshCatalogue } from "./crawler.js";
import { ChatDb } from "./db.js";
import { SellerRegistry, type SellerContext } from "./sellers.js";
import { SessionStore } from "./session.js";

const sellers = SellerRegistry.load();
const db = new ChatDb(paths.db);
const sessions = new SessionStore(db);
const crawling = new Set<string>();

/** Crawls one seller's sitemap into DATA_DIR and swaps the new catalogue in. */
async function recrawl(seller: SellerContext) {
  const slug = seller.config.slug;
  if (crawling.has(slug)) return;
  crawling.add(slug);
  const log = (m: string) => console.log(`[crawl:${slug}] ${m}`);
  try {
    const entries = await refreshCatalogue({ sitemapFile: seller.sitemapFile, outFile: seller.runtimeCatalogueFile, log });
    if (entries) seller.catalogue.load(entries);
    seller.lastCrawl = {
      at: new Date().toISOString(),
      ok: !!entries,
      entries: entries?.length ?? 0,
      message: entries ? `${entries.length} pages` : "Site unreachable or no pages fetched; kept the previous catalogue",
    };
  } catch (err) {
    console.error(`[crawl:${slug}] failed`, err);
    seller.lastCrawl = { at: new Date().toISOString(), ok: false, entries: 0, message: (err as Error).message };
  } finally {
    crawling.delete(slug);
  }
}

/** Crawl sellers one after another so we never hit several sites (or one site) too hard. */
async function recrawlAll() {
  for (const seller of sellers.list()) await recrawl(seller);
}

const app = createApp({ client: new Anthropic(), sellers, sessions, db, recrawl });

function prune() {
  const removed = db.pruneSessions(30);
  if (removed) console.log(`[db] pruned ${removed} idle sessions`);
}

const server = app.listen(config.PORT, () => {
  console.log(`Seller assistants on http://localhost:${config.PORT} (model ${config.BOT_MODEL}, db ${paths.db})`);
  for (const s of sellers.list()) {
    console.log(`  - ${s.config.slug}: ${s.catalogue.size} catalogue entries, ${s.kb.productCards.length} product cards`);
  }
  if (sellers.size === 0) console.warn(`No sellers found in ${paths.sellers}`);
  if (!config.ADMIN_PASSWORD) console.warn("ADMIN_PASSWORD is not set: /admin is disabled.");
  if (config.CRAWL_ON_START) void recrawlAll();
  if (config.CRAWL_INTERVAL_HOURS > 0) setInterval(() => void recrawlAll(), config.CRAWL_INTERVAL_HOURS * 3_600_000).unref();
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
