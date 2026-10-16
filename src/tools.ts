import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "./config.js";
import type { MediaCard, MediaKind } from "./media.js";
import type { LeadState, Session } from "./session.js";

const MAX_OTP_ATTEMPTS = 3;
const MAX_OTP_SENDS = 3;

export const toolDefinitions: Anthropic.Beta.BetaTool[] = [
  {
    name: "send_otp",
    description:
      "Send a one-time password to the buyer's mobile number so they can verify it before we pass their enquiry to our team. Call this only after the buyer has typed their mobile number in this conversation.",
    strict: true,
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        mobile: { type: "string", description: "The mobile number exactly as the buyer typed it." },
      },
      required: ["mobile"],
      additionalProperties: false,
    },
  },
  {
    name: "verify_otp",
    description:
      "Check the OTP the buyer typed. Call this only after send_otp succeeded and the buyer has typed the code. Returns whether it matched and how many attempts are left.",
    strict: true,
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        otp: { type: "string", description: "The code exactly as the buyer typed it." },
      },
      required: ["otp"],
      additionalProperties: false,
    },
  },
  {
    name: "save_lead",
    description:
      "Pass the buyer's enquiry to our sales team. Call it as soon as the mobile number is verified and the buyer has told you their name, then call it again after the last qualification question with all the answers and complete set to true (later calls update the same enquiry). When complete is true the buyer sees a summary card of the enquiry. Use an empty string or empty list for anything the buyer has not told you.",
    strict: true,
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The buyer's name as they typed it." },
        product: { type: "string", description: "The machine the buyer is enquiring about." },
        specs: {
          type: "array",
          description: "The buyer's answers to the qualification questions, one item per question, in the order asked, e.g. {label: \"Material\", value: \"Mild steel\"}. Empty list if none yet.",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Short name of the specification, e.g. Material, Sheet thickness, Bed length." },
              value: { type: "string", description: "The buyer's answer, with unit." },
            },
            required: ["label", "value"],
            additionalProperties: false,
          },
        },
        requirements: {
          type: "string",
          description: "Any other requirement details the buyer shared that are not in specs. Empty string if none.",
        },
        quantity: { type: "string", description: "Quantity the buyer mentioned, with unit. Empty string if not mentioned." },
        city: { type: "string", description: "Buyer's city or delivery location if mentioned. Empty string if not mentioned." },
        complete: {
          type: "boolean",
          description: "True once every qualification question is answered (or none apply), and when saving a correction the buyer made afterwards. False on the first save before the qualification questions.",
        },
      },
      required: ["name", "product", "specs", "requirements", "quantity", "city", "complete"],
      additionalProperties: false,
    },
  },
  {
    name: "show_options",
    description:
      "Show tap-to-reply buttons under your message. Use it whenever you ask the buyer a qualification question (ISQ) that has listed options, or any question with a few clear choices. Write the question in your reply text first, then call this with 2 to 8 short options (each under 60 characters), usually the options listed for that ISQ. Do not use it while collecting the mobile number, OTP or name. After it returns, end your turn and wait for the buyer.",
    strict: true,
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        options: { type: "array", items: { type: "string" }, description: "2 to 8 short answer options, in the order to show them." },
      },
      required: ["options"],
      additionalProperties: false,
    },
  },
  {
    name: "share_media",
    description:
      "Show the buyer product cards, photos, videos or PDF brochures as a carousel in the chat. Use it when the buyer asks to see photos, images, a video, a brochure or catalogue, or asks for related or similar products. Pass product ids from the PRODUCT CARDS (\"Product id\") or the SELLER CATALOGUE (\"ID\"), or \"company\" for company-wide media. The result says what was shared and what is not available; describe only that, in one short sentence, and never paste the links.",
    strict: true,
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        product_ids: { type: "array", items: { type: "string" }, description: "1 to 6 product ids, a category id, or \"company\"." },
        kinds: {
          type: "array",
          items: { type: "string", enum: ["product", "image", "video", "document"] },
          description: "What to show: product cards, photos, videos and/or PDF documents.",
        },
        include_related: { type: "boolean", description: "Also show related products from the same category." },
      },
      required: ["product_ids", "kinds", "include_related"],
      additionalProperties: false,
    },
  },
];

const inputSchemas = {
  send_otp: z.object({ mobile: z.string().max(40) }).strict(),
  verify_otp: z.object({ otp: z.string().max(20) }).strict(),
  save_lead: z
    .object({
      name: z.string().max(100),
      product: z.string().max(200),
      specs: z
        .array(z.object({ label: z.string().trim().max(60), value: z.string().trim().max(200) }).strict())
        .max(20, "give at most 20 specs")
        .default([]),
      requirements: z.string().max(1500),
      quantity: z.string().max(100),
      city: z.string().max(100),
      complete: z.boolean().default(false),
    })
    .strict(),
  show_options: z
    .object({ options: z.array(z.string().trim().min(1).max(60, "keep each option under 60 characters")).min(2, "give at least 2 options").max(8, "give at most 8 options") })
    .strict(),
  share_media: z
    .object({
      product_ids: z.array(z.string().trim().min(1).max(100)).min(1, "give at least one product id").max(6, "give at most 6 product ids"),
      kinds: z.array(z.enum(["product", "image", "video", "document"])).min(1).max(4),
      include_related: z.boolean(),
    })
    .strict(),
};

export type ToolName = keyof typeof inputSchemas;

/** The enquiry summary card shown to the buyer once requirement gathering is complete. */
export interface EnquirySummary {
  rows: Array<{ label: string; value: string }>;
  note: string;
}

export interface ToolResult {
  content: string;
  isError: boolean;
  /** What the chat window should show: reply buttons, media cards or the enquiry summary. */
  ui?: { chips?: string[]; cards?: MediaCard[]; summary?: EnquirySummary };
}

/** Resolves share_media requests against the seller's KB and catalogue (see shareMedia.ts). */
export type MediaSharer = (ids: string[], kinds: MediaKind[], includeRelated: boolean) => { cards: MediaCard[]; content: string; isError: boolean };

export interface Lead {
  createdAt: string;
  seller: string;
  sessionId: string;
  mobile: string;
  name: string;
  product: string;
  requirements: string;
  quantity: string;
  city: string;
  pageUrl?: string;
  /** The conversation the lead came from; the chat's Langfuse session is "<seller>:<chatId>". */
  chatId?: string;
  /** True when save_lead runs again after the ISQs: update this session's lead instead of adding one. */
  update?: boolean;
}

export type LeadSink = (lead: Lead) => void;

/** Indian mobile: optional +91 / 91 / 0 prefix, then 10 digits starting 6-9. */
export function normalizeMobile(raw: string): string | null {
  const compact = raw.replace(/[\s\-().]/g, "");
  const m = compact.match(/^(?:\+?91|0)?([6-9]\d{9})$/);
  return m ? m[1] : null;
}

const maskMobile = (m: string) => `${"x".repeat(6)}${m.slice(-4)}`;

type SaveLeadInput = z.infer<typeof inputSchemas.save_lead>;

/** The specs that have an answer, with tidy labels. */
const answeredSpecs = (input: SaveLeadInput) => input.specs.filter((s) => s.label && s.value);

/** What goes in the lead's requirements column: "Material: Mild steel; Thickness: 6 mm; <other notes>". */
export function requirementsText(input: SaveLeadInput): string {
  return [...answeredSpecs(input).map((s) => `${s.label}: ${s.value}`), input.requirements.trim()].filter(Boolean).join("; ");
}

/** The summary card: the machine, each spec, quantity, city, name and the masked mobile; empty rows left out. */
export function enquirySummary(input: SaveLeadInput, name: string, mobile: string): EnquirySummary {
  const rows = [
    { label: "Machine", value: input.product.trim() },
    ...answeredSpecs(input),
    { label: "Other details", value: input.requirements.trim() },
    { label: "Quantity", value: input.quantity.trim() },
    { label: "City", value: input.city.trim() },
    { label: "Name", value: name },
    { label: "Mobile", value: maskMobile(mobile) },
  ].filter((r) => r.value);
  return { rows, note: `Our team will contact you on ${maskMobile(mobile)}.` };
}

const SUMMARY_SHOWN =
  "The buyer now sees a summary card with all these details. In one short sentence, say our team will contact them and ask if anything needs changing, then call show_options with \"All correct\" and \"Change a detail\". Do not repeat the details or promise a time.";

export function describeLeadStatus(lead: LeadState): string {
  switch (lead.stage) {
    case "none":
      return "No contact details captured yet: reply only with a short request for the buyer's 10-digit mobile number, nothing else.";
    case "otp_sent":
      return `OTP sent to mobile ${maskMobile(lead.mobile!)}. Waiting for the buyer to type the OTP (${MAX_OTP_ATTEMPTS - lead.otpAttempts} attempts left).`;
    case "verified":
      return `Mobile ${maskMobile(lead.mobile!)} verified. Ask for the buyer's name next, then call save_lead straight away.`;
    case "captured":
      return lead.summarized
        ? `Enquiry saved for ${lead.name} (mobile ${maskMobile(lead.mobile!)}) and the buyer has seen the summary card. Do not ask for contact details again. If the buyer corrects or adds a detail, call save_lead again with all the details and complete set to true; this updates the enquiry and shows a new summary.`
        : `Enquiry saved for ${lead.name} (mobile ${maskMobile(lead.mobile!)}). Do not ask for contact details again. Continue the qualification questions one at a time; after the last answer, call save_lead again with all the details and complete set to true.`;
    case "locked":
      return lead.otpSends >= MAX_OTP_SENDS
        ? "OTP verification is locked for this chat after too many wrong attempts. Apologise and suggest the buyer tries again later."
        : "The last OTP was entered wrongly too many times. Ask the buyer to re-enter their mobile number to get a new OTP.";
  }
}

export function executeTool(
  session: Session,
  name: string,
  rawInput: unknown,
  opts: { saveLead: LeadSink; pageUrl?: string; shareMedia?: MediaSharer },
): ToolResult {
  if (!(name in inputSchemas)) return { content: `Unknown tool: ${name}`, isError: true };
  const parsed = inputSchemas[name as ToolName].safeParse(rawInput);
  if (!parsed.success) {
    return { content: `Invalid input for ${name}: ${parsed.error.issues.map((i) => i.message).join("; ")}. Ask the buyer again.`, isError: true };
  }
  const lead = session.lead;

  switch (name as ToolName) {
    case "show_options": {
      if (lead.stage === "otp_sent" || lead.stage === "verified") {
        return { content: "Not shown: the buyer is typing their OTP or name now, so don't offer buttons.", isError: true };
      }
      const seen = new Set<string>();
      const options = (parsed.data as z.infer<typeof inputSchemas.show_options>).options.filter((o) => {
        const k = o.toLowerCase();
        return !seen.has(k) && seen.add(k);
      });
      return { content: `Shown ${options.length} reply buttons under your message. End your turn now and wait for the buyer's answer.`, isError: false, ui: { chips: options } };
    }

    case "share_media": {
      const input = parsed.data as z.infer<typeof inputSchemas.share_media>;
      if (!opts.shareMedia) return { content: "Media sharing is not available in this chat.", isError: true };
      const r = opts.shareMedia(input.product_ids, input.kinds, input.include_related);
      return { content: r.content, isError: r.isError, ui: r.cards.length ? { cards: r.cards } : undefined };
    }

    case "send_otp": {
      const { mobile } = parsed.data as z.infer<typeof inputSchemas.send_otp>;
      if (lead.stage === "captured") return { content: "The enquiry is already with our team; no need to verify again.", isError: true };
      if (lead.stage === "verified") return { content: "This mobile number is already verified. Ask for the buyer's name.", isError: true };
      if (lead.otpSends >= MAX_OTP_SENDS) {
        lead.stage = "locked";
        return { content: "OTP limit reached for this chat. Apologise and suggest the buyer tries again later.", isError: true };
      }
      const normalized = normalizeMobile(mobile);
      if (!normalized) return { content: "That is not a valid 10-digit Indian mobile number. Ask the buyer to re-enter it.", isError: true };
      lead.mobile = normalized;
      lead.stage = "otp_sent";
      lead.otpAttempts = 0;
      lead.otpSends++;
      // Demo mode: no SMS gateway. The code is checked server-side and never shown to the model.
      return { content: `OTP sent to ${maskMobile(normalized)}. Ask the buyer to type the OTP they received.`, isError: false };
    }

    case "verify_otp": {
      const { otp } = parsed.data as z.infer<typeof inputSchemas.verify_otp>;
      if (lead.stage !== "otp_sent") {
        return { content: `No OTP is pending. ${describeLeadStatus(lead)}`, isError: true };
      }
      if (otp.replace(/\s/g, "") === config.DEMO_OTP) {
        lead.stage = "verified";
        return { content: "OTP verified. Now ask for the buyer's name.", isError: false };
      }
      lead.otpAttempts++;
      const left = MAX_OTP_ATTEMPTS - lead.otpAttempts;
      if (left <= 0) {
        lead.stage = "locked";
        return { content: `Wrong OTP. ${describeLeadStatus(lead)}`, isError: true };
      }
      return { content: `Wrong OTP. ${left} attempt${left === 1 ? "" : "s"} left. Ask the buyer to check and re-enter it.`, isError: true };
    }

    case "save_lead": {
      const input = parsed.data as SaveLeadInput;
      const fields = {
        product: input.product.trim(),
        requirements: requirementsText(input),
        quantity: input.quantity.trim(),
        city: input.city.trim(),
        pageUrl: opts.pageUrl,
        chatId: session.chatId,
      };
      if (lead.stage === "captured" && lead.mobile && lead.name) {
        opts.saveLead({ createdAt: new Date().toISOString(), seller: session.seller, sessionId: session.id, mobile: lead.mobile, name: lead.name, ...fields, update: true });
        if (!input.complete) {
          return { content: "Enquiry updated. Continue with the next qualification question; after the last one, call save_lead again with complete set to true.", isError: false };
        }
        lead.summarized = true;
        return { content: `Enquiry updated. ${SUMMARY_SHOWN}`, isError: false, ui: { summary: enquirySummary(input, lead.name, lead.mobile) } };
      }
      if (lead.stage !== "verified" || !lead.mobile) {
        return { content: `Cannot save yet: the mobile number must be verified with an OTP first. ${describeLeadStatus(lead)}`, isError: true };
      }
      const name = input.name.trim();
      if (name.length < 2) return { content: "Missing the buyer's name. Ask for it first.", isError: true };
      opts.saveLead({ createdAt: new Date().toISOString(), seller: session.seller, sessionId: session.id, mobile: lead.mobile, name, ...fields });
      lead.stage = "captured";
      lead.name = name;
      if (input.complete) {
        lead.summarized = true;
        return { content: `Enquiry saved. ${SUMMARY_SHOWN}`, isError: false, ui: { summary: enquirySummary(input, name, lead.mobile) } };
      }
      return {
        content:
          "Enquiry saved. Thank the buyer in a few words, then ask which machine they need if that isn't clear yet, else the first qualification question you still need (with show_options). After the last answer, call save_lead again with complete set to true.",
        isError: false,
      };
    }
  }
}
