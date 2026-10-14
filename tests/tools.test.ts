import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/session.js";
import { describeLeadStatus, executeTool, normalizeMobile, type Lead } from "../src/tools.js";

function setup() {
  const session = new SessionStore().get("jayshree-machinetools", "test-session-1");
  const leads: Lead[] = [];
  const run = (name: string, input: unknown) => executeTool(session, name, input, { saveLead: (l) => leads.push(l), pageUrl: "https://x/p" });
  return { session, leads, run };
}

const leadInput = { name: "Ramesh Patel", product: "CNC Press Brake", requirements: "100 ton, 3 m, MS 4 mm", quantity: "1 piece", city: "Ahmedabad" };

describe("normalizeMobile", () => {
  it.each([
    ["9876543210", "9876543210"],
    ["+91 98765 43210", "9876543210"],
    ["091-9876543210", null],
    ["09876543210", "9876543210"],
    ["5876543210", null],
    ["98765", null],
  ])("%s -> %s", (raw, expected) => expect(normalizeMobile(raw)).toBe(expected));
});

describe("lead capture flow", () => {
  it("runs mobile -> OTP -> name -> save", () => {
    const { session, leads, run } = setup();
    expect(run("send_otp", { mobile: "+91 98765 43210" }).isError).toBe(false);
    expect(session.lead.stage).toBe("otp_sent");
    expect(run("verify_otp", { otp: "12345" }).isError).toBe(false);
    expect(session.lead.stage).toBe("verified");
    const r = run("save_lead", leadInput);
    expect(r.isError).toBe(false);
    expect(session.lead.stage).toBe("captured");
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ mobile: "9876543210", name: "Ramesh Patel", product: "CNC Press Brake", pageUrl: "https://x/p" });
  });

  it("rejects an invalid mobile", () => {
    const { session, run } = setup();
    expect(run("send_otp", { mobile: "12345" }).isError).toBe(true);
    expect(session.lead.stage).toBe("none");
  });

  it("never reveals the OTP to the model", () => {
    const { run } = setup();
    const r = run("send_otp", { mobile: "9876543210" });
    expect(r.content).not.toContain("12345");
  });

  it("counts wrong OTPs and locks after three", () => {
    const { session, run } = setup();
    run("send_otp", { mobile: "9876543210" });
    expect(run("verify_otp", { otp: "11111" }).content).toMatch(/2 attempts left/);
    expect(run("verify_otp", { otp: "22222" }).content).toMatch(/1 attempt left/);
    run("verify_otp", { otp: "33333" });
    expect(session.lead.stage).toBe("locked");
    expect(run("verify_otp", { otp: "12345" }).isError).toBe(true);
    // A fresh OTP can be requested after a lockout...
    expect(run("send_otp", { mobile: "9876543210" }).isError).toBe(false);
    expect(run("verify_otp", { otp: "12345" }).isError).toBe(false);
  });

  it("limits OTP sends per chat", () => {
    const { session, run } = setup();
    for (let i = 0; i < 3; i++) {
      run("send_otp", { mobile: "9876543210" });
      for (let j = 0; j < 3; j++) run("verify_otp", { otp: "00000" });
    }
    expect(run("send_otp", { mobile: "9876543210" }).isError).toBe(true);
    expect(describeLeadStatus(session.lead)).toMatch(/locked for this chat/);
  });

  it("refuses save_lead before OTP verification", () => {
    const { leads, run } = setup();
    expect(run("save_lead", leadInput).isError).toBe(true);
    run("send_otp", { mobile: "9876543210" });
    expect(run("save_lead", leadInput).isError).toBe(true);
    expect(leads).toHaveLength(0);
  });

  it("refuses verify_otp before send_otp", () => {
    const { run } = setup();
    expect(run("verify_otp", { otp: "12345" }).isError).toBe(true);
  });

  it("requires a name, and a second save_lead updates the same enquiry", () => {
    const { leads, run } = setup();
    run("send_otp", { mobile: "9876543210" });
    run("verify_otp", { otp: "12345" });
    expect(run("save_lead", { ...leadInput, name: " " }).isError).toBe(true);
    run("save_lead", { ...leadInput, requirements: "" });
    expect(leads[0]).toMatchObject({ requirements: "" });
    expect(leads[0].update).toBeUndefined();
    // After the ISQs: same buyer, more details; the name can't be changed this way.
    const second = run("save_lead", { ...leadInput, name: "Someone Else", requirements: "CNC, 3 m, 6 mm" });
    expect(second.isError).toBe(false);
    expect(leads).toHaveLength(2);
    expect(leads[1]).toMatchObject({ update: true, name: leads[0].name, mobile: "9876543210", requirements: "CNC, 3 m, 6 mm" });
  });

  it("validates tool inputs", () => {
    const { run } = setup();
    expect(run("send_otp", { phone: "9876543210" }).isError).toBe(true);
    expect(run("save_lead", { name: "A" }).isError).toBe(true);
    expect(run("delete_everything", {}).isError).toBe(true);
  });
});
