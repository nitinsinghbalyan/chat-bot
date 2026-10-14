import { describe, expect, it } from "vitest";
import { ChatDb } from "../src/db.js";
import { SessionStore } from "../src/session.js";
import { executeTool } from "../src/tools.js";

describe("ChatDb", () => {
  it("round-trips a session, including thinking blocks and catalogue hits", () => {
    const db = new ChatDb(":memory:");
    const store = new SessionStore(db);
    const s = store.get("alpha", "persist-0001");
    s.messages.push(
      { role: "user", content: [{ type: "text", text: "<buyer_message>hi</buyer_message>" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig-abc" } as any, { type: "text", text: "Hello!" }] },
    );
    s.seenCatalogue.set("https://x/p.html", { url: "https://x/p.html", kind: "product", title: "P", category: "", price_text: "₹4,50,000", specs: {}, description: "", related_links: [] });
    s.pendingNotes = ["note"];
    s.turns = 1;
    store.save(s);

    // A fresh store (e.g. after a restart) loads the same state from the database.
    const reloaded = new SessionStore(db).get("alpha", "persist-0001");
    expect(reloaded.messages).toEqual(s.messages);
    expect(reloaded.seenCatalogue.get("https://x/p.html")?.price_text).toBe("₹4,50,000");
    expect(reloaded.pendingNotes).toEqual(["note"]);
    expect(reloaded.turns).toBe(1);
  });

  it("keeps OTP progress across restarts", () => {
    const db = new ChatDb(":memory:");
    const store = new SessionStore(db);
    const s = store.get("alpha", "persist-otp-1");
    executeTool(s, "send_otp", { mobile: "9876543210" }, { saveLead: () => {} });
    store.save(s);
    const again = new SessionStore(db).get("alpha", "persist-otp-1");
    expect(again.lead).toMatchObject({ stage: "otp_sent", mobile: "9876543210", otpSends: 1 });
  });

  it("starts a fresh chat when the stored session is older than the TTL", () => {
    const db = new ChatDb(":memory:");
    const store = new SessionStore(db, 1000);
    const s = store.get("alpha", "persist-old-1");
    s.turns = 5;
    s.lastSeen = Date.now() - 5000;
    db.saveSession({ ...s, seenCatalogue: [], lead: s.lead, messages: [] });
    expect(new SessionStore(db, 1000).get("alpha", "persist-old-1").turns).toBe(0);
  });

  it("stores leads, transcripts and guardrail events", () => {
    const db = new ChatDb(":memory:");
    db.insertLead({ createdAt: "2026-10-09T10:00:00.000Z", seller: "alpha", sessionId: "alpha:s1", mobile: "9876543210", name: "Ramesh", product: "Press Brake", requirements: "100 ton", quantity: "1", city: "Rajkot" });
    expect(db.listLeads()).toEqual([expect.objectContaining({ id: 1, name: "Ramesh", mobile: "9876543210", pageUrl: undefined })]);

    db.appendTranscript({ seller: "alpha", sessionId: "alpha:s1", role: "buyer", text: "hi" });
    db.appendTranscript({ seller: "alpha", sessionId: "alpha:s1", role: "bot", text: "Hello", guardrails: ["G2_freight"] });
    expect(db.transcript("alpha:s1").map((t) => [t.role, t.text, t.guardrails])).toEqual([
      ["buyer", "hi", null],
      ["bot", "Hello", "G2_freight"],
    ]);

    db.logGuardrailEvents("alpha", "alpha:s1", [{ rule: "G1_price", original: "costs ₹9" }]);
    expect(db.guardrailEvents()[0]).toMatchObject({ seller: "alpha", session_id: "alpha:s1", rule: "G1_price" });
  });

  it("prunes idle sessions but keeps leads", () => {
    const db = new ChatDb(":memory:");
    const now = Date.now();
    const base = { seller: "alpha", messages: [], lead: {}, seenCatalogue: [], pendingNotes: [], lastQuery: "", turns: 0, createdAt: now };
    db.saveSession({ ...base, id: "old", lastSeen: now - 40 * 86_400_000 });
    db.saveSession({ ...base, id: "new", lastSeen: now });
    db.insertLead({ createdAt: "x", seller: "alpha", sessionId: "old", mobile: "9", name: "n", product: "p", requirements: "", quantity: "", city: "" });
    expect(db.pruneSessions(30, now)).toBe(1);
    expect(db.loadSession("old")).toBeNull();
    expect(db.loadSession("new")).not.toBeNull();
    expect(db.listLeads()).toHaveLength(1);
  });
});

describe("migration from the single-seller database", () => {
  it("adds the seller column, assigns old rows to Jayshree and keeps sessions and links working", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const Database = (await import("better-sqlite3")).default;
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "chatdb-")), "chatbot.db");

    // Schema and rows as written by the previous release.
    const old = new Database(file);
    old.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, messages TEXT NOT NULL, lead TEXT NOT NULL, seen_catalogue TEXT NOT NULL,
        pending_notes TEXT NOT NULL, last_query TEXT NOT NULL DEFAULT '', turns INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
      CREATE TABLE transcript (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, guardrails TEXT, at TEXT NOT NULL);
      CREATE TABLE leads (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, session_id TEXT NOT NULL, mobile TEXT NOT NULL, name TEXT NOT NULL,
        product TEXT NOT NULL, requirements TEXT NOT NULL, quantity TEXT NOT NULL, city TEXT NOT NULL, page_url TEXT);
      CREATE TABLE guardrail_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, session_id TEXT NOT NULL, rule TEXT NOT NULL, original TEXT NOT NULL);
    `);
    const now = Date.now();
    old.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, '', 3, ?, ?)").run("browser-1", "[]", JSON.stringify({ stage: "captured", otpAttempts: 0, otpSends: 1 }), "[]", "[]", now, now);
    old.prepare("INSERT INTO transcript (session_id, role, text, at) VALUES ('browser-1', 'buyer', 'hello', 'x')").run();
    old.prepare("INSERT INTO leads (created_at, session_id, mobile, name, product, requirements, quantity, city) VALUES ('x', 'browser-1', '9876543210', 'Ramesh', 'Press', '', '', '')").run();
    old.prepare("INSERT INTO guardrail_events (at, session_id, rule, original) VALUES ('x', 'browser-1', 'G2_freight', 'free freight')").run();
    old.close();

    const db = new ChatDb(file);
    const session = new SessionStore(db).get("jayshree-machinetools", "browser-1");
    expect(session.turns).toBe(3);
    expect(session.lead.stage).toBe("captured");
    expect(db.listLeads(10, "jayshree-machinetools")).toEqual([expect.objectContaining({ seller: "jayshree-machinetools", sessionId: "jayshree-machinetools:browser-1" })]);
    expect(db.transcript("jayshree-machinetools:browser-1")).toHaveLength(1);
    expect(db.guardrailEvents(10, "jayshree-machinetools")[0]).toMatchObject({ session_id: "jayshree-machinetools:browser-1" });
    db.close();

    // Opening again is a no-op (no double prefixes).
    const again = new ChatDb(file);
    expect(again.listLeads()[0].sessionId).toBe("jayshree-machinetools:browser-1");
    again.close();
  });

  it("keeps sellers' leads and sessions apart", () => {
    const db = new ChatDb(":memory:");
    const store = new SessionStore(db);
    const a = store.get("alpha", "same-browser");
    const b = store.get("beta", "same-browser");
    expect(a).not.toBe(b);
    a.turns = 2;
    store.save(a);
    store.save(b);
    expect(new SessionStore(db).get("beta", "same-browser").turns).toBe(0);
    db.insertLead({ createdAt: "x", seller: "alpha", sessionId: a.id, mobile: "1", name: "A", product: "", requirements: "", quantity: "", city: "" });
    db.insertLead({ createdAt: "x", seller: "beta", sessionId: b.id, mobile: "2", name: "B", product: "", requirements: "", quantity: "", city: "" });
    expect(db.listLeads(10, "alpha").map((l) => l.name)).toEqual(["A"]);
    expect(db.leadCounts()).toEqual({ alpha: 1, beta: 1 });
  });
});

describe("seller prompts", () => {
  it("round-trips a seller's brand persona and deletes it when both are cleared", () => {
    const db = new ChatDb(":memory:");
    expect(db.getPrompts("alpha")).toEqual({ system: "", user: "", updatedAt: null });
    db.savePrompts("alpha", { system: "Be Jay.", user: "Ask thickness." });
    db.savePrompts("alpha", { system: "Be Jay, briefly.", user: "Ask thickness." });
    expect(db.getPrompts("alpha")).toMatchObject({ system: "Be Jay, briefly.", user: "Ask thickness." });
    expect(db.getPrompts("beta").system).toBe("");
    db.savePrompts("alpha", { system: " ", user: "" });
    expect(db.getPrompts("alpha").updatedAt).toBeNull();
  });

  it("updates a session's lead when save_lead runs again after the ISQs", () => {
    const db = new ChatDb(":memory:");
    const lead = { createdAt: "2026-10-14T10:00:00Z", seller: "alpha", sessionId: "alpha:s1", mobile: "9876543210", name: "Ramesh", product: "Press Brake", requirements: "", quantity: "", city: "" };
    db.insertLead(lead);
    expect(db.updateLead("alpha", "alpha:s1", { product: "CNC Press Brake", requirements: "CNC, 3 m", quantity: "1", city: "Rajkot" })).toBe(true);
    expect(db.updateLead("alpha", "alpha:other", { product: "", requirements: "", quantity: "", city: "" })).toBe(false);
    expect(db.listLeads()).toHaveLength(1);
    expect(db.listLeads()[0]).toMatchObject({ name: "Ramesh", product: "CNC Press Brake", requirements: "CNC, 3 m", city: "Rajkot" });
  });
});
