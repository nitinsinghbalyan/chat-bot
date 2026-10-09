import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config, paths } from "./config.js";
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
      "Pass the buyer's enquiry to our sales team. Only works after the mobile number is verified and the buyer has told you their name. Use an empty string for anything the buyer has not told you.",
    strict: true,
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The buyer's name as they typed it." },
        product: { type: "string", description: "The machine the buyer is enquiring about." },
        requirements: {
          type: "string",
          description: "The requirement details the buyer shared, e.g. qualification answers such as sheet thickness, length, capacity, material. Empty string if none.",
        },
        quantity: { type: "string", description: "Quantity the buyer mentioned, with unit. Empty string if not mentioned." },
        city: { type: "string", description: "Buyer's city or delivery location if mentioned. Empty string if not mentioned." },
      },
      required: ["name", "product", "requirements", "quantity", "city"],
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
      requirements: z.string().max(1500),
      quantity: z.string().max(100),
      city: z.string().max(100),
    })
    .strict(),
};

export type ToolName = keyof typeof inputSchemas;

export interface ToolResult {
  content: string;
  isError: boolean;
}

export interface Lead {
  createdAt: string;
  sessionId: string;
  mobile: string;
  name: string;
  product: string;
  requirements: string;
  quantity: string;
  city: string;
  pageUrl?: string;
}

export type LeadSink = (lead: Lead) => void;

export const fileLeadSink: LeadSink = (lead) => {
  fs.mkdirSync(path.dirname(paths.leads), { recursive: true });
  fs.appendFileSync(paths.leads, JSON.stringify(lead) + "\n");
};

/** Indian mobile: optional +91 / 91 / 0 prefix, then 10 digits starting 6-9. */
export function normalizeMobile(raw: string): string | null {
  const compact = raw.replace(/[\s\-().]/g, "");
  const m = compact.match(/^(?:\+?91|0)?([6-9]\d{9})$/);
  return m ? m[1] : null;
}

const maskMobile = (m: string) => `${"x".repeat(6)}${m.slice(-4)}`;

export function describeLeadStatus(lead: LeadState): string {
  switch (lead.stage) {
    case "none":
      return "No contact details captured yet.";
    case "otp_sent":
      return `OTP sent to mobile ${maskMobile(lead.mobile!)}. Waiting for the buyer to type the OTP (${MAX_OTP_ATTEMPTS - lead.otpAttempts} attempts left).`;
    case "verified":
      return `Mobile ${maskMobile(lead.mobile!)} verified. Ask for the buyer's name next, then call save_lead.`;
    case "captured":
      return `Enquiry already passed to our team for ${lead.name} (mobile ${maskMobile(lead.mobile!)}). Do not ask for contact details again.`;
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
  opts: { saveLead?: LeadSink; pageUrl?: string } = {},
): ToolResult {
  if (!(name in inputSchemas)) return { content: `Unknown tool: ${name}`, isError: true };
  const parsed = inputSchemas[name as ToolName].safeParse(rawInput);
  if (!parsed.success) {
    return { content: `Invalid input for ${name}: ${parsed.error.issues.map((i) => i.message).join("; ")}. Ask the buyer again.`, isError: true };
  }
  const lead = session.lead;

  switch (name as ToolName) {
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
      const input = parsed.data as z.infer<typeof inputSchemas.save_lead>;
      if (lead.stage === "captured") return { content: "The enquiry was already saved. Confirm to the buyer that our team will contact them.", isError: true };
      if (lead.stage !== "verified" || !lead.mobile) {
        return { content: `Cannot save yet: the mobile number must be verified with an OTP first. ${describeLeadStatus(lead)}`, isError: true };
      }
      const name = input.name.trim();
      if (name.length < 2) return { content: "Missing the buyer's name. Ask for it first.", isError: true };
      (opts.saveLead ?? fileLeadSink)({
        createdAt: new Date().toISOString(),
        sessionId: session.id,
        mobile: lead.mobile,
        name,
        product: input.product.trim(),
        requirements: input.requirements.trim(),
        quantity: input.quantity.trim(),
        city: input.city.trim(),
        pageUrl: opts.pageUrl,
      });
      lead.stage = "captured";
      lead.name = name;
      return { content: "Enquiry saved and passed to our team. Thank the buyer and confirm our team will contact them; do not promise a time.", isError: false };
    }
  }
}
