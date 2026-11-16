/** Minimal RFC 4180 reader: quoted fields may hold commas, quotes ("") and newlines. */
export function readCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") row.push(field), (field = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) row.push(field), rows.push(row);
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ""])));
}

/** "Turn 1: … -> Turn 2 (when asked shape): …" becomes ["…", "…"]; a plain input is one message. */
export const buyerTurns = (t: string): string[] =>
  t
    .split(/\s*->\s*/)
    .map((s) => s.replace(/^Turn\s*\d+\s*(?:\([^)]*\))?\s*:\s*/i, "").trim())
    .filter(Boolean);

/** The first number in an id: "TC-07" and "esi_tc_07_price" both give 7. */
export const numberOf = (id: string) => Number(/(\d+)/.exec(id)?.[1] ?? NaN);
