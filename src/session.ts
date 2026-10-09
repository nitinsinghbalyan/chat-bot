import type Anthropic from "@anthropic-ai/sdk";
import type { CatalogueEntry } from "./crawler.js";

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

export class SessionStore {
  private sessions = new Map<string, Session>();

  constructor(private ttlMs = TTL_MS) {
    setInterval(() => this.sweep(), 10 * 60 * 1000).unref();
  }

  get(id: string): Session {
    let s = this.sessions.get(id);
    if (!s || Date.now() - s.lastSeen > this.ttlMs) {
      if (this.sessions.size >= MAX_SESSIONS) this.sweep(true);
      s = {
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
      this.sessions.set(id, s);
    }
    s.lastSeen = Date.now();
    return s;
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
