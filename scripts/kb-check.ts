/**
 * Validates every seller KB folder in kb/sellers/ without starting the server, and prints the
 * knowledge mapping (categories → MCATs → questions, cards, FAQs, policy card) for every seller
 * that has a knowledge base JSON on the data disk.
 *
 *   npm run kb:check
 */
import path from "node:path";
import { paths } from "../src/config.js";
import { sellerDirs, SellerRegistry, validateSellerDir } from "../src/sellers.js";

const dirs = sellerDirs(paths.sellers);
if (dirs.length === 0) {
  console.error(`No seller folders found in ${paths.sellers}`);
  process.exit(1);
}
let bad = 0;
for (const dir of dirs) {
  const problems = validateSellerDir(dir);
  if (problems.length) {
    bad++;
    console.log(`✗ ${path.basename(dir)}`);
    for (const p of problems) console.log(`    ${p}`);
  } else {
    console.log(`✓ ${path.basename(dir)}`);
  }
}
console.log(bad ? `\n${bad} of ${dirs.length} seller folder(s) need fixing.` : `\nAll ${dirs.length} seller folder(s) are valid.`);

// Knowledge mapping for sellers with an uploaded KB JSON (DATA_DIR/sellers/<slug>/seller_kb.json).
if (!bad) {
  const reg = SellerRegistry.load(paths.sellers, path.join(paths.data, "sellers"));
  for (const s of reg.list()) {
    const m = s.mapping;
    if (!m) continue;
    console.log(`\n${s.config.name} (${s.config.slug}): KB v${m.version}, ${m.categories.length} categories, ${m.cards.length} cards, ${m.faqs.product} product FAQs${m.policyCard ? `, policy card (${m.policyCard.sections.join(", ")})` : ""}`);
    for (const f of m.flags) console.log(`  ! ${f}`);
    for (const c of m.categories) {
      const q = c.questions.isqs.length ? `${c.questions.source}: ${c.questions.isqs.map((x) => x.question).join(", ")}` : "no questions";
      console.log(`  - ${c.name} [${c.products}] → ${c.mainMcat ? `${c.mainMcat.name ?? `MCAT ${c.mainMcat.id}`}${c.mainMcat.inFile ? "" : " (not in file)"}` : "no MCAT"}${c.otherMcats.length ? ` +${c.otherMcats.length}` : ""} → ${q}${c.flags.length ? `  (${c.flags.join("; ")})` : ""}`);
    }
  }
}
process.exit(bad ? 1 : 0);
