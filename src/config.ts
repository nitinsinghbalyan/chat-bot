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
  /** Folder holding one sub-folder per seller. Default: kb/sellers in the repo. */
  SELLERS_DIR: optional(z.string()),
  /** Langfuse tracing: on when both keys are set. */
  LANGFUSE_PUBLIC_KEY: optional(z.string()),
  LANGFUSE_SECRET_KEY: optional(z.string()),
  /** EU: https://cloud.langfuse.com, US: https://us.cloud.langfuse.com, or a self-hosted URL. Unset: EU, else US if the keys are from there. Also read from LANGFUSE_HOST. */
  LANGFUSE_BASE_URL: optional(z.string().url()),
  /** Shown as the trace environment in Langfuse. Default: NODE_ENV, else "development". */
  LANGFUSE_ENVIRONMENT: optional(z.string().regex(/^[a-z0-9_-]{1,40}$/, "use lowercase letters, digits, - or _")),
});

/** Keys pasted with a stray space or newline are rejected by Langfuse, so trim them. */
const trimmed = (v: string | undefined) => v?.trim() || undefined;

export const config = schema.parse({
  ...process.env,
  LANGFUSE_PUBLIC_KEY: trimmed(process.env.LANGFUSE_PUBLIC_KEY),
  LANGFUSE_SECRET_KEY: trimmed(process.env.LANGFUSE_SECRET_KEY),
  // Langfuse's own docs also use LANGFUSE_HOST and LANGFUSE_BASEURL for this.
  LANGFUSE_BASE_URL: trimmed(process.env.LANGFUSE_BASE_URL) ?? trimmed(process.env.LANGFUSE_HOST) ?? trimmed(process.env.LANGFUSE_BASEURL),
});

const dataDir = config.DATA_DIR ? path.resolve(config.DATA_DIR) : path.join(ROOT, "data");

export const paths = {
  prompts: path.join(ROOT, "prompts"),
  public: path.join(ROOT, "public"),
  /** One folder per seller with the KB you supply: seller.json, business_card.json, product_cards.json, sitemap.xml. */
  sellers: config.SELLERS_DIR ? path.resolve(config.SELLERS_DIR) : path.join(ROOT, "kb", "sellers"),
  data: dataDir,
  db: path.join(dataDir, "chatbot.db"),
  /** Runtime data per seller (the refreshed catalogue), kept on the persistent disk. */
  sellerData: path.join(dataDir, "sellers"),
};
