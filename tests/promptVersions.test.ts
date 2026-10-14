import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatDb } from "../src/db.js";
import { diffLines } from "../src/diff.js";
import { defaultSystemTemplate } from "../src/prompts.js";
import { COMMON_SCOPE, newerBuiltIn, recordStartupVersions, recordVersion, sellerScope } from "../src/promptVersions.js";
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
});
