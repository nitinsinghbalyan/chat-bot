/** A line diff for comparing prompt versions in admin: each line is kept, added or removed. */
export type DiffLine = { op: "same" | "add" | "del"; text: string };

/** Longest-common-subsequence line diff of `from` → `to`. Large inputs fall back to "all removed, all added". */
export function diffLines(from: string, to: string): DiffLine[] {
  const a = from.split("\n");
  const b = to.split("\n");
  if (a.length * b.length > 4_000_000) return [...a.map((text) => ({ op: "del" as const, text })), ...b.map((text) => ({ op: "add" as const, text }))];
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ op: "del", text: a[i++] });
    else out.push({ op: "add", text: b[j++] });
  }
  while (i < a.length) out.push({ op: "del", text: a[i++] });
  while (j < b.length) out.push({ op: "add", text: b[j++] });
  return out;
}
