import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatDb } from "../src/db.js";
import { diffLines } from "../src/diff.js";
import { defaultSystemTemplate, sharedGuardrails as sharedGuardrailsText } from "../src/prompts.js";
import { applyNewerBuiltIn, applyNewerBuiltInPersonas, COMMON_SCOPE, newerBuiltIn, recordStartupVersions, recordVersion, sellerScope } from "../src/promptVersions.js";
import { SellerRegistry } from "../src/sellers.js";

const registry = () => SellerRegistry.load(path.join(__dirname, "fixtures", "sellers"), fs.mkdtempSync(path.join(os.tmpdir(), "pv-data-")));

afterEach(() => vi.useRealTimers());

describe("diffLines", () => {
  it("marks kept, added and removed lines", () => {
    expect(diffLines("a\nb\nc", "a\nB\nc\nd")).toEqual([
      { op: "same", text: "a" },
      { op: "del", text: "b" },
      { op: "add", text: "B" },
      { op: "same", text: "c" },
      { op: "add", text: "d" },
    ]);
  });
});

describe("prompt versions", () => {
  it("records the shipped defaults once per change, and numbers versions within a scope", () => {
    const db = new ChatDb(":memory:");
    const sellers = registry();
    recordStartupVersions(db, sellers);
    recordStartupVersions(db, sellers); // a restart with the same files adds nothing
    const common = db.listPromptVersions(COMMON_SCOPE);
    expect(common).toHaveLength(1);
    expect(common[0]).toMatchObject({ number: 1, source: "built-in", a: defaultSystemTemplate() });
    // beta-pumps ships a persona.json; alpha-presses has none.
    expect(db.listPromptVersions(sellerScope("beta-pumps"))[0]).toMatchObject({ source: "built-in", a: "You are Beta Pumps' helpful pump expert." });
    expect(db.listPromptVersions(sellerScope("alpha-presses"))).toHaveLength(0);

    recordVersion(db, COMMON_SCOPE, "edited", "rules", "saved", "first edit");
    recordVersion(db, COMMON_SCOPE, "edited", "rules", "saved"); // same text: no new version
    const after = db.listPromptVersions(COMMON_SCOPE);
    expect(after.map((v) => [v.number, v.source, v.note])).toEqual([
      [2, "saved", "first edit"],
      [1, "built-in", "Default shipped with this deploy"],
    ]);
    expect(db.getPromptVersion(after[1].id)?.number).toBe(1);
  });

  it("keeps edits saved before version history and flags a newer built-in default", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T10:00:00Z"));
    const db = new ChatDb(":memory:");
    db.setPlatformPrompt("guardrails", "OLD EDITED GUARDRAILS");
    const sellers = registry();
    sellers.setCommonPrompts({ guardrails: "OLD EDITED GUARDRAILS" });
    vi.setSystemTime(new Date("2026-10-14T10:00:00Z"));
    recordStartupVersions(db, sellers);
    const versions = db.listPromptVersions(COMMON_SCOPE);
    expect(versions.map((v) => v.source)).toEqual(["built-in", "saved"]);
    expect(versions[1]).toMatchObject({ b: "OLD EDITED GUARDRAILS", note: "Saved before version history" });
    expect(newerBuiltIn(db, sellers)?.id).toBe(versions[0].id);

    // Saving again after the deploy means the admin has seen the new default.
    vi.setSystemTime(new Date("2026-10-15T10:00:00Z"));
    db.setPlatformPrompt("guardrails", "NEWER EDIT");
    expect(newerBuiltIn(db, sellers)).toBeNull();
  });

  it("applies a newly shipped built-in over an older edit, replacing only the part that changed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T10:00:00Z"));
    const db = new ChatDb(":memory:");
    // An older deploy shipped "OLD SYSTEM"; the admin then edited both texts.
    db.addPromptVersion({ scope: COMMON_SCOPE, a: "OLD SYSTEM {{GUARDRAILS}}", b: sharedGuardrailsText(), source: "built-in", note: "" });
    vi.setSystemTime(new Date("2026-10-02T10:00:00Z"));
    const edited = `${defaultSystemTemplate()}\nEDITED LINE`;
    db.setPlatformPrompt("system", edited);
    db.setPlatformPrompt("guardrails", "EDITED GUARDRAILS");
    const sellers = registry();
    sellers.setCommonPrompts({ system: edited, guardrails: "EDITED GUARDRAILS" });
    recordVersion(db, COMMON_SCOPE, edited, "EDITED GUARDRAILS", "saved", "my edit");
    // This deploy ships a new system prompt; the guardrails default is unchanged.
    vi.setSystemTime(new Date("2026-10-16T10:00:00Z"));
    recordStartupVersions(db, sellers);
    expect(applyNewerBuiltIn(db, sellers)).toEqual(["system"]);
    expect(sellers.common.system).toBe(defaultSystemTemplate());
    expect(sellers.common.guardrails).toBe("EDITED GUARDRAILS");
    expect(db.getPlatformPrompt("system")).toBeNull();
    expect(db.getPlatformPrompt("guardrails")?.value).toBe("EDITED GUARDRAILS");
    const [latest, , mine] = db.listPromptVersions(COMMON_SCOPE);
    expect(latest).toMatchObject({ source: "restored", note: expect.stringMatching(/^New built-in system prompt applied automatically/) });
    expect(mine).toMatchObject({ a: edited, note: "my edit" });
    // A restart applies nothing more.
    recordStartupVersions(db, sellers);
    expect(applyNewerBuiltIn(db, sellers)).toEqual([]);
  });

  it("applies a newly shipped persona.json over an older saved persona, part by part", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T10:00:00Z"));
    const db = new ChatDb(":memory:");
    const scope = sellerScope("beta-pumps");
    db.addPromptVersion({ scope, a: "You are Beta Pumps' helpful pump expert.", b: "OLD USER PART", source: "built-in", note: "" });
    vi.setSystemTime(new Date("2026-10-02T10:00:00Z"));
    db.savePrompts("beta-pumps", { system: "MY SYSTEM PART", user: "MY USER PART" });
    const sellers = registry();
    sellers.setPersona("beta-pumps", { system: "MY SYSTEM PART", user: "MY USER PART" });
    // This deploy ships persona.json with a new user part (the system part is unchanged).
    vi.setSystemTime(new Date("2026-10-16T10:00:00Z"));
    recordStartupVersions(db, sellers);
    expect(applyNewerBuiltInPersonas(db, sellers)).toEqual(["beta-pumps"]);
    const s = sellers.get("beta-pumps")!;
    expect(s.persona).toEqual({ system: "MY SYSTEM PART", user: s.defaultPersona.user });
    expect(db.getPrompts("beta-pumps")).toMatchObject({ system: "MY SYSTEM PART", user: s.defaultPersona.user });
    expect(db.listPromptVersions(scope)[0]).toMatchObject({ source: "restored" });
    // Nothing more on a restart, and a seller without a saved persona is left alone.
    recordStartupVersions(db, sellers);
    expect(applyNewerBuiltInPersonas(db, sellers)).toEqual([]);
  });
});
