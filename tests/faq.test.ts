import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FaqIndex, faqRowsFor, FaqStore, parseCsv, parseFaq } from "../src/faq.js";

const xlsx = fs.readFileSync(path.join(__dirname, "fixtures", "faq.xlsx"));

describe("parseFaq", () => {
  it("reads the first sheet of an Excel file, leaving out rows that state a price", async () => {
    const r = await parseFaq(xlsx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.format).toBe("xlsx");
    expect(r.value).toHaveLength(3);
    expect(r.value[1]).toEqual({ question: "What warranty do press brakes come with?", answer: "Press brakes come with a one-year warranty on the machine.", categories: ["Press Brakes"] });
    expect(r.summary).toBe("3 questions, 2 for specific categories");
    expect(r.warnings.join(" ")).toMatch(/Row 5 left out: the answer states a price/);
  });

  it("reads CSV with header aliases, quotes and several categories", async () => {
    const csv = 'FAQ,Response,MCAT\n"Do you export?","Yes, ""worldwide"".","Press Brake; Shearing Machine"\nNo answer here,,\n"Is GST extra?","Our team confirms tax details.",\n';
    const r = await parseFaq(Buffer.from(csv));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.format).toBe("csv");
    expect(r.value[0]).toEqual({ question: "Do you export?", answer: 'Yes, "worldwide".', categories: ["Press Brake", "Shearing Machine"] });
    expect(r.warnings).toEqual([
      "1 row skipped: a question or answer is missing.",
      "Row 4 mention tax, delivery, payment, discount or stock. The bot still follows the guardrails, so it won't state those terms; check the wording.",
    ]);
  });

  it("explains what's wrong with an unusable file", async () => {
    expect(await parseFaq(Buffer.alloc(0))).toMatchObject({ ok: false });
    const noHeader = await parseFaq(Buffer.from("hello,world\nfoo,bar\n"));
    expect(noHeader.ok).toBe(false);
    if (!noHeader.ok) expect(noHeader.errors[0]).toMatch(/No header row found/);
    expect(parseCsv('a,"b\nc"\r\nd,e')).toEqual([["a", "b\nc"], ["d", "e"]]);
  });
});

describe("FAQ per seller", () => {
  const rows = [
    { question: "Do you install?", answer: "Yes, {seller_name} installs it.", categories: [] },
    { question: "Press brake warranty?", answer: "One year.", categories: ["Press Brakes"] },
    { question: "Road roller sizes?", answer: "3 to 10 ton.", categories: ["Road Roller"] },
  ];

  it("keeps rows for every seller and rows for categories the seller deals in, with the name filled in", () => {
    const mine = faqRowsFor(rows, { names: ["CNC Press Brake"], mcatIds: new Set() }, "Alpha Presses");
    expect(mine.map((r) => r.question)).toEqual(["Do you install?", "Press brake warranty?"]);
    expect(mine[0].answer).toBe("Yes, Alpha Presses installs it.");
    // Matched MCAT names count too.
    expect(faqRowsFor(rows, { names: [], mcatIds: new Set(), mcats: ["Road Rollers"] }, "X").map((r) => r.question)).toContain("Road roller sizes?");
  });

  it("finds the rows a buyer message is about, and nothing for unrelated messages", () => {
    const index = new FaqIndex(faqRowsFor(rows, { names: ["Press Brake"], mcatIds: new Set() }, "Alpha"));
    expect(index.search("do you do installation at site?").map((r) => r.question)).toEqual(["Do you install?"]);
    expect(index.search("what warranty on the press brake")[0].question).toBe("Press brake warranty?");
    expect(index.search("hi")).toEqual([]);
  });

  it("loads the stored file and rebuilds a seller's index when the FAQ or their knowledge changes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "faq-"));
    fs.writeFileSync(path.join(dir, "faq.xlsx"), xlsx);
    const store = await FaqStore.load(dir);
    expect(store.file?.format).toBe("xlsx");
    const kb = {};
    const terms = { names: ["Press Brake"], mcatIds: new Set<string>() };
    const a = store.forSeller(kb, terms, "Alpha")!;
    expect(a.size).toBe(2);
    expect(store.forSeller(kb, terms, "Alpha")).toBe(a);
    expect(store.forSeller({}, terms, "Alpha")).not.toBe(a);
    store.set(null);
    expect(store.forSeller(kb, terms, "Alpha")).toBeNull();
    expect((await FaqStore.load(fs.mkdtempSync(path.join(os.tmpdir(), "faq-")))).file).toBeNull();
  });
});
