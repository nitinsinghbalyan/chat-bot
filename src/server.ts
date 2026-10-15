import Anthropic from "@anthropic-ai/sdk";
import { createApp } from "./app.js";
import { config, paths } from "./config.js";
import { refreshCatalogue } from "./crawler.js";
import { ChatDb } from "./db.js";
import { SellerRegistry, type SellerContext } from "./sellers.js";
import { SessionStore } from "./session.js";
import { FaqStore } from "./faq.js";
import { initTracing } from "./tracing.js";

const sellers = SellerRegistry.load();
const db = new ChatDb(paths.db);
const sessions = new SessionStore(db);
const crawling = new Set<string>();

/** Crawls one seller's pages (sitemap, else the KB JSON's page URLs) into DATA_DIR and swaps the new catalogue in. */
async function recrawl(seller: SellerContext) {
  const slug = seller.config.slug;
  if (crawling.has(slug) || sellers.crawlUrls(seller).length === 0) return;
  crawling.add(slug);
  const log = (m: string) => console.log(`[crawl:${slug}] ${m}`);
  try {
    const r = await refreshCatalogue({ urls: sellers.crawlUrls(seller), outFile: seller.runtimeCatalogueFile, previous: seller.crawled.length, log });
    if (r.entries) sellers.setCrawled(slug, r.entries);
    seller.lastCrawl = { at: new Date().toISOString(), status: r.status, ok: r.status === "ok", entries: r.fetched, message: r.message };
  } catch (err) {
    console.error(`[crawl:${slug}] failed`, err);
    seller.lastCrawl = { at: new Date().toISOString(), status: "failed", ok: false, entries: 0, message: (err as Error).message };
  } finally {
    crawling.delete(slug);
  }
}

/** Crawl sellers one after another so we never hit several sites (or one site) too hard. */
async function recrawlAll() {
  for (const seller of sellers.list()) await recrawl(seller);
}

const tracing = await initTracing();
const faq = await FaqStore.load(paths.data);
if (faq.file) console.log(`[faq] ${faq.file.summary}`);
const app = createApp({ client: new Anthropic(), sellers, sessions, db, recrawl, tracing, faq });

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
  // Send buffered traces before exiting, so the last chats before a redeploy aren't lost.
  const exit = () => void tracing.flush().finally(() => process.exit(0));
  server.close(() => {
    db.close();
    exit();
  });
  // Don't hang on open SSE streams.
  setTimeout(() => {
    db.close();
    exit();
  }, 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
