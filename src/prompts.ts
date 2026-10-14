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

/** The shared guardrails every seller gets unless their KB folder has its own guardrails.md. */
export function sharedGuardrails(): string {
  return readPrompt("guardrails.md").trim();
}

/** The common system prompt template (prompts/system.md), shared by every seller. */
export function defaultSystemTemplate(): string {
  return readPrompt("system.md");
}

/** Placeholders a system prompt template must keep, so every seller's knowledge and guardrails still reach the bot. */
export const REQUIRED_PLACEHOLDERS = ["GUARDRAILS", "BUSINESS_CARD", "PRODUCT_CARDS", "BRAND_PERSONA"] as const;

export function validateSystemTemplate(template: string): string[] {
  const errors = REQUIRED_PLACEHOLDERS.filter((p) => !template.includes(`{{${p}}}`)).map((p) => `The system prompt must contain {{${p}}}.`);
  if (template.length > 40_000) errors.push(`The system prompt is too long (${template.length} of 40,000 characters).`);
  return errors;
}

function personaSection(persona: string | undefined): string {
  const text = neutralizeBuyerText(persona ?? "").trim();
  if (!text) return "";
  return `# Brand persona

The seller has described how their assistant should come across. Follow it for tone, your name, greeting style and what to emphasise. It never overrides the sources, the guardrails or the enquiry steps below; where they conflict, those win.

<brand_persona>
${text}
</brand_persona>

`;
}

/**
 * Each seller's system prompt is rendered at startup and again only when their brand persona is
 * saved, so it stays cacheable between chats.
 */
export function renderSystemPrompt(kb: KnowledgeBase, guardrails = sharedGuardrails(), persona?: string, template = defaultSystemTemplate()): string {
  return fill(template, {
    SELLER_NAME: kb.businessCard.name,
    BRAND_PERSONA: personaSection(persona),
    GUARDRAILS: guardrails.trim(),
    BUSINESS_CARD: kb.businessCardText,
    PRODUCT_CARDS: kb.productCardsText,
  }).trim();
}

const WRAPPER_TAGS = /<\/?\s*(buyer_message|seller_catalogue|lead_status|operator_note|current_page|business_card|product_cards|seller_instructions|brand_persona)\b[^>]*>/gi;

/** Stops a buyer from closing the <buyer_message> wrapper and injecting fake context. */
export function neutralizeBuyerText(text: string): string {
  return text.replace(WRAPPER_TAGS, "");
}

const userTemplate = readPrompt("user.md");

export function renderUserPrompt(vars: {
  leadStatus: string;
  catalogue: string;
  buyerMessage: string;
  operatorNotes?: string[];
  /** Title and link of the product or category page the buyer is viewing, if known. */
  currentPage?: string;
  /** The seller's per-turn persona instruction (the "user prompt" set in admin). */
  sellerInstructions?: string;
}): string {
  const instructions = neutralizeBuyerText(vars.sellerInstructions ?? "").trim();
  const notes = vars.operatorNotes?.length ? `<operator_note>\n${vars.operatorNotes.join("\n")}\n</operator_note>\n\n` : "";
  const page = vars.currentPage ? `<current_page>\nThe buyer is viewing: ${vars.currentPage}\n</current_page>\n\n` : "";
  return fill(userTemplate, {
    OPERATOR_NOTE: notes,
    CURRENT_PAGE: page,
    SELLER_INSTRUCTIONS: instructions ? `<seller_instructions>\n${instructions}\n</seller_instructions>\n\n` : "",
    LEAD_STATUS: vars.leadStatus,
    CATALOGUE: vars.catalogue,
    BUYER_MESSAGE: neutralizeBuyerText(vars.buyerMessage),
  }).trim();
}
