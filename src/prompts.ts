import fs from "node:fs";
import path from "node:path";
import { paths } from "./config.js";
import type { KnowledgeBase } from "./kb.js";

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => (key in vars ? vars[key] : match));
}

function readPrompt(name: string): string {
  return fs.readFileSync(path.join(paths.prompts, name), "utf8");
}

/** The system prompt is rendered once at startup and never changes, so it stays cacheable. */
export function renderSystemPrompt(kb: KnowledgeBase): string {
  return fill(readPrompt("system.md"), {
    SELLER_NAME: kb.businessCard.name,
    BUSINESS_CARD: kb.businessCardText,
    PRODUCT_CARDS: kb.productCardsText,
  }).trim();
}

const WRAPPER_TAGS = /<\/?\s*(buyer_message|seller_catalogue|lead_status|operator_note|business_card|product_cards)\b[^>]*>/gi;

/** Stops a buyer from closing the <buyer_message> wrapper and injecting fake context. */
export function neutralizeBuyerText(text: string): string {
  return text.replace(WRAPPER_TAGS, "");
}

const userTemplate = readPrompt("user.md");

export function renderUserPrompt(vars: { leadStatus: string; catalogue: string; buyerMessage: string; operatorNotes?: string[] }): string {
  const notes = vars.operatorNotes?.length ? `<operator_note>\n${vars.operatorNotes.join("\n")}\n</operator_note>\n\n` : "";
  return fill(userTemplate, {
    OPERATOR_NOTE: notes,
    LEAD_STATUS: vars.leadStatus,
    CATALOGUE: vars.catalogue,
    BUYER_MESSAGE: neutralizeBuyerText(vars.buyerMessage),
  }).trim();
}
