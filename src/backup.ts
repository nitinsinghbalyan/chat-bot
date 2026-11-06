/**
 * Backup and restore of everything on the data disk (DATA_DIR): the SQLite database (leads, chats,
 * prompts and their versions, bot API keys), uploaded KB JSONs, extra files, crawls and the FAQ sheet.
 *
 * - `writeBackup` streams a zip: a consistent copy of chatbot.db (SQLite's online backup, so chats in
 *   progress don't corrupt it), every other file under DATA_DIR, and backup.json describing it.
 * - `stageRestore` checks an uploaded zip and unpacks it into DATA_DIR/.restore-pending.
 * - `applyPendingRestore` runs at start-up, before the database or the sellers are opened: it moves the
 *   current data to DATA_DIR/.before-restore-<time> and the staged data into place.
 *
 * Used to move the data between hosts (Render → the Oracle server) and by the nightly backup.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";
import Database from "better-sqlite3";
import { Zip, ZipDeflate, unzipSync } from "fflate";
import type { ChatDb } from "./db.js";

export const DB_FILE = "chatbot.db";
export const MANIFEST = "backup.json";
export const PENDING = ".restore-pending";
const BEFORE_PREFIX = ".before-restore-";
/** The nightly backups folder (deploy/oracle): never backed up or replaced itself. */
export const BACKUPS_DIR = "backups";
/** Largest backup the restore accepts. */
export const RESTORE_LIMIT_BYTES = 300 * 1024 * 1024;

export interface BackupManifest {
  app: "seller-assistants";
  version: 1;
  createdAt: string;
  build: string | null;
  files: number;
  bytes: number;
}

/** Top-level names in DATA_DIR that are not part of a backup. */
function skipTop(name: string): boolean {
  return name === PENDING || name === BACKUPS_DIR || name.startsWith(BEFORE_PREFIX) || name === DB_FILE || name.startsWith(`${DB_FILE}-`);
}

/** Every file under DATA_DIR that goes into a backup (relative paths with "/"), without the live database. */
export function backupFiles(dataDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && skipTop(e.name)) continue;
      if (e.name.endsWith(".tmp")) continue;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(dataDir, "");
  return out.sort();
}

/** The download's file name, e.g. seller-assistants-backup-2026-11-06-0930.zip (UTC). */
export function backupName(at = new Date()): string {
  const s = at.toISOString();
  return `seller-assistants-backup-${s.slice(0, 10)}-${s.slice(11, 13)}${s.slice(14, 16)}.zip`;
}

/**
 * Streams the backup zip into `out`. Files are added one at a time, so a large catalogue is never held
 * in memory twice. Resolves with the manifest once the zip is complete.
 */
export async function writeBackup(db: ChatDb, dataDir: string, out: Writable, build: string | null): Promise<BackupManifest> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sa-backup-"));
  try {
    const dbCopy = path.join(tmp, DB_FILE);
    await db.backupTo(dbCopy);
    const files = backupFiles(dataDir);
    const entries: Array<[string, string]> = [[DB_FILE, dbCopy], ...files.map((f) => [f, path.join(dataDir, f)] as [string, string])];
    let bytes = 0;
    let manifest!: BackupManifest;
    await new Promise<void>((resolve, reject) => {
      const zip = new Zip((err, chunk, final) => {
        if (err) return reject(err);
        if (chunk.length) out.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length));
        if (final) resolve();
      });
      const add = (name: string, data: Uint8Array) => {
        const f = new ZipDeflate(name, { level: 6 });
        zip.add(f);
        f.push(data, true);
        bytes += data.length;
      };
      let count = 0;
      for (const [name, file] of entries) {
        // A file removed between the listing and now (a crawl swap) is skipped.
        let data: Buffer;
        try {
          data = fs.readFileSync(file);
        } catch {
          continue;
        }
        add(name, data);
        count++;
      }
      manifest = { app: "seller-assistants", version: 1, createdAt: new Date().toISOString(), build, files: count, bytes };
      add(MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2)));
      zip.end();
    });
    return manifest;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** True for a path inside the zip that stays inside DATA_DIR once unpacked. */
export function safeEntryName(name: string): boolean {
  if (!name || name.length > 400) return false;
  if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name) || name.includes("\\") || name.includes("\0")) return false;
  const parts = name.split("/");
  if (!parts.every((p) => p !== "" && p !== ".." && p !== ".")) return false;
  // The live database comes in as chatbot.db only; WAL files, staging and old-data folders never do.
  return name === DB_FILE || !skipTop(parts[0]!);
}

export type StageResult = { ok: true; manifest: BackupManifest; files: number; leads: number; sellers: number } | { ok: false; error: string };

/**
 * Checks an uploaded backup and unpacks it into DATA_DIR/.restore-pending. Nothing in use is touched:
 * the swap happens on the next start (`applyPendingRestore`).
 */
export function stageRestore(zipBytes: Uint8Array, dataDir: string): StageResult {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zipBytes);
  } catch {
    return { ok: false, error: "That file is not a zip. Upload the file the Download backup button gave you." };
  }
  const names = Object.keys(files).filter((n) => !n.endsWith("/"));
  if (!names.includes(MANIFEST) || !names.includes(DB_FILE)) return { ok: false, error: "That zip is not a Seller assistants backup (backup.json or chatbot.db is missing)." };
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(Buffer.from(files[MANIFEST]!).toString("utf8"));
  } catch {
    return { ok: false, error: "The backup's backup.json is not readable." };
  }
  if (manifest?.app !== "seller-assistants" || manifest.version !== 1) return { ok: false, error: "That zip is not a Seller assistants backup (unknown backup.json)." };
  const unsafe = names.find((n) => n !== MANIFEST && !safeEntryName(n));
  if (unsafe) return { ok: false, error: `The backup holds a file outside the data folder (${unsafe}); nothing was restored.` };
  const dbBytes = files[DB_FILE]!;
  if (Buffer.from(dbBytes.subarray(0, 16)).toString("latin1") !== "SQLite format 3\0") return { ok: false, error: "The backup's chatbot.db is not a SQLite database." };

  const pending = path.join(dataDir, PENDING);
  fs.rmSync(pending, { recursive: true, force: true });
  fs.mkdirSync(pending, { recursive: true });
  for (const n of names) {
    if (n === MANIFEST) continue;
    const target = path.join(pending, ...n.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, files[n]!);
  }
  // The database must open and look like ours.
  let leads = 0;
  try {
    const check = new Database(path.join(pending, DB_FILE), { readonly: true, fileMustExist: true });
    try {
      const tables = new Set((check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name));
      if (!tables.has("leads") || !tables.has("sessions")) throw new Error("tables");
      leads = (check.prepare("SELECT COUNT(*) AS n FROM leads").get() as { n: number }).n;
    } finally {
      check.close();
    }
  } catch {
    fs.rmSync(pending, { recursive: true, force: true });
    return { ok: false, error: "The backup's chatbot.db can't be opened as this app's database." };
  }
  const sellersDir = path.join(pending, "sellers");
  const sellers = fs.existsSync(sellersDir) ? fs.readdirSync(sellersDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length : 0;
  return { ok: true, manifest, files: names.length - 1, leads, sellers };
}

/**
 * Applies a staged restore. Call before the database and the sellers are opened. The data it replaces
 * is kept in DATA_DIR/.before-restore-<time>, so a wrong restore can be undone by hand.
 * Returns the folder the old data went to, or null when there was nothing to restore.
 */
export function applyPendingRestore(dataDir: string, log: (m: string) => void = console.log): string | null {
  const pending = path.join(dataDir, PENDING);
  if (!fs.existsSync(path.join(pending, DB_FILE))) {
    if (fs.existsSync(pending)) fs.rmSync(pending, { recursive: true, force: true });
    return null;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const before = path.join(dataDir, `${BEFORE_PREFIX}${stamp}`);
  fs.mkdirSync(before, { recursive: true });
  for (const name of fs.readdirSync(dataDir)) {
    if (name === PENDING || name === BACKUPS_DIR || name.startsWith(BEFORE_PREFIX)) continue;
    fs.renameSync(path.join(dataDir, name), path.join(before, name));
  }
  for (const name of fs.readdirSync(pending)) fs.renameSync(path.join(pending, name), path.join(dataDir, name));
  fs.rmSync(pending, { recursive: true, force: true });
  log(`[backup] restored the staged backup; the previous data is in ${before}`);
  return before;
}
