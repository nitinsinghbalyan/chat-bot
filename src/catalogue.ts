import fs from "node:fs";
import MiniSearch from "minisearch";
import { slugFromUrl, type CatalogueEntry, type PageLink } from "./crawler.js";

interface IndexedEntry extends CatalogueEntry {
  id: number;
  specsText: string;
}

/** Fills fields added after a catalogue file was written, so older files keep loading. */
function normalize(e: Partial<CatalogueEntry> & { url: string; related_links?: string[] }): CatalogueEntry {
  return {
    url: e.url,
    kind: e.kind === "category" ? "category" : "product",
    slug: e.slug || slugFromUrl(e.url),
    title: e.title ?? "",
    category: e.category ?? "",
    price_text: e.price_text ?? null,
    specs: e.specs ?? {},
    description: e.description ?? "",
    image: e.image ?? null,
    images: e.images?.length ? e.images : e.image ? [e.image] : [],
    details: e.details ?? "",
    features: e.features ?? [],
    videos: e.videos ?? [],
    documents: e.documents ?? [],
    breadcrumbs: e.breadcrumbs ?? [],
    products: e.products ?? (e.related_links ?? []).map((url) => ({ url, title: "" })),
  };
}

export class Catalogue {
  private index: MiniSearch<IndexedEntry>;
  private entries: IndexedEntry[] = [];
  private byUrl = new Map<string, IndexedEntry>();
  /** When the catalogue was last loaded from a crawl (or file), for the directory and admin pages. */
  updatedAt: Date | null = null;

  constructor(entries: CatalogueEntry[] = [], updatedAt: Date | null = null) {
    this.index = Catalogue.createIndex();
    this.load(entries, updatedAt);
  }

  private static createIndex() {
    return new MiniSearch<IndexedEntry>({
      fields: ["title", "category", "specsText", "description"],
      storeFields: ["id"],
      searchOptions: { boost: { title: 3, category: 2 }, fuzzy: 0.2, prefix: true, combineWith: "OR" },
    });
  }

  /** Loads the first non-empty catalogue file from `files` (runtime crawl first, then the bundled one). */
  static fromDisk(files: string[]): Catalogue {
    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      const entries = JSON.parse(fs.readFileSync(file, "utf8")) as CatalogueEntry[];
      if (entries.length) return new Catalogue(entries, fs.statSync(file).mtime);
    }
    return new Catalogue();
  }

  load(entries: CatalogueEntry[], updatedAt: Date | null = new Date()) {
    this.index = Catalogue.createIndex();
    this.entries = entries.map((raw, id) => {
      const e = normalize(raw);
      return {
        ...e,
        id,
        specsText: Object.entries(e.specs)
          .map(([k, v]) => `${k} ${v}`)
          .join(" "),
      };
    });
    this.byUrl = new Map(this.entries.map((e) => [e.url, e]));
    this.index.addAll(this.entries);
    this.updatedAt = entries.length ? updatedAt : null;
  }

  get size() {
    return this.entries.length;
  }

  private strip(e: IndexedEntry): CatalogueEntry {
    const { id: _id, specsText: _s, ...entry } = e;
    return entry;
  }

  search(query: string, k = 4): CatalogueEntry[] {
    if (!query.trim() || this.entries.length === 0) return [];
    const hits = this.index.search(query);
    if (hits.length === 0) return [];
    // Drop weak matches relative to the best one so unrelated pages don't leak in.
    const best = hits[0].score;
    return hits
      .filter((h) => h.score >= best * 0.35)
      .slice(0, k)
      .map((h) => this.strip(this.entries[h.id as number]));
  }

  /** All catalogue URLs (Guardrail 3: only these and business card links may be shared). */
  urls(): string[] {
    return this.entries.map((e) => e.url);
  }

  list(kind?: CatalogueEntry["kind"]): CatalogueEntry[] {
    return this.entries.filter((e) => !kind || e.kind === kind).map((e) => this.strip(e));
  }

  get(kind: CatalogueEntry["kind"], slug: string): CatalogueEntry | null {
    const e = this.entries.find((x) => x.kind === kind && x.slug === slug);
    return e ? this.strip(e) : null;
  }

  byPageUrl(url: string): CatalogueEntry | null {
    const e = this.byUrl.get(url);
    return e ? this.strip(e) : null;
  }

  /** Products listed on a category page, resolved to full catalogue entries where crawled. */
  productsIn(category: CatalogueEntry): Array<CatalogueEntry | (PageLink & { slug: string })> {
    return category.products.map((p) => this.byPageUrl(p.url) ?? { ...p, slug: slugFromUrl(p.url) });
  }

  /** The category page a product belongs to: via breadcrumbs, else the first category listing it. */
  categoryOf(product: CatalogueEntry): CatalogueEntry | null {
    for (const crumb of [...product.breadcrumbs].reverse()) {
      const c = this.byPageUrl(crumb.url);
      if (c?.kind === "category") return c;
    }
    const c = this.entries.find((e) => e.kind === "category" && e.products.some((p) => p.url === product.url));
    return c ? this.strip(c) : null;
  }
}

export function formatCatalogueHits(hits: CatalogueEntry[]): string {
  if (hits.length === 0) return "No matching catalogue entry.";
  return hits
    .map((h, i) => {
      const lines = [`[${i + 1}] ${h.title}`, `Link: ${h.url}`, `Type: ${h.kind}${h.category ? ` | Category: ${h.category}` : ""}`];
      // Guardrail 1: prices are never shown to the model; our team confirms them.
      lines.push("Price: confirmed by our team on enquiry");
      const specs = Object.entries(h.specs);
      if (specs.length) lines.push(`Specifications: ${specs.map(([k, v]) => `${k}: ${v}`).join("; ")}`);
      if (h.kind === "category" && h.products.length) lines.push(`Products on this page: ${h.products.map((p) => p.title).filter(Boolean).slice(0, 12).join("; ")}`);
      if (h.features.length) lines.push(`Features: ${h.features.slice(0, 8).join("; ")}`);
      if (h.description) lines.push(`Description: ${h.description}`);
      return lines.join("\n");
    })
    .join("\n\n");
}
