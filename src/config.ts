import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..").replace(/[\\/]dist$/, "");

const bool = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  BOT_MODEL: z.string().default("claude-sonnet-5-5"),
  BOT_EFFORT: z.enum(["low", "medium", "high"]).default("low"),
  BOT_FALLBACKS: z
    .string()
    .optional()
    .transform((v) => v !== "false"),
  PORT: z.coerce.number().int().positive().default(3000),
  ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:3000")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  CRAWL_ON_START: bool,
  CRAWL_INTERVAL_HOURS: z.coerce.number().min(0).default(24),
  DEMO_OTP: z.string().regex(/^\d{4,8}$/).default("12345"),
});

export const config = schema.parse(process.env);

export const paths = {
  kb: path.join(ROOT, "kb"),
  prompts: path.join(ROOT, "prompts"),
  public: path.join(ROOT, "public"),
  data: path.join(ROOT, "data"),
  businessCard: path.join(ROOT, "kb", "business_card.json"),
  productCards: path.join(ROOT, "kb", "product_cards.json"),
  sitemap: path.join(ROOT, "kb", "sitemap.xml"),
  catalogue: path.join(ROOT, "kb", "catalogue.json"),
  leads: path.join(ROOT, "data", "leads.jsonl"),
  guardrailLog: path.join(ROOT, "data", "guardrail_events.jsonl"),
};
