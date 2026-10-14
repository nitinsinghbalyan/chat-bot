/** Tiny HTML helpers: every interpolated value goes through `esc` unless it is already-built markup. */

export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Only http(s) URLs may go into href/src attributes. */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

export interface LayoutOptions {
  title: string;
  body: string;
  /** Original page on the seller's site, so search engines credit the seller, not this copy. */
  canonical?: string | null;
  noindex?: boolean;
  /** Brand colour for this page. */
  color?: string;
  description?: string;
  /** Widget <script> tag attributes; omit to not load the chat widget. */
  widget?: Record<string, string>;
}

export function layout(o: LayoutOptions): string {
  const canonical = safeUrl(o.canonical);
  const widgetAttrs = o.widget
    ? Object.entries(o.widget)
        .map(([k, v]) => ` ${k}="${esc(v)}"`)
        .join("")
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
${o.description ? `<meta name="description" content="${esc(o.description.slice(0, 160))}">` : ""}
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ""}
${o.noindex ? '<meta name="robots" content="noindex, follow">' : ""}
<meta name="referrer" content="no-referrer">
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/site.css">
<style>:root{--brand:${/^#[0-9a-fA-F]{6}$/.test(o.color ?? "") ? o.color : "#0b5cad"}}</style>
</head>
<body>
${o.body}
${o.widget ? `<script src="/widget.js" defer${widgetAttrs}></script>` : ""}
</body>
</html>`;
}
