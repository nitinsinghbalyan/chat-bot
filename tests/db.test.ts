import { describe, expect, it } from "vitest";
import { ChatDb } from "../src/db.js";
import { SessionStore } from "../src/session.js";
import { executeTool } from "../src/tools.js";

describe("ChatDb", () => {
  it("round-trips a session, including thinking blocks and catalogue hits", () => {
    const db = new ChatDb(":memory:");
    const store = new SessionStore(db);
    const s = store.get("persist-0001");
    s.messages.push(
      { role: "user", content: [{ type: "text", text: "<buyer_message>hi</buyer_message>" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig-abc" } as any, { type: "text", text: "Hello!" }] },
    );
    s.seenCatalogue.set("https://x/p.html", { url: "https://x/p.html", kind: "product", title: "P", category: "", price_text: "₹4,50,000", specs: {}, description: "", related_links: [] });
    s.pendingNotes = ["note"];
    s.turns = 1;
    store.save(s);

    // A fresh store (e.g. after a restart) loads the same state from the database.
    const reloaded = new SessionStore(db).get("persist-0001");
    expect(reloaded.messages).toEqual(s.messages);
    expect(reloaded.seenCatalogue.get("https://x/p.html")?.price_text).toBe("₹4,50,000");
    expect(reloaded.pendingNotes).toEqual(["note"]);
    expect(reloaded.turns).toBe(1);
  });

  it("keeps OTP progress across restarts", () => {
    const db = new ChatDb(":memory:");
    const store = new SessionStore(db);
    const s = store.get("persist-otp-1");
    executeTool(s, "send_otp", { mobile: "9876543210" }, { saveLead: () => {} });
    store.save(s);
    const again = new SessionStore(db).get("persist-otp-1");
    expect(again.lead).toMatchObject({ stage: "otp_sent", mobile: "9876543210", otpSends: 1 });
  });

  it("starts a fresh chat when the stored session is older than the TTL", () => {
    const db = new ChatDb(":memory:");
    const store = new SessionStore(db, 1000);
    const s = store.get("persist-old-1");
    s.turns = 5;
    s.lastSeen = Date.now() - 5000;
    db.saveSession({ ...s, seenCatalogue: [], lead: s.lead, messages: [] });
    expect(new SessionStore(db, 1000).get("persist-old-1").turns).toBe(0);
  });

  it("stores leads, transcripts and guardrail events", () => {
    const db = new ChatDb(":memory:");
    db.insertLead({ createdAt: "2026-10-09T10:00:00.000Z", sessionId: "s1", mobile: "9876543210", name: "Ramesh", product: "Press Brake", requirements: "100 ton", quantity: "1", city: "Rajkot" });
    expect(db.listLeads()).toEqual([expect.objectContaining({ id: 1, name: "Ramesh", mobile: "9876543210", pageUrl: undefined })]);

    db.appendTranscript({ sessionId: "s1", role: "buyer", text: "hi" });
    db.appendTranscript({ sessionId: "s1", role: "bot", text: "Hello", guardrails: ["G2_freight"] });
    expect(db.transcript("s1").map((t) => [t.role, t.text, t.guardrails])).toEqual([
      ["buyer", "hi", null],
      ["bot", "Hello", "G2_freight"],
    ]);

    db.logGuardrailEvents("s1", [{ rule: "G1_price", original: "costs ₹9" }]);
    expect(db.guardrailEvents()[0]).toMatchObject({ session_id: "s1", rule: "G1_price" });
  });

  it("prunes idle sessions but keeps leads", () => {
    const db = new ChatDb(":memory:");
    const now = Date.now();
    const base = { messages: [], lead: {}, seenCatalogue: [], pendingNotes: [], lastQuery: "", turns: 0, createdAt: now };
    db.saveSession({ ...base, id: "old", lastSeen: now - 40 * 86_400_000 });
    db.saveSession({ ...base, id: "new", lastSeen: now });
    db.insertLead({ createdAt: "x", sessionId: "old", mobile: "9", name: "n", product: "p", requirements: "", quantity: "", city: "" });
    expect(db.pruneSessions(30, now)).toBe(1);
    expect(db.loadSession("old")).toBeNull();
    expect(db.loadSession("new")).not.toBeNull();
    expect(db.listLeads()).toHaveLength(1);
  });
});
