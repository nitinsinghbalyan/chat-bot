/**
 * Server-rendered pages: the seller directory and each seller's mini-website, built from the
 * crawled catalogue (the same data the bot answers from) and the seller's business card.
 */
import type { CatalogueEntry } from "../crawler.js";
import { titleFromSlug } from "../crawler.js";
import type { SellerContext } from "../sellers.js";
import { esc, layout, safeUrl } from "./html.js";

type ProductLike = CatalogueEntry | { url: string; title: string; slug: string };

const isEntry = (p: ProductLike): p is CatalogueEntry => "kind" in p;

function widgetFor(seller: SellerContext): Record<string, string> {
  return { "data-seller": seller.config.slug };
}

function relative(date: Date | null): string {
  if (!date) return "not crawled yet";
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 2) return "just now";
  if (mins < 120) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** "Starting price ₹4,50,000 / Piece", worded as Guardrail 1 requires. */
export function startingPrice(price: string | null): string {
  return price ? `Starting price ${price.replace(/^(?:starting\s+(?:price|from)\s*)/i, "")}` : "";
}

function image(src: string | null, alt: string, cls = ""): string {
  const url = safeUrl(src);
  if (!url) return `<div class="img placeholder ${cls}" aria-hidden="true"></div>`;
  return `<img class="img ${cls}" src="${esc(url)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'img placeholder ${cls}'}))">`;
}

function chatButton(seller: SellerContext, label: string, message?: string, cls = "btn"): string {
  const payload = JSON.stringify(message ? { message } : {});
  return `<button type="button" class="${cls}" data-chat-open="${esc(seller.config.slug)}" data-chat-options="${esc(payload)}">${esc(label)}</button>`;
}

const CHAT_BUTTON_SCRIPT = `<script>
document.addEventListener("click", function (e) {
  var b = e.target.closest && e.target.closest("[data-chat-open]");
  if (!b) return;
  var opts = {};
  try { opts = JSON.parse(b.getAttribute("data-chat-options") || "{}"); } catch (_) {}
  (function go(tries) {
    if (window.SellerChat) window.SellerChat.open(b.getAttribute("data-chat-open"), opts);
    else if (tries < 50) setTimeout(function () { go(tries + 1); }, 100);
  })(0);
});
</script>`;

function header(seller: SellerContext): string {
  const cats = seller.catalogue.list("category").slice(0, 8);
  const logo = safeUrl(seller.config.logoUrl);
  return `<header class="top">
  <div class="wrap top-row">
    <a class="brand" href="/s/${esc(seller.config.slug)}/">${logo ? `<img src="${esc(logo)}" alt="" referrerpolicy="no-referrer">` : ""}<span>${esc(seller.config.name)}</span></a>
    <form class="search" action="/s/${esc(seller.config.slug)}/search" method="get" role="search">
      <input name="q" placeholder="Search products" aria-label="Search products">
    </form>
  </div>
  ${cats.length ? `<nav class="wrap cats" aria-label="Categories">${cats.map((c) => `<a href="/s/${esc(seller.config.slug)}/c/${esc(c.slug)}">${esc(c.title)}</a>`).join("")}</nav>` : ""}
</header>`;
}

function footer(seller: SellerContext): string {
  const bc = seller.kb.businessCard;
  return `<footer class="foot">
  <div class="wrap">
    <strong>${esc(bc.name)}</strong>${bc.location ? ` · ${esc(bc.location)}` : ""}
    <div class="muted">This page is generated from <a href="${esc(safeUrl(seller.config.siteUrl) ?? "#")}" rel="noopener">${esc(new URL(seller.config.siteUrl).hostname)}</a>. Product details and prices are indicative; our team confirms the final quote.</div>
    <div class="muted"><a href="/">All sellers</a></div>
  </div>
</footer>`;
}

function productCard(seller: SellerContext, p: ProductLike): string {
  // Products that were listed on a category page but not crawled themselves link to the original page.
  const href = isEntry(p) ? `/s/${esc(seller.config.slug)}/p/${esc(p.slug)}` : esc(safeUrl(p.url) ?? "#");
  const title = p.title || titleFromSlug(p.slug);
  return `<a class="card product" href="${href}"${isEntry(p) ? "" : ' rel="noopener"'}>
  ${image(isEntry(p) ? p.image : null, title)}
  <div class="card-body"><div class="card-title">${esc(title)}</div>${isEntry(p) && p.price_text ? `<div class="price">${esc(startingPrice(p.price_text))}</div>` : ""}</div>
</a>`;
}

function grid(items: string[]): string {
  return `<div class="grid">${items.join("")}</div>`;
}

function contactBlock(seller: SellerContext): string {
  const phone = seller.kb.businessCard.listed_contact;
  return `<section class="contact">
  <div><h2>Talk to ${esc(seller.config.name)}</h2><p class="muted">Ask our assistant about machines, options and prices, or send an enquiry and our team will call you back.</p></div>
  <div class="contact-actions">
    ${chatButton(seller, "Send an enquiry", "I'd like to send an enquiry.")}
    ${phone ? `<a class="btn ghost" href="tel:${esc(String(phone).replace(/[^\d+]/g, ""))}">Call ${esc(phone)}</a>` : ""}
  </div>
</section>`;
}

// ---------------------------------------------------------------------------

export function directoryPage(sellers: SellerContext[]): string {
  const cards = sellers.map((s) => {
    const bc = s.kb.businessCard;
    const products = s.catalogue.list("product").length;
    const categories = s.catalogue.list("category").length;
    const searchText = [s.config.name, bc.location, ...(bc.deals_in ?? [])].join(" ").toLowerCase();
    return `<article class="card seller" data-search="${esc(searchText)}" style="--brand:${esc(s.config.color)}">
  <div class="card-body">
    <h2 class="card-title">${esc(s.config.name)}</h2>
    <div class="muted">${esc([bc.nature?.join(", "), bc.location?.split("(")[0].trim()].filter(Boolean).join(" · "))}</div>
    <div class="stats"><span><b>${categories}</b> categories</span><span><b>${products}</b> products</span><span><b>${s.kb.productCards.length}</b> product cards</span></div>
    <div class="muted small">${s.catalogue.updatedAt ? `Catalogue updated ${esc(relative(s.catalogue.updatedAt))}` : "Catalogue not crawled yet"} · ${s.sitemapPages} page${s.sitemapPages === 1 ? "" : "s"} in sitemap</div>
    ${bc.deals_in?.length ? `<div class="tags">${bc.deals_in.slice(0, 6).map((d) => `<span class="tag">${esc(d)}</span>`).join("")}${bc.deals_in.length > 6 ? `<span class="tag muted">+${bc.deals_in.length - 6} more</span>` : ""}</div>` : ""}
  </div>
  <div class="card-actions">
    <a class="btn ghost" href="/s/${esc(s.config.slug)}/">Visit site</a>
    ${chatButton(s, "Chat")}
  </div>
</article>`;
  });
  const body = `<header class="top"><div class="wrap top-row"><span class="brand"><span>Seller assistants</span></span>
<input id="filter" class="filter" type="search" placeholder="Filter sellers" aria-label="Filter sellers"></div></header>
<main class="wrap">
  <h1>Sellers</h1>
  <p class="muted">${sellers.length} seller${sellers.length === 1 ? "" : "s"}. Open a seller's site, or chat with their assistant right here.</p>
  ${sellers.length ? `<div class="grid sellers" id="sellers">${cards.join("")}</div>` : `<p>No sellers yet. Add a folder under <code>kb/sellers/</code>.</p>`}
</main>
<script>
document.getElementById("filter").addEventListener("input", function (e) {
  var q = e.target.value.toLowerCase().trim();
  document.querySelectorAll("#sellers .seller").forEach(function (c) { c.hidden = q && c.getAttribute("data-search").indexOf(q) < 0; });
});
</script>
${CHAT_BUTTON_SCRIPT}`;
  // The widget loads without a default seller; "Chat" picks one.
  return layout({ title: "Seller assistants", body, widget: {} });
}

export function sellerHomePage(seller: SellerContext): string {
  const bc = seller.kb.businessCard;
  const categories = seller.catalogue.list("category");
  const products = seller.catalogue.list("product");
  const crawled = seller.catalogue.size > 0;
  const body = `${header(seller)}
<main class="wrap">
  <section class="hero">
    <div>
      <h1>${esc(bc.name)}</h1>
      <p class="muted">${esc([bc.nature?.join(", "), bc.location].filter(Boolean).join(" · "))}</p>
      <div class="hero-actions">${chatButton(seller, "Chat with us")} <a class="btn ghost" href="${esc(safeUrl(seller.config.siteUrl) ?? "#")}" rel="noopener">Official website</a></div>
    </div>
  </section>
  ${bc.deals_in?.length ? `<section><h2>We deal in</h2><div class="tags">${bc.deals_in.map((d) => `<span class="tag">${esc(d)}</span>`).join("")}</div></section>` : ""}
  ${
    categories.length
      ? `<section><h2>Categories</h2>${grid(
          categories.map(
            (c) => `<a class="card product" href="/s/${esc(seller.config.slug)}/c/${esc(c.slug)}">${image(c.image, c.title)}<div class="card-body"><div class="card-title">${esc(c.title)}</div><div class="muted small">${c.products.length} products</div></div></a>`,
          ),
        )}</section>`
      : ""
  }
  ${products.length ? `<section><h2>Products</h2>${grid(products.slice(0, 24).map((p) => productCard(seller, p)))}</section>` : ""}
  ${
    !crawled
      ? `<section class="notice"><h2>Our machines</h2><p>${seller.kb.productCards.map((c) => esc(c.canonical_name)).join(" · ")}</p><p class="muted">The full catalogue appears here once our website has been crawled. Meanwhile, ask our assistant anything.</p></section>`
      : ""
  }
  ${contactBlock(seller)}
</main>
${footer(seller)}
${CHAT_BUTTON_SCRIPT}`;
  return layout({
    title: bc.name,
    body,
    canonical: seller.config.siteUrl,
    noindex: true,
    color: seller.config.color,
    description: `${bc.name}: ${(bc.deals_in ?? []).slice(0, 8).join(", ")}`,
    widget: widgetFor(seller),
  });
}

function breadcrumbs(seller: SellerContext, trail: Array<{ title: string; href?: string }>): string {
  const items = [{ title: "Home", href: `/s/${seller.config.slug}/` }, ...trail];
  return `<nav class="crumbs" aria-label="Breadcrumb">${items.map((c) => (c.href ? `<a href="${esc(c.href)}">${esc(c.title)}</a>` : `<span>${esc(c.title)}</span>`)).join(" › ")}</nav>`;
}

export function categoryPage(seller: SellerContext, category: CatalogueEntry): string {
  const products = seller.catalogue.productsIn(category);
  const body = `${header(seller)}
<main class="wrap">
  ${breadcrumbs(seller, [{ title: category.title }])}
  <section class="detail">
    ${image(category.image, category.title, "detail-img")}
    <div>
      <h1>${esc(category.title)}</h1>
      ${category.description ? `<p>${esc(category.description)}</p>` : ""}
      <div class="hero-actions">${chatButton(seller, "Ask about these machines", `I'm interested in ${category.title}.`)}</div>
    </div>
  </section>
  ${products.length ? `<section><h2>${products.length} products</h2>${grid(products.map((p) => productCard(seller, p)))}</section>` : '<p class="muted">No products listed on this page.</p>'}
  ${contactBlock(seller)}
</main>
${footer(seller)}
${CHAT_BUTTON_SCRIPT}`;
  return layout({ title: `${category.title} | ${seller.config.name}`, body, canonical: category.url, noindex: true, color: seller.config.color, description: category.description, widget: widgetFor(seller) });
}

export function productPage(seller: SellerContext, product: CatalogueEntry): string {
  const category = seller.catalogue.categoryOf(product);
  const specs = Object.entries(product.specs);
  const siblings = category
    ? seller.catalogue
        .productsIn(category)
        .filter((p) => p.url !== product.url)
        .slice(0, 8)
    : [];
  const body = `${header(seller)}
<main class="wrap">
  ${breadcrumbs(seller, [...(category ? [{ title: category.title, href: `/s/${seller.config.slug}/c/${category.slug}` }] : []), { title: product.title }])}
  <section class="detail">
    ${image(product.image, product.title, "detail-img")}
    <div>
      <h1>${esc(product.title)}</h1>
      ${product.price_text ? `<div class="price big">${esc(startingPrice(product.price_text))}</div><p class="muted small">Indicative starting price. The final price depends on the configuration; our team shares a formal quote.</p>` : '<p class="muted">Price on request: ask our assistant for a quote.</p>'}
      <div class="hero-actions">
        ${chatButton(seller, "Ask about this product", `I'm interested in the ${product.title}. Can you tell me more?`)}
        <a class="btn ghost" href="${esc(safeUrl(product.url) ?? "#")}" rel="noopener">View on official site</a>
      </div>
      ${specs.length ? `<table class="specs"><tbody>${specs.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</tbody></table>` : ""}
      ${product.description ? `<p>${esc(product.description)}</p>` : ""}
    </div>
  </section>
  ${siblings.length ? `<section><h2>More in ${esc(category!.title)}</h2>${grid(siblings.map((p) => productCard(seller, p)))}</section>` : ""}
  ${contactBlock(seller)}
</main>
${footer(seller)}
${CHAT_BUTTON_SCRIPT}`;
  return layout({ title: `${product.title} | ${seller.config.name}`, body, canonical: product.url, noindex: true, color: seller.config.color, description: product.description, widget: widgetFor(seller) });
}

export function searchPage(seller: SellerContext, query: string): string {
  const results = query.trim() ? seller.catalogue.search(query, 30) : [];
  const body = `${header(seller)}
<main class="wrap">
  ${breadcrumbs(seller, [{ title: "Search" }])}
  <h1>${query.trim() ? `Results for “${esc(query)}”` : "Search"}</h1>
  ${
    results.length
      ? grid(
          results.map((r) =>
            r.kind === "product"
              ? productCard(seller, r)
              : `<a class="card product" href="/s/${esc(seller.config.slug)}/c/${esc(r.slug)}">${image(r.image, r.title)}<div class="card-body"><div class="card-title">${esc(r.title)}</div><div class="muted small">Category</div></div></a>`,
          ),
        )
      : `<p class="muted">${query.trim() ? "Nothing matched." : "Type what you're looking for."} Our assistant can help: ${chatButton(seller, "Ask the assistant", query.trim() ? `I'm looking for ${query.trim()}.` : undefined, "btn small")}</p>`
  }
</main>
${footer(seller)}
${CHAT_BUTTON_SCRIPT}`;
  return layout({ title: `Search | ${seller.config.name}`, body, noindex: true, color: seller.config.color, widget: widgetFor(seller) });
}

export function notFoundPage(message = "Page not found"): string {
  return layout({ title: message, body: `<main class="wrap"><h1>${esc(message)}</h1><p><a href="/">All sellers</a></p></main>`, noindex: true });
}
