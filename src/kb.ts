import fs from "node:fs";
import path from "node:path";

export interface BusinessCard {
  name: string;
  ceo?: string;
  location?: string;
  nature?: string[];
  deals_in?: string[];
  categories?: string[];
  listed_contact?: string;
  [key: string]: unknown;
}

interface CardAttributeValue {
  value: string;
}

interface CardAttribute {
  key: string;
  role: string;
  required_for_lead?: boolean;
  values?: CardAttributeValue[];
}

interface CardQuestion {
  attribute: string;
  question: string;
  sequence?: number;
}

export interface ProductCard {
  product_id: string;
  canonical_name: string;
  category?: string;
  aliases?: string[];
  attributes?: CardAttribute[];
  questions?: CardQuestion[];
  selling_unit?: { unit: string } | null;
  brand_policy?: string;
  disambiguate?: boolean;
  flow: { markdown: string; categories?: string[]; brands_observed?: string[] };
}

export interface KnowledgeBase {
  businessCard: BusinessCard;
  productCards: ProductCard[];
  /** Business card rendered for the system prompt (internal evidence fields stripped). */
  businessCardText: string;
  /** Product cards rendered for the system prompt. */
  productCardsText: string;
  /** Phone numbers the bot may share (Guardrail 3). Digits only. */
  allowedPhones: string[];
  /** Domains whose links the bot may share (Guardrail 3). */
  allowedDomains: string[];
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function renderBusinessCard(bc: BusinessCard): string {
  const lines = [`Name: ${bc.name}`];
  if (bc.ceo) lines.push(`CEO: ${bc.ceo}`);
  if (bc.location) lines.push(`Location: ${bc.location}`);
  if (bc.nature?.length) lines.push(`Nature of business: ${bc.nature.join(", ")}`);
  if (bc.deals_in?.length) lines.push(`Deals in: ${bc.deals_in.join(", ")}`);
  if (bc.listed_contact) lines.push(`Listed contact number (share only if the buyer asks for a contact): ${bc.listed_contact}`);
  return lines.join("\n");
}

export function renderProductCard(card: ProductCard): string {
  const parts = [card.flow.markdown.trim()];
  if (card.aliases?.length) {
    parts.push(`**Also known as:** ${[...new Set(card.aliases)].sort().join("; ")}`);
  }
  const policy: string[] = [];
  if (card.brand_policy === "defer") {
    policy.push("Brand questions: brands are for recognition only. Do not confirm stock, availability or authenticity of any brand; pass brand-specific requests to our team.");
  }
  if (card.disambiguate) {
    policy.push("This product name overlaps with other machines. If it is unclear which machine the buyer means, ask before answering.");
  }
  if (card.selling_unit?.unit) {
    policy.push(`Quantity is counted in ${card.selling_unit.unit}s. Ask for the quantity; do not assume it.`);
  }
  if (policy.length) parts.push(`**Handling rules:**\n\n${policy.map((p) => `- ${p}`).join("\n")}`);
  return parts.join("\n\n");
}

function digits(s: string): string {
  return s.replace(/\D/g, "");
}

export function sitemapUrls(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Loads one seller's KB from its folder (business_card.json, product_cards.json, sitemap.xml).
 * `siteUrl` adds the seller's own domain to the links the bot may share (Guardrail 3).
 */
export function loadKnowledgeBase(dir: string, siteUrl?: string): KnowledgeBase {
  const businessCard = readJson<BusinessCard>(path.join(dir, "business_card.json"));
  const productCards = readJson<ProductCard[]>(path.join(dir, "product_cards.json")).sort((a, b) =>
    a.canonical_name.localeCompare(b.canonical_name),
  );
  const sitemapFile = path.join(dir, "sitemap.xml");
  const urls = fs.existsSync(sitemapFile) ? sitemapUrls(fs.readFileSync(sitemapFile, "utf8")) : [];
  const domains = new Set<string>();
  for (const u of [...urls, ...(siteUrl ? [siteUrl] : [])]) {
    const h = hostOf(u);
    if (h) domains.add(h);
  }
  return {
    businessCard,
    productCards,
    businessCardText: renderBusinessCard(businessCard),
    productCardsText: productCards.map(renderProductCard).join("\n\n---\n\n"),
    allowedPhones: businessCard.listed_contact ? [digits(businessCard.listed_contact)] : [],
    allowedDomains: [...domains].sort(),
  };
}
