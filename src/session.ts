import type Anthropic from "@anthropic-ai/sdk";
import type { CatalogueEntry } from "./crawler.js";
import type { ChatDb, StoredSession } from "./db.js";

export type LeadStage = "none" | "otp_sent" | "verified" | "captured" | "locked";

export interface LeadState {
  stage: LeadStage;
  mobile?: string;
  name?: string;
  otpAttempts: number;
  otpSends: number;
}

export interface Session {
  id: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  lead: LeadState;
  /** Catalogue entries retrieved over the whole conversation (price/link whitelist for output guardrails). */
  seenCatalogue: Map<string, CatalogueEntry>;
  /** Guardrail corrections to tell the model about on the next turn. */
  pendingNotes: string[];
  lastQuery: string;
  createdAt: number;
  lastSeen: number;
  turns: number;
}

const TTL_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = 5000;

function newSession(id: string): Session {
  return {
    id,
    messages: [],
    lead: { stage: "none", otpAttempts: 0, otpSends: 0 },
    seenCatalogue: new Map(),
    pendingNotes: [],
    lastQuery: "",
    createdAt: Date.now(),
    lastSeen: Date.now(),
    turns: 0,
  };
}

function fromStored(s: StoredSession): Session {
  return {
    id: s.id,
    messages: s.messages as Session["messages"],
    lead: s.lead as LeadState,
    seenCatalogue: new Map(s.seenCatalogue as Array<[string, CatalogueEntry]>),
    pendingNotes: s.pendingNotes,
    lastQuery: s.lastQuery,
    createdAt: s.createdAt,
    lastSeen: s.lastSeen,
    turns: s.turns,
  };
}

/**
 * Keeps recent sessions in memory. With a database it is write-through: sessions are loaded on a
 * cache miss and persisted by `save()`, so chats survive restarts and redeploys.
 */
export class SessionStore {
  private sessions = new Map<string, Session>();

  constructor(
    private db?: ChatDb,
    private ttlMs = TTL_MS,
  ) {
    setInterval(() => this.sweep(), 10 * 60 * 1000).unref();
  }

  get(id: string): Session {
    let s = this.sessions.get(id);
    if (!s) {
      const stored = this.db?.loadSession(id);
      if (stored) s = fromStored(stored);
    }
    if (!s || Date.now() - s.lastSeen > this.ttlMs) s = newSession(id);
    if (!this.sessions.has(id)) {
      if (this.sessions.size >= MAX_SESSIONS) this.sweep(true);
    }
    this.sessions.set(id, s);
    s.lastSeen = Date.now();
    return s;
  }

  save(s: Session) {
    this.db?.saveSession({
      id: s.id,
      messages: s.messages,
      lead: s.lead,
      seenCatalogue: [...s.seenCatalogue.entries()],
      pendingNotes: s.pendingNotes,
      lastQuery: s.lastQuery,
      turns: s.turns,
      createdAt: s.createdAt,
      lastSeen: s.lastSeen,
    });
  }

  private sweep(force = false) {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastSeen > this.ttlMs) this.sessions.delete(id);
    }
    if (force && this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastSeen - b.lastSeen).slice(0, MAX_SESSIONS / 10);
      for (const s of oldest) this.sessions.delete(s.id);
    }
  }
}
