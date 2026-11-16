/**
 * Imports a simulator run folder (turns.jsonl, and conversations.jsonl when there is one) into the
 * chats log, for runs made before the log existed. Each simulated chat becomes one test chat with
 * its turns; chats already imported are skipped, so importing twice changes nothing.
 */
import crypto from "node:crypto";
import type { ChatDb } from "./db.js";

interface ImportedTurn {
  runId: string;
  seller: string;
  scenarioId: string;
  attempt: number;
  turn: number;
  language?: string;
  suite?: string;
  focus?: string;
  buyer: string;
  reply: string;
  chips?: string[];
  leadStage?: string;
  summary?: boolean;
  traceId?: string | null;
  calls?: Array<{ kind: string; inputTokens?: number; outputTokens?: number; cacheRead?: number; cacheWrite?: number; costUsd?: number | null }>;
  product?: { used?: string | null } & Record<string, unknown>;
  at?: string;
}

export interface ImportResult {
  chats: number;
  turns: number;
  skipped: number;
  /** Lines that weren't a simulator turn (or belonged to another seller). */
  ignored: number;
}

const parseJsonl = (text: string): unknown[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    });

const isTurn = (x: any): x is ImportedTurn => x && typeof x.runId === "string" && typeof x.seller === "string" && typeof x.scenarioId === "string" && typeof x.turn === "number" && typeof x.buyer === "string" && typeof x.reply === "string";

/** The chat id an imported simulator chat gets (stable, so a second import finds it). */
export const importedChatId = (t: Pick<ImportedTurn, "runId" | "seller" | "scenarioId" | "attempt">) =>
  `imp_${crypto.createHash("sha1").update(`${t.runId}|${t.seller}|${t.scenarioId}|${t.attempt ?? 1}`).digest("hex").slice(0, 28)}`;

const isConversation = (x: any) => x && typeof x.stop === "string" && typeof x.scenarioId === "string" && x.turn === undefined;

/**
 * @param text turns.jsonl, optionally followed by conversations.jsonl (the two are told apart by their fields)
 * @param onlySeller when set (an import made with a seller's Test key), turns of other sellers are ignored
 * @param knownSeller whether a slug is a seller on this server
 */
export function importRun(db: ChatDb, text: string, opts: { onlySeller?: string; knownSeller: (slug: string) => boolean }): ImportResult {
  const result: ImportResult = { chats: 0, turns: 0, skipped: 0, ignored: 0 };
  const rows = parseJsonl(text);
  const conversations = rows.filter(isConversation) as any[];
  // Only finished chats count when conversations.jsonl is included (a cut-off attempt that was rerun is left out).
  const finished = conversations.length ? new Set(conversations.map((c) => `${c.seller}|${c.scenarioId}|${c.attempt ?? 1}`)) : null;
  const byChat = new Map<string, ImportedTurn[]>();
  for (const row of rows) {
    if (isConversation(row)) continue;
    if (!isTurn(row) || (opts.onlySeller && row.seller !== opts.onlySeller) || !opts.knownSeller(row.seller)) {
      result.ignored++;
      continue;
    }
    const key = `${row.seller}|${row.scenarioId}|${row.attempt ?? 1}`;
    if (finished && !finished.has(key)) {
      result.ignored++;
      continue;
    }
    byChat.set(key, [...(byChat.get(key) ?? []), row]);
  }
  for (const turns of byChat.values()) {
    const first = turns[0]!;
    const chatId = importedChatId(first);
    if (db.hasChat(chatId)) {
      result.skipped++;
      continue;
    }
    turns.sort((a, b) => a.turn - b.turn);
    for (const t of turns) {
      const calls = t.calls ?? [];
      const replies = calls.filter((c) => c.kind === "reply");
      db.recordTurn({
        chatId,
        seller: t.seller,
        sessionId: `${t.seller}:${chatId}`,
        source: "test",
        meta: { runId: t.runId, scenarioId: t.scenarioId, label: t.suite || undefined, language: t.language || undefined, expectedProduct: t.focus || undefined },
        leadStage: t.leadStage ?? null,
        product: (t.product?.used as string | null | undefined) ?? null,
        at: t.at,
        traceId: t.traceId ?? null,
        buyer: t.buyer,
        reply: t.reply,
        chips: t.chips ?? [],
        // Simulator files keep only whether the summary card was shown, not its rows.
        summary: t.summary ? { rows: [], note: "Summary card shown (imported run: its rows were not kept)" } : undefined,
        calls,
        picks: t.product ?? {},
        costUsd: calls.reduce((a, c) => a + (c.costUsd ?? 0), 0),
        inputTokens: replies.reduce((a, c) => a + (c.inputTokens ?? 0) + (c.cacheRead ?? 0) + (c.cacheWrite ?? 0), 0),
        outputTokens: replies.reduce((a, c) => a + (c.outputTokens ?? 0), 0),
      });
      result.turns++;
    }
    result.chats++;
  }
  return result;
}
