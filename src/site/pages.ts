/**
 * Server-rendered pages: the seller directory and each seller's website (home, about, products,
 * category, product, contact and search), built from the crawled catalogue (the same data the
 * bot answers from) and the seller's business card.
 */
import type { CatalogueEntry, PageLink } from "../crawler.js";
import { titleFromSlug } from "../crawler.js";
import type { SellerContext } from "../sellers.js";
import { esc, layout, safeUrl } from "./html.js";

type ProductLike = CatalogueEntry | (PageLink & { slug: string });

const isEntry = (p: ProductLike): p is CatalogueEntry => "kind" in p;

function widgetFor(seller: SellerContext): Record<string, string> {
  return { "data-seller": seller.config.slug };
}

const base = (seller: SellerContext) => `/s/${seller.config.slug}`;

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

/** "Rajkot, Gujarat, India (registered address: Nil, Plot 12 — 360021)" -> city and a tidy address. */
export function splitLocation(location: string | undefined): { city: string; address: string } {
  const loc = String(location ?? "");
  const city = loc.split("(")[0].trim();
  const m = loc.match(/registered address:\s*([^)]*)/i);
  const address = (m?.[1] ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p && !/^nil$/i.test(p))
    .join(", ");
  return { city, address };
}

function image(src: string | null | undefined, alt: string, cls = ""): string {
  const url = safeUrl(src);
  if (!url) return `<div class="img placeholder ${cls}" aria-hidden="true"></div>`;
  return `<img class="img ${cls}" src="${esc(url)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'img placeholder ${cls}'}))">`;
}

function chatButton(seller: SellerContext, label: string, message?: string, cls = "btn"): string {
  const payload = JSON.stringify(message ? { message } : {});
  return `<button type="button" class="${cls}" data-chat-open="${esc(seller.config.slug)}" data-chat-options="${esc(payload)}">${esc(label)}</button>`;
}

function telLink(phone: unknown, cls = "btn ghost"): string {
  if (!phone) return "";
  return `<a class="${cls}" href="tel:${esc(String(phone).replace(/[^\d+]/g, ""))}">Call ${esc(phone)}</a>`;
}

const PAGE_SCRIPT = `<script>
document.addEventListener("click", function (e) {
  var b = e.target.closest && e.target.closest("[data-chat-open]");
  if (b) {
    var opts = {};
    try { opts = JSON.parse(b.getAttribute("data-chat-options") || "{}"); } catch (_) {}
    (function go(tries) {
      if (window.SellerChat) window.SellerChat.open(b.getAttribute("data-chat-open"), opts);
      else if (tries < 50) setTimeout(function () { go(tries + 1); }, 100);
    })(0);
    return;
  }
  var m = e.target.closest && e.target.closest("[data-menu-toggle]");
  if (m) {
    var open = m.closest("header").classList.toggle("menu-open");
    m.setAttribute("aria-expanded", String(open));
    return;
  }
  var t = e.target.closest && e.target.closest("[data-gallery-src]");
  if (t) {
    var main = document.getElementById("gallery-main");
    if (main) main.src = t.getAttribute("data-gallery-src");
    document.querySelectorAll("[data-gallery-src]").forEach(function (x) { x.setAttribute("aria-current", x === t ? "true" : "false"); });
  }
});
</script>`;

// ---- Catalogue helpers --------------------------------------------------------------------

function categoryImage(seller: SellerContext, c: CatalogueEntry): string | null {
  if (c.image) return c.image;
  for (const p of seller.catalogue.productsIn(c)) {
    if (p.image) return p.image;
  }
  return null;
}

/** Products worth showing first: with a photo, then with a listed price. */
function featured(products: CatalogueEntry[], n: number): CatalogueEntry[] {
  const score = (p: CatalogueEntry) => (p.image ? 2 : 0) + (p.price_text ? 1 : 0) + (Object.keys(p.specs).length ? 1 : 0);
  return [...products].sort((a, b) => score(b) - score(a)).slice(0, n);
}

/** Finds the category page whose title matches a "deals in" item, so About Us can link to it. */
function categoryFor(seller: SellerContext, name: string): CatalogueEntry | null {
  const norm = (s: string) => s.toLowerCase().replace(/machines?/g, "").replace(/[^a-z]/g, "");
  const n = norm(name);
  return seller.catalogue.list("category").find((c) => norm(c.title) === n) ?? null;
}

function tagline(seller: SellerContext): string {
  const bc = seller.kb.businessCard;
  if (seller.config.tagline) return seller.config.tagline;
  const nature = bc.nature?.join(", ") || "Supplier";
  const items = (bc.deals_in ?? []).slice(0, 4).join(", ");
  const { city } = splitLocation(bc.location);
  return [items ? `${nature} of ${items}` : nature, city ? `in ${city}` : ""].filter(Boolean).join(" ");
}

function aboutParagraphs(seller: SellerContext): string[] {
  if (seller.config.about) return seller.config.about.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const bc = seller.kb.businessCard;
  const { city } = splitLocation(bc.location);
  const nature = (bc.nature?.join(", ") || "supplier").toLowerCase();
  const first = `${bc.name} is a ${nature}${city ? ` based in ${city}` : ""}.`;
  const range = bc.deals_in?.length ? `We deal in ${bc.deals_in.slice(0, 12).join(", ")}.` : "";
  return [first, range].filter(Boolean);
}

// ---- Shared page parts --------------------------------------------------------------------

type NavKey = "home" | "about" | "products" | "contact" | "";

function header(seller: SellerContext, active: NavKey = ""): string {
  const b = base(seller);
  const cats = seller.catalogue.list("category");
  const logo = safeUrl(seller.config.logoUrl);
  const phone = seller.kb.businessCard.listed_contact;
  const link = (key: NavKey, href: string, label: string) => `<a href="${esc(href)}"${active === key ? ' aria-current="page"' : ""}>${esc(label)}</a>`;
  const productsMenu = cats.length
    ? `<div class="dropdown">${link("products", `${b}/products`, "Products")}<div class="dropdown-menu">${cats.map((c) => `<a href="${esc(`${b}/c/${c.slug}`)}">${esc(c.title)}</a>`).join("")}</div></div>`
    : link("products", `${b}/products`, "Products");
  return `<div class="topbar"><div class="wrap topbar-row"><span>${esc(tagline(seller))}</span><div class="topbar-actions">${phone ? `<a href="tel:${esc(String(phone).replace(/[^\d+]/g, ""))}">☎ ${esc(phone)}</a>` : ""}${chatButton(seller, "Get a quote", "I'd like to get a quote.", "btn light tiny")}</div></div></div>
<header class="top">
  <div class="wrap top-row">
    <a class="brand" href="${esc(`${b}/`)}">${logo ? `<img src="${esc(logo)}" alt="" referrerpolicy="no-referrer">` : `<span class="mark" aria-hidden="true">${esc(seller.config.name.charAt(0))}</span>`}<span>${esc(seller.config.name)}</span></a>
    <button type="button" class="menu-toggle" aria-label="Menu" aria-expanded="false" aria-controls="mainnav" data-menu-toggle>☰</button>
    <nav class="mainnav" id="mainnav" aria-label="Main">
      ${link("home", `${b}/`, "Home")}
      ${link("about", `${b}/about`, "About Us")}
      ${productsMenu}
      ${link("contact", `${b}/contact`, "Contact Us")}
    </nav>
    <form class="search" action="${esc(`${b}/search`)}" method="get" role="search">
      <input name="q" placeholder="Search machines" aria-label="Search products">
    </form>
  </div>
</header>`;
}

function footer(seller: SellerContext): string {
  const bc = seller.kb.businessCard;
  const b = base(seller);
  const { city, address } = splitLocation(bc.location);
  const cats = seller.catalogue.list("category").slice(0, 8);
  const site = safeUrl(seller.config.siteUrl);
  return `<footer class="foot">
  <div class="wrap foot-grid">
    <div>
      <strong>${esc(bc.name)}</strong>
      <p class="muted">${esc([bc.nature?.join(", "), city].filter(Boolean).join(" · "))}</p>
      ${address ? `<p class="muted small">${esc(address)}</p>` : ""}
      ${bc.listed_contact ? `<p><a href="tel:${esc(String(bc.listed_contact).replace(/[^\d+]/g, ""))}">☎ ${esc(bc.listed_contact)}</a></p>` : ""}
    </div>
    <div>
      <strong>Products</strong>
      <ul class="plain">${cats.length ? cats.map((c) => `<li><a href="${esc(`${b}/c/${c.slug}`)}">${esc(c.title)}</a></li>`).join("") : `<li><a href="${esc(`${b}/products`)}">All products</a></li>`}</ul>
    </div>
    <div>
      <strong>Company</strong>
      <ul class="plain">
        <li><a href="${esc(`${b}/`)}">Home</a></li>
        <li><a href="${esc(`${b}/about`)}">About Us</a></li>
        <li><a href="${esc(`${b}/products`)}">Products</a></li>
        <li><a href="${esc(`${b}/contact`)}">Contact Us</a></li>
        ${site ? `<li><a href="${esc(site)}" rel="noopener">Official website</a></li>` : ""}
      </ul>
    </div>
  </div>
  <div class="wrap muted small foot-note">Product details are taken from ${site ? `<a href="${esc(site)}" rel="noopener">${esc(new URL(site).hostname)}</a>` : "the seller's website"}. Prices are indicative starting prices; our team confirms the final quote. · <a href="/">All sellers</a></div>
</footer>`;
}

function keySpecs(p: CatalogueEntry, n: number): string {
  const specs = Object.entries(p.specs).slice(0, n);
  return specs.length ? `<ul class="keyspecs">${specs.map(([k, v]) => `<li><span>${esc(k)}</span> ${esc(v)}</li>`).join("")}</ul>` : "";
}

function productCard(seller: SellerContext, p: ProductLike): string {
  const title = p.title || titleFromSlug(p.slug);
  if (!isEntry(p)) {
    // Listed on a category page but not crawled itself: link to the original page.
    const href = esc(safeUrl(p.url) ?? "#");
    return `<article class="card product">
  <a href="${href}" rel="noopener">${image(p.image, title)}</a>
  <div class="card-body"><a class="card-title" href="${href}" rel="noopener">${esc(title)}</a><div class="muted small">Details on the official site</div></div>
  <div class="card-actions">${chatButton(seller, "Get quote", `I'd like a quote for the ${title}.`, "btn small")}</div>
</article>`;
  }
  const href = esc(`${base(seller)}/p/${p.slug}`);
  return `<article class="card product">
  <a href="${href}">${image(p.image, title)}</a>
  <div class="card-body">
    <a class="card-title" href="${href}">${esc(title)}</a>
    ${p.price_text ? `<div class="price">${esc(startingPrice(p.price_text))}</div>` : '<div class="muted small">Price on request</div>'}
    ${keySpecs(p, 3)}
  </div>
  <div class="card-actions"><a class="btn small ghost" href="${href}">View details</a>${chatButton(seller, "Get quote", `I'd like a quote for the ${title}.`, "btn small")}</div>
</article>`;
}

function categoryCard(seller: SellerContext, c: CatalogueEntry): string {
  const href = esc(`${base(seller)}/c/${c.slug}`);
  return `<a class="card category" href="${href}">${image(categoryImage(seller, c), c.title)}<div class="card-body"><div class="card-title">${esc(c.title)}</div><div class="muted small">${c.products.length ? `${c.products.length} product${c.products.length === 1 ? "" : "s"} · ` : ""}View range →</div></div></a>`;
}

const grid = (items: string[], cls = "") => `<div class="grid ${cls}">${items.join("")}</div>`;

function contactBlock(seller: SellerContext): string {
  return `<section class="contact">
  <div><h2>Looking for the right machine?</h2><p class="muted">Tell our assistant what you need. Verify your mobile number with an OTP and our team will call you back with a quote.</p></div>
  <div class="contact-actions">
    ${chatButton(seller, "Send an enquiry", "I'd like to send an enquiry.")}
    ${telLink(seller.kb.businessCard.listed_contact)}
  </div>
</section>`;
}

function breadcrumbs(seller: SellerContext, trail: Array<{ title: string; href?: string }>): string {
  const items = [{ title: "Home", href: `${base(seller)}/` }, ...trail];
  return `<nav class="crumbs" aria-label="Breadcrumb">${items.map((c) => (c.href ? `<a href="${esc(c.href)}">${esc(c.title)}</a>` : `<span aria-current="page">${esc(c.title)}</span>`)).join(" › ")}</nav>`;
}

function pageHead(title: string, subtitle?: string): string {
  return `<section class="pagehead"><div class="wrap"><h1>${esc(title)}</h1>${subtitle ? `<p>${esc(subtitle)}</p>` : ""}</div></section>`;
}

function sellerPage(seller: SellerContext, o: { title: string; active?: NavKey; main: string; canonical?: string | null; description?: string; before?: string }): string {
  const body = `${header(seller, o.active)}
${o.before ?? ""}
<main class="wrap">
${o.main}
</main>
${footer(seller)}
${PAGE_SCRIPT}`;
  return layout({
    title: o.title,
    body,
    canonical: o.canonical ?? seller.config.siteUrl,
    noindex: true,
    color: seller.config.color,
    description: o.description,
    widget: widgetFor(seller),
  });
}

/** Shown while a seller's catalogue hasn't been crawled yet: the machines from the product cards. */
function productCardTiles(seller: SellerContext): string {
  return grid(
    seller.kb.productCards.map(
      (c) => `<article class="card"><div class="card-body"><div class="card-title">${esc(c.canonical_name)}</div>${
        (c.aliases as string[] | undefined)?.length ? `<div class="muted small">${esc((c.aliases as string[]).slice(0, 4).join(" · "))}</div>` : ""
      }</div><div class="card-actions">${chatButton(seller, "Ask about this", `Tell me about your ${c.canonical_name}.`, "btn small")}</div></article>`,
    ),
  );
}

// ---- Directory ----------------------------------------------------------------------------

export function directoryPage(sellers: SellerContext[]): string {
  const cards = sellers.map((s) => {
    const bc = s.kb.businessCard;
    const products = s.catalogue.list("product").length;
    const categories = s.catalogue.list("category").length;
    const searchText = [s.config.name, bc.location, ...(bc.deals_in ?? [])].join(" ").toLowerCase();
    return `<article class="card seller" data-search="${esc(searchText)}" style="--brand:${esc(s.config.color)}">
  <div class="card-body">
    <h2 class="card-title">${esc(s.config.name)}</h2>
    <div class="muted">${esc([bc.nature?.join(", "), splitLocation(bc.location).city].filter(Boolean).join(" · "))}</div>
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
${PAGE_SCRIPT}`;
  // The widget loads without a default seller; "Chat" picks one.
  return layout({ title: "Seller assistants", body, widget: {} });
}

// ---- Seller website -----------------------------------------------------------------------

export function sellerHomePage(seller: SellerContext): string {
  const bc = seller.kb.businessCard;
  const b = base(seller);
  const categories = seller.catalogue.list("category");
  const products = seller.catalogue.list("product");
  const crawled = seller.catalogue.size > 0;
  const { city } = splitLocation(bc.location);
  const heroProduct = featured(products, 1)[0];
  const heroImage = heroProduct?.image ?? (categories[0] ? categoryImage(seller, categories[0]) : null);
  const facts = [
    bc.nature?.length ? { k: "Nature of business", v: bc.nature.join(", ") } : null,
    city ? { k: "Based in", v: city } : null,
    categories.length ? { k: "Product categories", v: String(categories.length) } : null,
    products.length ? { k: "Machines listed", v: String(products.length) } : null,
  ].filter((f): f is { k: string; v: string } => !!f);

  const hero = `<section class="hero">
  <div class="wrap hero-grid">
    <div>
      <p class="eyebrow">${esc(bc.nature?.join(", ") || "Welcome")}</p>
      <h1>${esc(bc.name)}</h1>
      <p class="lead">${esc(tagline(seller))}</p>
      <div class="hero-actions">${chatButton(seller, "Send an enquiry", "I'd like to send an enquiry.", "btn light")} <a class="btn outline-light" href="${esc(`${b}/products`)}">View our products</a></div>
    </div>
    ${heroImage ? `<div class="hero-media">${image(heroImage, heroProduct?.title ?? bc.name)}</div>` : ""}
  </div>
</section>
${facts.length ? `<section class="facts"><div class="wrap facts-row">${facts.map((f) => `<div><b>${esc(f.v)}</b><span>${esc(f.k)}</span></div>`).join("")}</div></section>` : ""}`;

  const main = `
  ${
    categories.length
      ? `<section><div class="section-head"><h2>Our product range</h2><a href="${esc(`${b}/products`)}">All products →</a></div>${grid(categories.slice(0, 12).map((c) => categoryCard(seller, c)), "cats-grid")}</section>`
      : ""
  }
  ${
    products.length
      ? `<section><div class="section-head"><h2>Featured machines</h2><a href="${esc(`${b}/products`)}">See all ${products.length} →</a></div>${grid(featured(products, 8).map((p) => productCard(seller, p)))}</section>`
      : ""
  }
  ${
    !crawled
      ? `<section><h2>Our machines</h2>${productCardTiles(seller)}<p class="muted small">The full catalogue with photos and specifications appears here once our website has been crawled. Meanwhile, ask our assistant anything.</p></section>`
      : ""
  }
  <section class="about-teaser">
    <div>
      <h2>About ${esc(seller.config.name)}</h2>
      ${aboutParagraphs(seller)
        .slice(0, 2)
        .map((p) => `<p>${esc(p)}</p>`)
        .join("")}
      <a class="btn ghost" href="${esc(`${b}/about`)}">More about us</a>
    </div>
    ${bc.deals_in?.length ? `<div><h3>We deal in</h3><div class="tags">${bc.deals_in.slice(0, 18).map((d) => `<span class="tag">${esc(d)}</span>`).join("")}</div></div>` : ""}
  </section>
  <section>
    <h2>How to get a quote</h2>
    <ol class="steps">
      <li><b>Tell us what you need</b><span>Chat with our assistant about the machine, size or capacity you're looking for.</span></li>
      <li><b>Verify your mobile</b><span>Share your mobile number and confirm it with a one-time password.</span></li>
      <li><b>Our team calls you</b><span>We'll get back to you with the right machine and a formal quote.</span></li>
    </ol>
  </section>
  ${contactBlock(seller)}`;

  return sellerPage(seller, {
    title: bc.name,
    active: "home",
    before: hero,
    main,
    description: `${bc.name}: ${(bc.deals_in ?? []).slice(0, 8).join(", ")}`,
  });
}

export function aboutPage(seller: SellerContext): string {
  const bc = seller.kb.businessCard;
  const b = base(seller);
  const { city, address } = splitLocation(bc.location);
  // Only the verified BUSINESS CARD facts (Guardrail 7): no turnover, tenure or customer counts.
  const facts: Array<[string, string]> = [
    ["Company name", bc.name],
    ...(bc.nature?.length ? [["Nature of business", bc.nature.join(", ")] as [string, string]] : []),
    ...(bc.ceo ? [["CEO", String(bc.ceo)] as [string, string]] : []),
    ...(city ? [["Location", city] as [string, string]] : []),
    ...(address ? [["Address", address] as [string, string]] : []),
    ...(bc.listed_contact ? [["Phone", String(bc.listed_contact)] as [string, string]] : []),
  ];
  const categories = seller.catalogue.list("category");
  const main = `
  ${breadcrumbs(seller, [{ title: "About Us" }])}
  <section class="two-col">
    <div class="prose">
      <h2>Who we are</h2>
      ${aboutParagraphs(seller)
        .map((p) => `<p>${esc(p)}</p>`)
        .join("")}
      <div class="hero-actions">${chatButton(seller, "Talk to us", "I'd like to know more about your company and machines.")} ${telLink(bc.listed_contact)}</div>
    </div>
    <aside class="panel-box">
      <h3>Company facts</h3>
      <table class="specs"><tbody>${facts.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</tbody></table>
    </aside>
  </section>
  ${
    bc.deals_in?.length
      ? `<section><h2>What we make</h2><ul class="deals">${bc.deals_in
          .map((d) => {
            const c = categoryFor(seller, d);
            return `<li>${c ? `<a href="${esc(`${b}/c/${c.slug}`)}">${esc(d)}</a>` : esc(d)}</li>`;
          })
          .join("")}</ul></section>`
      : ""
  }
  ${categories.length ? `<section><div class="section-head"><h2>Explore our range</h2><a href="${esc(`${b}/products`)}">All products →</a></div>${grid(categories.slice(0, 8).map((c) => categoryCard(seller, c)), "cats-grid")}</section>` : ""}
  ${contactBlock(seller)}`;
  return sellerPage(seller, {
    title: `About Us | ${seller.config.name}`,
    active: "about",
    before: pageHead("About Us", tagline(seller)),
    main,
    description: aboutParagraphs(seller)[0],
  });
}

export function productsPage(seller: SellerContext): string {
  const b = base(seller);
  const categories = seller.catalogue.list("category");
  const products = seller.catalogue.list("product");
  const inCategory = new Set(categories.flatMap((c) => c.products.map((p) => p.url)));
  const others = products.filter((p) => !inCategory.has(p.url));
  const sections = categories.map((c) => {
    const items = seller.catalogue.productsIn(c);
    return `<section id="${esc(c.slug)}"><div class="section-head"><h2>${esc(c.title)}</h2><a href="${esc(`${b}/c/${c.slug}`)}">${items.length > 4 ? `View all ${items.length} →` : "View range →"}</a></div>${
      items.length ? grid(items.slice(0, 4).map((p) => productCard(seller, p))) : `<p class="muted">${esc(c.description || "See the full range on the category page.")}</p>`
    }</section>`;
  });
  const main = `
  ${breadcrumbs(seller, [{ title: "Products" }])}
  ${categories.length ? `<nav class="chips" aria-label="Jump to category">${categories.map((c) => `<a href="#${esc(c.slug)}">${esc(c.title)}</a>`).join("")}</nav>` : ""}
  ${sections.join("")}
  ${others.length ? `<section id="more"><h2>${categories.length ? "More machines" : "Our machines"}</h2>${grid(others.map((p) => productCard(seller, p)))}</section>` : ""}
  ${seller.catalogue.size === 0 ? `<section><h2>Our machines</h2>${productCardTiles(seller)}<p class="muted small">The full catalogue appears here once our website has been crawled.</p></section>` : ""}
  ${contactBlock(seller)}`;
  return sellerPage(seller, {
    title: `Products | ${seller.config.name}`,
    active: "products",
    before: pageHead("Our Products", products.length ? `${categories.length} categories · ${products.length} machines` : tagline(seller)),
    main,
    description: `Products of ${seller.config.name}: ${categories.map((c) => c.title).slice(0, 10).join(", ")}`,
  });
}

export function contactPage(seller: SellerContext): string {
  const bc = seller.kb.businessCard;
  const { city, address } = splitLocation(bc.location);
  const mapQuery = [bc.name, address || city].filter(Boolean).join(", ");
  const main = `
  ${breadcrumbs(seller, [{ title: "Contact Us" }])}
  <section class="two-col">
    <div class="panel-box">
      <h2>Send an enquiry</h2>
      <p>Our assistant answers questions about our machines straight away. To get a quote, share your requirement and your mobile number, confirm it with an OTP, and our team will call you back.</p>
      <div class="hero-actions">${chatButton(seller, "Start an enquiry", "I'd like to send an enquiry.")}</div>
    </div>
    <div class="panel-box">
      <h2>Reach us</h2>
      <dl class="contact-list">
        <dt>Company</dt><dd>${esc(bc.name)}</dd>
        ${city ? `<dt>Location</dt><dd>${esc(city)}</dd>` : ""}
        ${address ? `<dt>Address</dt><dd>${esc(address)}</dd>` : ""}
        ${bc.listed_contact ? `<dt>Phone</dt><dd><a href="tel:${esc(String(bc.listed_contact).replace(/[^\d+]/g, ""))}">${esc(bc.listed_contact)}</a></dd>` : ""}
      </dl>
      ${mapQuery ? `<a class="btn ghost" href="https://www.google.com/maps/search/?api=1&amp;query=${esc(encodeURIComponent(mapQuery))}" rel="noopener" target="_blank">Open in Google Maps</a>` : ""}
    </div>
  </section>`;
  return sellerPage(seller, {
    title: `Contact Us | ${seller.config.name}`,
    active: "contact",
    before: pageHead("Contact Us", city ? `${bc.name}, ${city}` : bc.name),
    main,
    description: `Contact ${bc.name}${city ? `, ${city}` : ""}`,
  });
}

function sidebar(seller: SellerContext, current?: string): string {
  const cats = seller.catalogue.list("category");
  if (!cats.length) return "";
  return `<aside class="sidebar"><h3>Categories</h3><ul class="plain">${cats
    .map((c) => `<li><a href="${esc(`${base(seller)}/c/${c.slug}`)}"${c.slug === current ? ' aria-current="page"' : ""}>${esc(c.title)}</a></li>`)
    .join("")}</ul><div class="side-cta">${chatButton(seller, "Need help choosing?", "Can you help me choose the right machine?", "btn small")}</div></aside>`;
}

function paragraphs(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join("");
}

export function categoryPage(seller: SellerContext, category: CatalogueEntry): string {
  const products = seller.catalogue.productsIn(category);
  const intro = category.details || category.description;
  const main = `
  ${breadcrumbs(seller, [{ title: "Products", href: `${base(seller)}/products` }, { title: category.title }])}
  <section class="cat-intro">
    ${image(categoryImage(seller, category), category.title, "detail-img")}
    <div class="prose">
      <h1>${esc(category.title)}</h1>
      ${intro ? paragraphs(intro) : ""}
      ${category.features.length ? `<ul class="ticks">${category.features.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
      <div class="hero-actions">${chatButton(seller, "Ask about these machines", `I'm interested in ${category.title}.`)} ${telLink(seller.kb.businessCard.listed_contact)}</div>
    </div>
  </section>
  <div class="with-sidebar">
    ${sidebar(seller, category.slug)}
    <section>
      <h2>${products.length ? `${products.length} product${products.length === 1 ? "" : "s"}` : "Products"}</h2>
      ${products.length ? grid(products.map((p) => productCard(seller, p))) : '<p class="muted">No products are listed on this page yet. Ask our assistant for options.</p>'}
    </section>
  </div>
  ${contactBlock(seller)}`;
  return sellerPage(seller, {
    title: `${category.title} | ${seller.config.name}`,
    active: "products",
    main,
    canonical: category.url,
    description: category.description,
  });
}

function gallery(product: CatalogueEntry): string {
  const imgs = (product.images.length ? product.images : product.image ? [product.image] : []).map((u) => safeUrl(u)).filter((u): u is string => !!u);
  if (!imgs.length) return `<div class="gallery">${image(null, product.title, "detail-img")}</div>`;
  return `<div class="gallery">
  <img id="gallery-main" class="img detail-img" src="${esc(imgs[0])}" alt="${esc(product.title)}" referrerpolicy="no-referrer">
  ${
    imgs.length > 1
      ? `<div class="thumbs">${imgs
          .map(
            (u, i) =>
              `<button type="button" class="thumb" data-gallery-src="${esc(u)}" aria-label="Photo ${i + 1}" aria-current="${i === 0}"><img src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.remove()"></button>`,
          )
          .join("")}</div>`
      : ""
  }
</div>`;
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
  const text = product.details || product.description;
  const main = `
  ${breadcrumbs(seller, [{ title: "Products", href: `${base(seller)}/products` }, ...(category ? [{ title: category.title, href: `${base(seller)}/c/${category.slug}` }] : []), { title: product.title }])}
  <section class="detail">
    ${gallery(product)}
    <div class="buybox">
      <h1>${esc(product.title)}</h1>
      ${category ? `<a class="muted small" href="${esc(`${base(seller)}/c/${category.slug}`)}">${esc(category.title)}</a>` : product.category ? `<div class="muted small">${esc(product.category)}</div>` : ""}
      ${
        product.price_text
          ? `<div class="price big">${esc(startingPrice(product.price_text))}</div><p class="muted small">Indicative starting price. The final price depends on the configuration; our team shares a formal quote.</p>`
          : '<p class="price-ask">Price on request: ask us for a quote.</p>'
      }
      ${specs.length ? `<div class="spec-chips">${specs.slice(0, 4).map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("")}</div>` : ""}
      <div class="hero-actions">
        ${chatButton(seller, "Get the best quote", `I'd like a quote for the ${product.title}.`)}
        ${chatButton(seller, "Ask a question", `I have a question about the ${product.title}.`, "btn ghost")}
      </div>
      <p class="muted small">${seller.kb.businessCard.listed_contact ? `Or call ${telLink(seller.kb.businessCard.listed_contact, "")} · ` : ""}<a href="${esc(safeUrl(product.url) ?? "#")}" rel="noopener">View on official site</a></p>
    </div>
  </section>
  <div class="product-sections">
    ${specs.length ? `<section><h2>Specifications</h2><table class="specs striped"><tbody>${specs.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</tbody></table></section>` : ""}
    ${text ? `<section class="prose"><h2>Product description</h2>${paragraphs(text)}</section>` : ""}
    ${product.features.length ? `<section><h2>Features</h2><ul class="ticks">${product.features.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></section>` : ""}
  </div>
  ${siblings.length ? `<section><div class="section-head"><h2>More in ${esc(category!.title)}</h2><a href="${esc(`${base(seller)}/c/${category!.slug}`)}">View all →</a></div>${grid(siblings.slice(0, 4).map((p) => productCard(seller, p)))}</section>` : ""}
  ${contactBlock(seller)}`;
  return sellerPage(seller, {
    title: `${product.title} | ${seller.config.name}`,
    active: "products",
    main,
    canonical: product.url,
    description: product.description,
  });
}

export function searchPage(seller: SellerContext, query: string): string {
  const results = query.trim() ? seller.catalogue.search(query, 30) : [];
  const main = `
  ${breadcrumbs(seller, [{ title: "Search" }])}
  <h1>${query.trim() ? `Results for “${esc(query)}”` : "Search"}</h1>
  ${
    results.length
      ? grid(results.map((r) => (r.kind === "product" ? productCard(seller, r) : categoryCard(seller, r))))
      : `<p class="muted">${query.trim() ? "Nothing matched." : "Type what you're looking for."} Our assistant can help: ${chatButton(seller, "Ask the assistant", query.trim() ? `I'm looking for ${query.trim()}.` : undefined, "btn small")}</p>`
  }`;
  return sellerPage(seller, { title: `Search | ${seller.config.name}`, main, canonical: null });
}

export function notFoundPage(message = "Page not found"): string {
  return layout({ title: message, body: `<main class="wrap"><h1>${esc(message)}</h1><p><a href="/">All sellers</a></p></main>`, noindex: true });
}
