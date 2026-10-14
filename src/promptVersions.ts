/**
 * Version history for prompts edited in admin. Scope "common" holds the common system prompt (a)
 * and guardrails (b); scope "seller:<slug>" holds a seller's brand persona, system (a) and user (b).
 */
import type { ChatDb, PromptVersion, PromptVersionSource } from "./db.js";
import { defaultSystemTemplate, sharedGuardrails } from "./prompts.js";
import type { SellerRegistry } from "./sellers.js";

export const COMMON_SCOPE = "common";
export const sellerScope = (slug: string) => `seller:${slug}`;

const same = (v: { a: string; b: string } | null, a: string, b: string) => !!v && v.a.trim() === a.trim() && v.b.trim() === b.trim();

/** Adds a version unless the newest one already holds the same text. Returns the version now on top. */
export function recordVersion(db: ChatDb, scope: string, a: string, b: string, source: PromptVersionSource, note = ""): void {
  if (same(db.latestPromptVersion(scope), a, b)) return;
  db.addPromptVersion({ scope, a, b, source, note });
}

/** The newest version whose text is what the bot uses now (shown as "Active"). */
export function activeVersionId(versions: PromptVersion[], a: string, b: string): number | null {
  return versions.find((v) => same(v, a, b))?.id ?? null;
}

/**
 * Run at startup: records the shipped defaults (prompts/*.md and each repo seller's persona.json)
 * as a "built-in" version whenever a deploy changed them, and records edits saved before version
 * history existed, so every prompt in use has a version to compare against and go back to.
 */
export function recordStartupVersions(db: ChatDb, sellers: SellerRegistry): void {
  const sys = db.getPlatformPrompt("system");
  const gr = db.getPlatformPrompt("guardrails");
  if ((sys || gr) && !db.latestPromptVersion(COMMON_SCOPE)) {
    db.addPromptVersion({ scope: COMMON_SCOPE, a: sellers.common.system, b: sellers.common.guardrails, source: "saved", note: "Saved before version history" });
  }
  const builtIn = { a: defaultSystemTemplate(), b: sharedGuardrails() };
  if (!same(db.latestPromptVersion(COMMON_SCOPE, "built-in"), builtIn.a, builtIn.b)) {
    db.addPromptVersion({ scope: COMMON_SCOPE, ...builtIn, source: "built-in", note: "Default shipped with this deploy" });
  }
  for (const s of sellers.list()) {
    const scope = sellerScope(s.config.slug);
    const saved = db.getPrompts(s.config.slug);
    if ((saved.system || saved.user) && !db.latestPromptVersion(scope)) {
      db.addPromptVersion({ scope, a: saved.system, b: saved.user, source: "saved", note: "Saved before version history" });
    }
    const d = s.defaultPersona;
    if ((d.system || d.user) && !same(db.latestPromptVersion(scope, "built-in"), d.system, d.user)) {
      db.addPromptVersion({ scope, a: d.system, b: d.user, source: "built-in", note: "persona.json shipped with this deploy" });
    }
  }
}

/**
 * When an edited common prompt is in use and a deploy has since shipped a different built-in
 * default, returns that built-in version so admin can offer to switch to it.
 */
export function newerBuiltIn(db: ChatDb, sellers: SellerRegistry): PromptVersion | null {
  const edits = [db.getPlatformPrompt("system"), db.getPlatformPrompt("guardrails")].filter((x) => x !== null);
  if (!edits.length) return null;
  const lastEdit = edits.map((e) => e.updatedAt).sort().at(-1)!;
  const builtIn = db.latestPromptVersion(COMMON_SCOPE, "built-in");
  if (!builtIn || builtIn.createdAt <= lastEdit) return null;
  return same(builtIn, sellers.common.system, sellers.common.guardrails) ? null : builtIn;
}
