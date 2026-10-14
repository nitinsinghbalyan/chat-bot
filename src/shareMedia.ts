/**
 * Builds the cards for the share_media tool from the seller's uploaded KB and crawled catalogue.
 * Ids are product slugs (the last part of the product page URL), a category slug, or "company".
 */
import type { CatalogueEntry } from "./crawler.js";
import { httpUrl, videoInfo, type MediaCard, type MediaKind } from "./media.js";
import type { SellerContext } from "./sellers.js";

const MAX_CARDS = 12;
const MAX_IMAGES_PER_PRODUCT = 6;
const MAX_RELATED = 6;

export interface ShareMediaResult {
  cards: MediaCard[];
  /** What happened, for the model: what was shared and what isn't available. */
  content: string;
  isError: boolean;
}

export interface ShareMediaOptions {
  /** Origin of this platform when the buyer is on its generated site, so product cards link there. */
  siteOrigin?: string | null;
}

interface Resolved {
  title: string;
  productCard: MediaCard | null;
  images: MediaCard[];
  videos: MediaCard[];
  documents: MediaCard[];
  related: MediaCard[];
}

function crawledMedia(e: CatalogueEntry) {
  const images = (e.images.length ? e.images : e.image ? [e.image] : [])
    .map((u) => httpUrl(u))
    .filter((u): u is string => !!u)
    .map((u): MediaCard => ({ type: "image", title: e.title, url: u, thumb: u }));
  const videos: MediaCard[] = [];
  for (const v of e.videos) {
    const info = videoInfo(v.url);
    if (info && !videos.some((x) => x.url === info.url)) videos.push({ type: "video", title: v.title || `${e.title} video`, url: info.url, thumb: info.thumb, embed: info.embed });
  }
  const documents = e.documents
    .map((d) => ({ d, u: httpUrl(d.url) }))
    .filter((x): x is { d: CatalogueEntry["documents"][number]; u: string } => !!x.u)
    .map(({ d, u }): MediaCard => ({ type: "document", title: d.title || `${e.title} brochure (PDF)`, url: u }));
  return { images, videos, documents };
}

function merge(a: MediaCard[], b: MediaCard[]): MediaCard[] {
  const out = [...a];
  for (const c of b) if (!out.some((o) => o.url === c.url)) out.push(c);
  return out;
}

export function shareMedia(seller: SellerContext, ids: string[], kinds: MediaKind[], includeRelated: boolean, opts: ShareMediaOptions = {}): ShareMediaResult {
  const view = seller.uploaded?.view ?? null;
  const slug = seller.config.slug;
  // On this platform's own site, product cards open our generated page; elsewhere, the seller's page.
  const pageFor = (productSlug: string, original: string | null) =>
    opts.siteOrigin && seller.catalogue.get("product", productSlug) ? `${opts.siteOrigin}/s/${slug}/p/${productSlug}` : original;

  const cardForCrawled = (e: CatalogueEntry): MediaCard | null => {
    const url = e.kind === "product" ? pageFor(e.slug, httpUrl(e.url)) : opts.siteOrigin ? `${opts.siteOrigin}/s/${slug}/c/${e.slug}` : httpUrl(e.url);
    return url ? { type: "product", title: e.title, url, thumb: httpUrl(e.image), subtitle: e.category || undefined } : null;
  };

  const resolve = (id: string): Resolved | null => {
    if (id === "company") {
      const m = view?.companyMedia() ?? { images: [], videos: [], documents: [] };
      return { title: seller.config.name, productCard: null, images: m.images, videos: m.videos, documents: m.documents, related: [] };
    }
    const kbProduct = view?.product(id);
    const crawled = seller.catalogue.get("product", id) ?? seller.catalogue.get("category", id);
    if (kbProduct && view) {
      const images = view.images(kbProduct);
      const fromCrawl = crawled ? crawledMedia(crawled) : { images: [], videos: [], documents: [] };
      const allImages = merge(images, fromCrawl.images);
      const url = pageFor(id, httpUrl(kbProduct.product_url));
      const category = view.categoryOf(kbProduct);
      const related = category
        ? view
            .productsIn(category)
            .filter((p) => p.product_id !== kbProduct.product_id)
            .slice(0, MAX_RELATED)
            .map((p): MediaCard | null => {
              const u = pageFor(view.slug(p), httpUrl(p.product_url));
              return u ? { type: "product", title: view.title(p), url: u, thumb: view.images(p)[0]?.thumb ?? null, subtitle: category.name } : null;
            })
            .filter((c): c is MediaCard => !!c)
        : [];
      return {
        title: view.title(kbProduct),
        productCard: url ? { type: "product", title: view.title(kbProduct), url, thumb: allImages[0]?.thumb ?? null, subtitle: category?.name } : null,
        images: allImages,
        videos: merge(view.videos(kbProduct), fromCrawl.videos),
        documents: merge(view.documents(kbProduct), fromCrawl.documents),
        related,
      };
    }
    if (crawled) {
      const m = crawledMedia(crawled);
      let related: MediaCard[] = [];
      if (crawled.kind === "category") {
        related = seller.catalogue
          .productsIn(crawled)
          .slice(0, MAX_RELATED)
          .map((p) => ("kind" in p ? cardForCrawled(p) : httpUrl(p.url) ? { type: "product" as const, title: p.title, url: httpUrl(p.url)!, thumb: httpUrl(p.image) } : null))
          .filter((c): c is MediaCard => !!c);
      } else {
        const cat = seller.catalogue.categoryOf(crawled);
        if (cat) {
          related = seller.catalogue
            .productsIn(cat)
            .filter((p) => p.url !== crawled.url && "kind" in p)
            .slice(0, MAX_RELATED)
            .map((p) => cardForCrawled(p as CatalogueEntry))
            .filter((c): c is MediaCard => !!c);
        }
      }
      return { title: crawled.title, productCard: cardForCrawled(crawled), ...m, related };
    }
    return null;
  };

  const cards: MediaCard[] = [];
  const add = (list: MediaCard[]) => {
    for (const c of list) if (cards.length < MAX_CARDS && !cards.some((x) => x.url === c.url && x.type === c.type)) cards.push(c);
  };
  const notes: string[] = [];
  const unknown: string[] = [];
  const want = new Set(kinds);

  for (const id of [...new Set(ids)]) {
    const r = resolve(id);
    if (!r) {
      unknown.push(id);
      continue;
    }
    const shared: string[] = [];
    const missing: string[] = [];
    const take = (kind: MediaKind, list: MediaCard[], label: string, max = MAX_CARDS) => {
      if (!want.has(kind)) return;
      if (list.length) {
        const before = cards.length;
        add(list.slice(0, max));
        const n = cards.length - before;
        if (n) shared.push(`${n} ${label}${n === 1 ? "" : "s"}`);
      } else missing.push(label);
    };
    if (want.has("product") && r.productCard) add([r.productCard]);
    take("image", r.images, "photo", MAX_IMAGES_PER_PRODUCT);
    take("video", r.videos, "video");
    take("document", r.documents, "brochure");
    if (includeRelated) {
      const before = cards.length;
      add(r.related);
      const n = cards.length - before;
      if (n) shared.push(`${n} related product${n === 1 ? "" : "s"}`);
      else missing.push("related product");
    }
    if (want.has("product") && r.productCard) shared.unshift("its product card");
    notes.push(
      `${r.title}: ${shared.length ? `shared ${shared.join(", ")}` : "nothing shared"}${missing.length ? `. Not available: ${missing.map((m) => `${m}s`).join(", ")}` : ""}.`,
    );
  }
  if (unknown.length) notes.push(`Unknown id${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Use the ids from the PRODUCT CARDS or the SELLER CATALOGUE, or "company".`);
  if (cards.length >= MAX_CARDS) notes.push(`Stopped at ${MAX_CARDS} cards.`);
  const content = cards.length
    ? `${notes.join(" ")} The buyer now sees these as cards in the chat. Write one short sentence about them; do not paste their links.`
    : `${notes.join(" ")} Nothing was shown to the buyer.`;
  return { cards, content, isError: cards.length === 0 };
}
