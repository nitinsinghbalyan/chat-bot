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

/**
 * Run at startup after recordStartupVersions: when this deploy shipped a new built-in common
 * prompt and an older edit is in use, the new built-in takes over, so prompt fixes go live
 * without a click in admin. Only the part the deploy changed is replaced: a deploy that changes
 * only the system prompt keeps an edited guardrails text, and the other way round. The replaced
 * edit stays in the version history (Restore brings it back). Returns what was replaced.
 */
export function applyNewerBuiltIn(db: ChatDb, sellers: SellerRegistry): Array<"system" | "guardrails"> {
  const builtIn = newerBuiltIn(db, sellers);
  if (!builtIn) return [];
  const builtIns = db.listPromptVersions(COMMON_SCOPE).filter((v) => v.source === "built-in");
  const prev = builtIns.find((v) => v.id !== builtIn.id);
  const parts: Array<"system" | "guardrails"> = [];
  if (db.getPlatformPrompt("system") && (!prev || prev.a.trim() !== builtIn.a.trim())) parts.push("system");
  if (db.getPlatformPrompt("guardrails") && (!prev || prev.b.trim() !== builtIn.b.trim())) parts.push("guardrails");
  if (!parts.length) return [];
  for (const p of parts) db.setPlatformPrompt(p, null);
  sellers.setCommonPrompts({ ...(parts.includes("system") ? { system: null } : {}), ...(parts.includes("guardrails") ? { guardrails: null } : {}) });
  const what = parts.map((p) => (p === "system" ? "system prompt" : "guardrails")).join(" and ");
  recordVersion(db, COMMON_SCOPE, sellers.common.system, sellers.common.guardrails, "restored", `New built-in ${what} applied automatically on deploy; the edit it replaced is the version below`);
  return parts;
}

/**
 * The same for brand personas: when a deploy ships a changed persona.json and the seller uses a
 * persona saved in admin before that, the changed part (system or user) of the new default takes
 * over. The saved persona stays in the seller's version history. Returns the sellers updated.
 */
export function applyNewerBuiltInPersonas(db: ChatDb, sellers: SellerRegistry): string[] {
  const updated: string[] = [];
  for (const s of sellers.list()) {
    const slug = s.config.slug;
    const saved = db.getPrompts(slug);
    if (!(saved.system || saved.user) || !saved.updatedAt) continue;
    const scope = sellerScope(slug);
    const builtIns = db.listPromptVersions(scope).filter((v) => v.source === "built-in");
    const builtIn = builtIns[0];
    if (!builtIn || builtIn.createdAt <= saved.updatedAt || same(builtIn, s.persona.system, s.persona.user)) continue;
    const prev = builtIns[1];
    const next = {
      system: !prev || prev.a.trim() !== builtIn.a.trim() ? builtIn.a.trim() : saved.system,
      user: !prev || prev.b.trim() !== builtIn.b.trim() ? builtIn.b.trim() : saved.user,
    };
    const isDefault = next.system === s.defaultPersona.system.trim() && next.user === s.defaultPersona.user.trim();
    db.savePrompts(slug, isDefault ? { system: "", user: "" } : next);
    sellers.setPersona(slug, isDefault ? s.defaultPersona : next);
    recordVersion(db, scope, s.persona.system, s.persona.user, "restored", "New built-in persona applied automatically on deploy; the edit it replaced is in the history");
    updated.push(slug);
  }
  return updated;
}
