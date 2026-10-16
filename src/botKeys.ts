/**
 * Simulator API keys: one or more per seller, generated on /admin. Only a key's sha256 hash is
 * stored, so a key is shown once when it is generated and can't be read back later.
 */
import { createHash, randomBytes } from "node:crypto";

const KEY_RE = /^sa_live_[0-9a-f]{32}$/;

export const hashBotKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** A new key, its hash (to store) and the prefix shown in admin to tell keys apart. */
export function generateBotKey(): { key: string; hash: string; prefix: string } {
  const key = `sa_live_${randomBytes(16).toString("hex")}`;
  return { key, hash: hashBotKey(key), prefix: key.slice(0, 14) };
}

/** Whether a header value has the shape of a key (checked before any database lookup). */
export const looksLikeBotKey = (v: unknown): v is string => typeof v === "string" && KEY_RE.test(v);
