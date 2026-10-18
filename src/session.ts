import { randomUUID } from "node:crypto";
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
  /** True once the buyer has been shown the enquiry summary card. */
  summarized?: boolean;
  /** The machine category the chat is about (KB JSON sellers), set by the server each turn. */
  category?: string;
  /** The MCAT within that category (the buyer's product's, else the category's main one). */
  mcatId?: string;
  /** That category's ISQs already asked (by question). */
  askedIsqs?: string[];
  /** The reply buttons last shown, so a tapped answer isn't mistaken for a new machine. */
  lastOptions?: string[];
  /** A simulated chat (the simulator API): its lead is saved as a test lead. */
  test?: boolean;
}

/** Running totals for one chat: every Claude call's tokens and cost, for the Langfuse chat cost score. */
export interface ChatUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  /** Buyer messages counted. */
  turns: number;
  /** False once a call used a model without a known price, so costUsd is a lower bound. */
  costKnown: boolean;
}

export const emptyUsage = (): ChatUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, turns: 0, costKnown: true });

export interface Session {
  /** "<seller>:<browser session id>", so one browser chatting with two sellers has two chats. */
  id: string;
  seller: string;
  /**
   * This conversation's own id. The browser id in `id` outlives a chat (after 2 hours idle or
   * New chat a new conversation starts), so traces, transcripts and leads are grouped by this.
   */
  chatId: string;
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
  usage: ChatUsage;
}

const TTL_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = 5000;

/** The Langfuse session id of a conversation: unique per chat, readable per seller. */
export const chatSessionId = (s: Pick<Session, "seller" | "chatId">) => `${s.seller}:${s.chatId}`;

export function sessionKey(seller: string, sessionId: string): string {
  return `${seller}:${sessionId}`;
}

function newSession(id: string, seller: string): Session {
  return {
    id,
    seller,
    chatId: randomUUID(),
    messages: [],
    lead: { stage: "none", otpAttempts: 0, otpSends: 0 },
    seenCatalogue: new Map(),
    pendingNotes: [],
    lastQuery: "",
    createdAt: Date.now(),
    lastSeen: Date.now(),
    turns: 0,
    usage: emptyUsage(),
  };
}

function fromStored(s: StoredSession): Session {
  return {
    id: s.id,
    seller: s.seller,
    chatId: s.chatId ?? randomUUID(),
    messages: s.messages as Session["messages"],
    lead: s.lead as LeadState,
    seenCatalogue: new Map(s.seenCatalogue as Array<[string, CatalogueEntry]>),
    pendingNotes: s.pendingNotes,
    lastQuery: s.lastQuery,
    createdAt: s.createdAt,
    lastSeen: s.lastSeen,
    turns: s.turns,
    usage: { ...emptyUsage(), ...(s.usage as Partial<ChatUsage> | undefined) },
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

  get(seller: string, sessionId: string): Session {
    const id = sessionKey(seller, sessionId);
    let s = this.sessions.get(id);
    if (!s) {
      const stored = this.db?.loadSession(id);
      if (stored) s = fromStored(stored);
    }
    if (!s || Date.now() - s.lastSeen > this.ttlMs) s = newSession(id, seller);
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
      seller: s.seller,
      messages: s.messages,
      lead: s.lead,
      seenCatalogue: [...s.seenCatalogue.entries()],
      pendingNotes: s.pendingNotes,
      lastQuery: s.lastQuery,
      turns: s.turns,
      createdAt: s.createdAt,
      lastSeen: s.lastSeen,
      usage: s.usage,
      chatId: s.chatId,
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
