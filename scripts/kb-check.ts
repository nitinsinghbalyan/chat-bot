/**
 * Validates every seller KB folder in kb/sellers/ without starting the server.
 *
 *   npm run kb:check
 */
import path from "node:path";
import { paths } from "../src/config.js";
import { sellerDirs, validateSellerDir } from "../src/sellers.js";

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
process.exit(bad ? 1 : 0);
