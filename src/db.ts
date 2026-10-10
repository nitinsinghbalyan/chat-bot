import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Lead } from "./tools.js";

export interface StoredSession {
  id: string;
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

export interface TranscriptLine {
  sessionId: string;
  role: "buyer" | "bot";
  text: string;
  guardrails?: string[];
}

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
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
  session_id  TEXT NOT NULL,
  rule        TEXT NOT NULL,
  original    TEXT NOT NULL
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
  }

  loadSession(id: string): StoredSession | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, any> | undefined;
    if (!row) return null;
    return {
      id: row.id,
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
        `INSERT INTO sessions (id, messages, lead, seen_catalogue, pending_notes, last_query, turns, created_at, last_seen)
         VALUES (@id, @messages, @lead, @seenCatalogue, @pendingNotes, @lastQuery, @turns, @createdAt, @lastSeen)
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
      .prepare("INSERT INTO transcript (session_id, role, text, guardrails, at) VALUES (?, ?, ?, ?, ?)")
      .run(line.sessionId, line.role, line.text, line.guardrails?.length ? line.guardrails.join(",") : null, new Date().toISOString());
  }

  transcript(sessionId: string): Array<{ role: string; text: string; guardrails: string | null; at: string }> {
    return this.db.prepare("SELECT role, text, guardrails, at FROM transcript WHERE session_id = ? ORDER BY id").all(sessionId) as any[];
  }

  insertLead(lead: Lead): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO leads (created_at, session_id, mobile, name, product, requirements, quantity, city, page_url)
           VALUES (@createdAt, @sessionId, @mobile, @name, @product, @requirements, @quantity, @city, @pageUrl)`,
        )
        .run({ ...lead, pageUrl: lead.pageUrl ?? null }).lastInsertRowid,
    );
  }

  listLeads(limit = 500): StoredLead[] {
    const rows = this.db.prepare("SELECT * FROM leads ORDER BY id DESC LIMIT ?").all(limit) as Record<string, any>[];
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
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

  logGuardrailEvents(sessionId: string, events: Array<{ rule: string; original: string }>) {
    const insert = this.db.prepare("INSERT INTO guardrail_events (at, session_id, rule, original) VALUES (?, ?, ?, ?)");
    const at = new Date().toISOString();
    this.db.transaction(() => {
      for (const e of events) insert.run(at, sessionId, e.rule, e.original);
    })();
  }

  guardrailEvents(limit = 200): Array<{ at: string; session_id: string; rule: string; original: string }> {
    return this.db.prepare("SELECT at, session_id, rule, original FROM guardrail_events ORDER BY id DESC LIMIT ?").all(limit) as any[];
  }

  close() {
    this.db.close();
  }
}
