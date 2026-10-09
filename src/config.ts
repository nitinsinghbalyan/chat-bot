import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..").replace(/[\\/]dist$/, "");

const bool = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

/** Treat `KEY=` (empty) in .env the same as an unset variable. */
const optional = <T extends z.ZodTypeAny>(t: T) => z.preprocess((v) => (v === "" ? undefined : v), t.optional());

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
  /** Where the SQLite database and the refreshed catalogue live (a persistent disk in production). */
  DATA_DIR: optional(z.string()),
  /** Enables /admin/leads with HTTP Basic auth (any username). Unset = admin pages disabled. */
  ADMIN_PASSWORD: optional(z.string().min(8, "ADMIN_PASSWORD must be at least 8 characters")),
});

export const config = schema.parse(process.env);

const dataDir = config.DATA_DIR ? path.resolve(config.DATA_DIR) : path.join(ROOT, "data");

export const paths = {
  kb: path.join(ROOT, "kb"),
  prompts: path.join(ROOT, "prompts"),
  public: path.join(ROOT, "public"),
  data: dataDir,
  db: path.join(dataDir, "chatbot.db"),
  businessCard: path.join(ROOT, "kb", "business_card.json"),
  productCards: path.join(ROOT, "kb", "product_cards.json"),
  sitemap: path.join(ROOT, "kb", "sitemap.xml"),
  /** Catalogue shipped with the repo (committed after a crawl). */
  bundledCatalogue: path.join(ROOT, "kb", "catalogue.json"),
  /** Catalogue refreshed by the crawler at runtime; preferred when present. */
  catalogue: path.join(dataDir, "catalogue.json"),
};
