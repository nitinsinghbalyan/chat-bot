/**
 * Crawls sellers' sitemaps into their catalogues.
 *
 *   npm run crawl                    # every seller -> kb/sellers/<slug>/catalogue.json (commit these)
 *   npm run crawl -- <slug> [...]    # only these sellers
 *   npm run crawl -- --runtime       # write to DATA_DIR/sellers/<slug>/ instead (what the server does)
 */
import { refreshCatalogue } from "../src/crawler.js";
import { SellerRegistry } from "../src/sellers.js";

const args = process.argv.slice(2);
const runtime = args.includes("--runtime");
const slugs = args.filter((a) => !a.startsWith("--"));
const registry = SellerRegistry.load();
const sellers = slugs.length ? slugs.map((s) => registry.get(s) ?? (console.error(`Unknown seller: ${s}`), process.exit(1))) : registry.list();

let failed = 0;
for (const seller of sellers) {
  console.log(`\n== ${seller.config.name} (${seller.config.slug})`);
  const outFile = runtime || !seller.bundledCatalogueFile ? seller.runtimeCatalogueFile : seller.bundledCatalogueFile;
  const r = await refreshCatalogue({ urls: registry.crawlUrls(seller), outFile, log: (m) => console.log(`  ${m}`) });
  if (!r.entries) failed++;
}
process.exit(failed ? 1 : 0);
