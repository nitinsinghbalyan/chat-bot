import fs from "node:fs";
import MiniSearch from "minisearch";
import { paths } from "./config.js";
import type { CatalogueEntry } from "./crawler.js";

interface IndexedEntry extends CatalogueEntry {
  id: number;
  specsText: string;
}

export class Catalogue {
  private index: MiniSearch<IndexedEntry>;
  private entries: IndexedEntry[] = [];

  constructor(entries: CatalogueEntry[] = []) {
    this.index = Catalogue.createIndex();
    this.load(entries);
  }

  private static createIndex() {
    return new MiniSearch<IndexedEntry>({
      fields: ["title", "category", "specsText", "description"],
      storeFields: ["id"],
      searchOptions: { boost: { title: 3, category: 2 }, fuzzy: 0.2, prefix: true, combineWith: "OR" },
    });
  }

  static fromDisk(file = paths.catalogue): Catalogue {
    if (!fs.existsSync(file)) return new Catalogue();
    return new Catalogue(JSON.parse(fs.readFileSync(file, "utf8")) as CatalogueEntry[]);
  }

  load(entries: CatalogueEntry[]) {
    this.index = Catalogue.createIndex();
    this.entries = entries.map((e, id) => ({
      ...e,
      id,
      specsText: Object.entries(e.specs)
        .map(([k, v]) => `${k} ${v}`)
        .join(" "),
    }));
    this.index.addAll(this.entries);
  }

  get size() {
    return this.entries.length;
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
      .map((h) => {
        const { id: _id, specsText: _s, ...entry } = this.entries[h.id as number];
        return entry;
      });
  }

  /** All catalogue URLs (Guardrail 3: only these and business card links may be shared). */
  urls(): string[] {
    return this.entries.map((e) => e.url);
  }
}

export function formatCatalogueHits(hits: CatalogueEntry[]): string {
  if (hits.length === 0) return "No matching catalogue entry.";
  return hits
    .map((h, i) => {
      const lines = [`[${i + 1}] ${h.title}`, `Link: ${h.url}`, `Type: ${h.kind}${h.category ? ` | Category: ${h.category}` : ""}`];
      lines.push(h.price_text ? `Listed starting price: ${h.price_text}` : "Listed price: none");
      const specs = Object.entries(h.specs);
      if (specs.length) lines.push(`Specifications: ${specs.map(([k, v]) => `${k}: ${v}`).join("; ")}`);
      if (h.description) lines.push(`Description: ${h.description}`);
      return lines.join("\n");
    })
    .join("\n\n");
}
