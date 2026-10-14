import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Lead } from "./tools.js";

/** Rows written before multi-seller support belong to the original seller. */
export const LEGACY_SELLER = "jayshree-machinetools";

export interface StoredSession {
  /** "<seller>:<browser session id>" */
  id: string;
  seller: string;
  messages: unknown[];
  lead: unknown;
  seenCatalogue: unknown[];
  pendingNotes: string[];
  lastQuery: string;
  turns: number;
  createdAt: number;
  lastSeen: number;
}

export interface StoredLead extends Lead {
  id: number;
}

/** A seller's brand persona: added to the system prompt, and to every buyer turn. */
export interface SellerPersona {
  system: string;
  user: string;
}

export interface TranscriptLine {
  seller: string;
  sessionId: string;
  role: "buyer" | "bot";
  text: string;
  guardrails?: string[];
}

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  seller         TEXT NOT NULL,
  messages       TEXT NOT NULL,
  lead           TEXT NOT NULL,
  seen_catalogue TEXT NOT NULL,
  pending_notes  TEXT NOT NULL,
  last_query     TEXT NOT NULL DEFAULT '',
  turns          INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_last_seen ON sessions(last_seen);

CREATE TABLE IF NOT EXISTS transcript (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  seller      TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('buyer', 'bot')),
  text        TEXT NOT NULL,
  guardrails  TEXT,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS transcript_session ON transcript(session_id, id);

CREATE TABLE IF NOT EXISTS leads (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   TEXT NOT NULL,
  seller       TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  mobile       TEXT NOT NULL,
  name         TEXT NOT NULL,
  product      TEXT NOT NULL,
  requirements TEXT NOT NULL,
  quantity     TEXT NOT NULL,
  city         TEXT NOT NULL,
  page_url     TEXT
);

CREATE TABLE IF NOT EXISTS guardrail_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  seller      TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  rule        TEXT NOT NULL,
  original    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seller_prompts (
  seller          TEXT PRIMARY KEY,
  system_persona  TEXT NOT NULL DEFAULT '',
  user_persona    TEXT NOT NULL DEFAULT '',
  updated_at      TEXT NOT NULL
);
`;

/** SQLite store for chat sessions, transcripts, leads and guardrail events. */
export class ChatDb {
  private db: Database.Database;

  /** @param file a file path, or ":memory:" for tests */
  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(MIGRATIONS);
    this.migrateToMultiSeller();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS leads_seller ON leads(seller, id);
      CREATE INDEX IF NOT EXISTS guardrail_events_seller ON guardrail_events(seller, id);
    `);
  }

  /**
   * Databases created before multi-seller support have no seller column. Add it, assign existing
   * rows to the original seller, and prefix their session ids so links and chats keep working.
   */
  private migrateToMultiSeller() {
    const hasSeller = (table: string) => (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === "seller");
    const legacy = LEGACY_SELLER.replace(/'/g, "''");
    this.db.transaction(() => {
      for (const table of ["sessions", "transcript", "leads", "guardrail_events"]) {
        if (hasSeller(table)) continue;
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN seller TEXT NOT NULL DEFAULT '${legacy}'`);
        const col = table === "sessions" ? "id" : "session_id";
        this.db.exec(`UPDATE ${table} SET ${col} = seller || ':' || ${col} WHERE instr(${col}, ':') = 0`);
      }
    })();
  }

  loadSession(id: string): StoredSession | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, any> | undefined;
    if (!row) return null;
    return {
      id: row.id,
      seller: row.seller,
      messages: JSON.parse(row.messages),
      lead: JSON.parse(row.lead),
      seenCatalogue: JSON.parse(row.seen_catalogue),
      pendingNotes: JSON.parse(row.pending_notes),
      lastQuery: row.last_query,
      turns: row.turns,
      createdAt: row.created_at,
      lastSeen: row.last_seen,
    };
  }

  saveSession(s: StoredSession) {
    this.db
      .prepare(
        `INSERT INTO sessions (id, seller, messages, lead, seen_catalogue, pending_notes, last_query, turns, created_at, last_seen)
         VALUES (@id, @seller, @messages, @lead, @seenCatalogue, @pendingNotes, @lastQuery, @turns, @createdAt, @lastSeen)
         ON CONFLICT(id) DO UPDATE SET messages = excluded.messages, lead = excluded.lead, seen_catalogue = excluded.seen_catalogue,
           pending_notes = excluded.pending_notes, last_query = excluded.last_query, turns = excluded.turns, last_seen = excluded.last_seen`,
      )
      .run({
        ...s,
        messages: JSON.stringify(s.messages),
        lead: JSON.stringify(s.lead),
        seenCatalogue: JSON.stringify(s.seenCatalogue),
        pendingNotes: JSON.stringify(s.pendingNotes),
      });
  }

  /** Deletes stored conversation state for idle sessions. Leads and transcripts are kept. */
  pruneSessions(olderThanDays = 30, now = Date.now()): number {
    return this.db.prepare("DELETE FROM sessions WHERE last_seen < ?").run(now - olderThanDays * 86_400_000).changes;
  }

  appendTranscript(line: TranscriptLine) {
    this.db
      .prepare("INSERT INTO transcript (seller, session_id, role, text, guardrails, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(line.seller, line.sessionId, line.role, line.text, line.guardrails?.length ? line.guardrails.join(",") : null, new Date().toISOString());
  }

  transcript(sessionId: string): Array<{ role: string; text: string; guardrails: string | null; at: string }> {
    return this.db.prepare("SELECT role, text, guardrails, at FROM transcript WHERE session_id = ? ORDER BY id").all(sessionId) as any[];
  }

  insertLead(lead: Lead): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO leads (created_at, seller, session_id, mobile, name, product, requirements, quantity, city, page_url)
           VALUES (@createdAt, @seller, @sessionId, @mobile, @name, @product, @requirements, @quantity, @city, @pageUrl)`,
        )
        .run({ ...lead, pageUrl: lead.pageUrl ?? null }).lastInsertRowid,
    );
  }

  listLeads(limit = 500, seller?: string): StoredLead[] {
    const rows = (
      seller
        ? this.db.prepare("SELECT * FROM leads WHERE seller = ? ORDER BY id DESC LIMIT ?").all(seller, limit)
        : this.db.prepare("SELECT * FROM leads ORDER BY id DESC LIMIT ?").all(limit)
    ) as Record<string, any>[];
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      seller: r.seller,
      sessionId: r.session_id,
      mobile: r.mobile,
      name: r.name,
      product: r.product,
      requirements: r.requirements,
      quantity: r.quantity,
      city: r.city,
      pageUrl: r.page_url ?? undefined,
    }));
  }

  /** Lead count per seller slug. */
  leadCounts(): Record<string, number> {
    const rows = this.db.prepare("SELECT seller, COUNT(*) AS n FROM leads GROUP BY seller").all() as Array<{ seller: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.seller, r.n]));
  }

  logGuardrailEvents(seller: string, sessionId: string, events: Array<{ rule: string; original: string }>) {
    const insert = this.db.prepare("INSERT INTO guardrail_events (at, seller, session_id, rule, original) VALUES (?, ?, ?, ?, ?)");
    const at = new Date().toISOString();
    this.db.transaction(() => {
      for (const e of events) insert.run(at, seller, sessionId, e.rule, e.original);
    })();
  }

  guardrailEvents(limit = 200, seller?: string): Array<{ at: string; seller: string; session_id: string; rule: string; original: string }> {
    const sql = `SELECT at, seller, session_id, rule, original FROM guardrail_events ${seller ? "WHERE seller = ?" : ""} ORDER BY id DESC LIMIT ?`;
    return (seller ? this.db.prepare(sql).all(seller, limit) : this.db.prepare(sql).all(limit)) as any[];
  }

  getPrompts(seller: string): SellerPersona & { updatedAt: string | null } {
    const row = this.db.prepare("SELECT system_persona, user_persona, updated_at FROM seller_prompts WHERE seller = ?").get(seller) as
      | { system_persona: string; user_persona: string; updated_at: string }
      | undefined;
    return { system: row?.system_persona ?? "", user: row?.user_persona ?? "", updatedAt: row?.updated_at ?? null };
  }

  /** Saving two empty prompts removes the seller's row. */
  savePrompts(seller: string, p: SellerPersona) {
    if (!p.system.trim() && !p.user.trim()) {
      this.db.prepare("DELETE FROM seller_prompts WHERE seller = ?").run(seller);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO seller_prompts (seller, system_persona, user_persona, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(seller) DO UPDATE SET system_persona = excluded.system_persona, user_persona = excluded.user_persona, updated_at = excluded.updated_at`,
      )
      .run(seller, p.system, p.user, new Date().toISOString());
  }

  close() {
    this.db.close();
  }
}
