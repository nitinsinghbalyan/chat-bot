import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { strToU8, unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { applyPendingRestore, backupFiles, backupName, PENDING, safeEntryName, stageRestore } from "../src/backup.js";
import { buildCommit } from "../src/config.js";
import { ChatDb } from "../src/db.js";
import { SellerRegistry } from "../src/sellers.js";
import { SessionStore } from "../src/session.js";

const PASSWORD = "correct-horse-battery";
const auth = { Authorization: `Basic ${Buffer.from(`a:${PASSWORD}`).toString("base64")}` };
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** A data disk with a database (a lead and a bot key), seller files, a FAQ and leftovers that must not be backed up. */
function seedDisk() {
  const dir = tmp("backup-src-");
  const db = new ChatDb(path.join(dir, "chatbot.db"));
  db.insertLead({ createdAt: "2026-11-01T10:00:00.000Z", seller: "alpha-presses", sessionId: "alpha:s1", mobile: "9876543210", name: "Ramesh", product: "Press Brake", requirements: "", quantity: "1", city: "Rajkot" });
  db.createBotKey("alpha-presses", "f".repeat(64), "sa_live_ab", "Auditor", "live");
  fs.mkdirSync(path.join(dir, "sellers", "alpha-presses", "files"), { recursive: true });
  fs.writeFileSync(path.join(dir, "sellers", "alpha-presses", "seller_kb.json"), '{"seller":{}}');
  fs.writeFileSync(path.join(dir, "sellers", "alpha-presses", "files", "business_card.md"), "## Dispatch");
  fs.writeFileSync(path.join(dir, "sellers", "alpha-presses", "catalogue.json.tmp"), "half");
  fs.writeFileSync(path.join(dir, "faq.xlsx"), "xlsx");
  fs.mkdirSync(path.join(dir, "backups"));
  fs.writeFileSync(path.join(dir, "backups", "old.zip"), "old");
  return { dir, db };
}

describe("backup and restore of the data disk", () => {
  let base = "";
  let close: () => void;
  let src: ReturnType<typeof seedDisk>;
  let restarts = 0;

  beforeAll(async () => {
    src = seedDisk();
    const sellers = SellerRegistry.load(path.join(__dirname, "fixtures", "sellers"), path.join(src.dir, "sellers"));
    const app = createApp({ client: {} as Anthropic, sellers, sessions: new SessionStore(src.db), db: src.db, allowedOrigins: [], adminPassword: PASSWORD, dataDir: src.dir, restart: () => restarts++ });
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close?.());

  it("lists the disk's files without the live database, staging folders, nightly backups or temp files", () => {
    expect(backupFiles(src.dir)).toEqual(["faq.xlsx", "sellers/alpha-presses/files/business_card.md", "sellers/alpha-presses/seller_kb.json"]);
    expect(backupName(new Date("2026-11-06T09:30:00Z"))).toBe("seller-assistants-backup-2026-11-06-0930.zip");
  });

  it("downloads everything in one zip, admin only", async () => {
    expect((await fetch(`${base}/admin/backup`)).status).toBe(401);
    const res = await fetch(`${base}/admin/backup`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="seller-assistants-backup-.*\.zip"/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(["backup.json", "chatbot.db", "faq.xlsx", "sellers/alpha-presses/files/business_card.md", "sellers/alpha-presses/seller_kb.json"]);
    expect(JSON.parse(Buffer.from(files["backup.json"]!).toString())).toMatchObject({ app: "seller-assistants", version: 1, files: 4 });
    expect(Buffer.from(files["chatbot.db"]!.subarray(0, 15)).toString()).toBe("SQLite format 3");
  });

  it("restores a backup on another server: staged, then swapped in on the next start", async () => {
    const zip = new Uint8Array(await (await fetch(`${base}/admin/backup`, { headers: auth })).arrayBuffer());
    // The new server's disk has its own (empty) data.
    const dest = tmp("backup-dest-");
    new ChatDb(path.join(dest, "chatbot.db")).close();
    fs.writeFileSync(path.join(dest, "faq.csv"), "old faq");
    const staged = stageRestore(zip, dest);
    expect(staged).toMatchObject({ ok: true, leads: 1, sellers: 1, files: 4 });
    // Nothing in use changes until the restart.
    expect(fs.existsSync(path.join(dest, "faq.csv"))).toBe(true);
    const before = applyPendingRestore(dest, () => {});
    expect(before).toMatch(/\.before-restore-/);
    expect(fs.existsSync(path.join(dest, PENDING))).toBe(false);
    expect(fs.existsSync(path.join(dest, "faq.csv"))).toBe(false);
    expect(fs.readFileSync(path.join(before!, "faq.csv"), "utf8")).toBe("old faq");
    expect(fs.readFileSync(path.join(dest, "sellers", "alpha-presses", "files", "business_card.md"), "utf8")).toBe("## Dispatch");
    const db = new ChatDb(path.join(dest, "chatbot.db"));
    expect(db.listLeads().map((l) => l.name)).toEqual(["Ramesh"]);
    expect(db.listBotKeys("alpha-presses").map((k) => [k.label, k.kind])).toEqual([["Auditor", "live"]]);
    db.close();
    // Nothing staged: nothing happens.
    expect(applyPendingRestore(dest, () => {})).toBeNull();
  });

  it("restores through /admin from this site only, then restarts the server", async () => {
    const zip = await (await fetch(`${base}/admin/backup`, { headers: auth })).arrayBuffer();
    const post = (origin: string, body: ArrayBuffer | Uint8Array) => fetch(`${base}/admin/backup/restore`, { method: "POST", headers: { ...auth, Origin: origin, "Content-Type": "application/octet-stream" }, body });
    expect((await post("https://evil.example", zip)).status).toBe(403);
    const res = await post(base, zip);
    const r = await res.json();
    expect(r).toMatchObject({ ok: true, delay: 20000 });
    expect(r.summary).toMatch(/1 seller folder, 1 lead and 4 files/);
    await new Promise((ok) => setTimeout(ok, 700));
    expect(restarts).toBe(1);
    expect(fs.existsSync(path.join(src.dir, PENDING, "chatbot.db"))).toBe(true);
    fs.rmSync(path.join(src.dir, PENDING), { recursive: true });
    const bad = await post(base, strToU8("not a zip"));
    expect(bad.status).toBe(400);
    expect((await bad.json()).errors[0]).toMatch(/not a zip/);
  });

  it("refuses zips that aren't a backup or would write outside the data folder", () => {
    const dest = tmp("backup-bad-");
    const manifest = strToU8(JSON.stringify({ app: "seller-assistants", version: 1 }));
    const sqlite = fs.readFileSync(path.join(src.dir, "chatbot.db"));
    expect(stageRestore(zipSync({ "faq.xlsx": strToU8("x") }), dest)).toMatchObject({ ok: false, error: expect.stringMatching(/not a Seller assistants backup/) });
    expect(stageRestore(zipSync({ "backup.json": manifest, "chatbot.db": strToU8("hello") }), dest)).toMatchObject({ ok: false, error: expect.stringMatching(/not a SQLite database/) });
    expect(stageRestore(zipSync({ "backup.json": manifest, "chatbot.db": new Uint8Array(sqlite), "../escape.txt": strToU8("x") }), dest)).toMatchObject({ ok: false, error: expect.stringMatching(/outside the data folder/) });
    expect(fs.existsSync(path.join(dest, PENDING))).toBe(false);
    for (const n of ["../x", "/etc/passwd", "C:/x", "a\\b", "sellers/../../x", ".restore-pending/x", "chatbot.db-wal", "backups/a.zip"]) expect(safeEntryName(n), n).toBe(false);
    for (const n of ["chatbot.db", "faq.xlsx", "sellers/a/files/b.json"]) expect(safeEntryName(n), n).toBe(true);
  });
});

describe("build id", () => {
  it("comes from GIT_COMMIT, else Render's variable, else the deploy script's .build-commit file", () => {
    const root = tmp("build-");
    expect(buildCommit({}, root)).toBeNull();
    fs.writeFileSync(path.join(root, ".build-commit"), "c699334a90cf7c9a2fcb058a4092410f4b9cf8c2\n");
    expect(buildCommit({}, root)).toBe("c699334a90cf");
    expect(buildCommit({ RENDER_GIT_COMMIT: "aaaabbbbccccdddd" }, root)).toBe("aaaabbbbcccc");
    expect(buildCommit({ GIT_COMMIT: "1234567890abcdef", RENDER_GIT_COMMIT: "aaaabbbbccccdddd" }, root)).toBe("1234567890ab");
    fs.writeFileSync(path.join(root, ".build-commit"), "<html>");
    expect(buildCommit({}, root)).toBeNull();
  });
});
