/**
 * Evidence segmentation tests (Phase 1 acceptance check 5; ADR-003).
 *
 * These pin the READMAP evidence layer to the converter's REAL Markdown
 * grammar — `## Page N` per PDF page, `## Slide N — Title` per PPTX slide,
 * plain ATX headings for DOCX. If the converter's output contract ever
 * changes, these must fail loudly.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ConvertedDocumentV1Schema } from "../schemas/evidence";
import { segmentDocument } from "./segment";

// Mirrors converter/app/converters/pdf.py `_convert_page` output shape.
const PDF_MARKDOWN = [
  "## Page 1",
  "Quarterly Review",
  "",
  "Revenue grew 12% year over year.",
  "",
  "| Metric | 2025 | 2026 |",
  "| --- | --- | --- |",
  "| Revenue | 100 | 112 |",
  "",
  "---",
  "## Page 2",
  "### Risks",
  "- Supply concentration",
  "- Currency exposure",
  "",
  "Management expects moderate growth.",
].join("\n");

// Mirrors converter/app/converters/pptx.py `_convert_slide` output shape.
const PPTX_MARKDOWN = [
  "---",
  "## Slide 1",
  "Overview deck for the board.",
  "---",
  "## Slide 2 — Revenue",
  "- ARR up 12%",
  "Churn is stable.",
].join("\n");

// DOCX: Pandoc headings, no page anchors.
const DOCX_MARKDOWN = [
  "# Market Study",
  "Intro paragraph.",
  "",
  "## Findings",
  "Growth of 8% CAGR is forecast.",
].join("\n");

const hash = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

describe("segmentDocument — PDF grammar", () => {
  const doc = segmentDocument({
    markdown: PDF_MARKDOWN,
    filename: "report.pdf",
    sourceType: "pdf",
    pagesOrSlides: 2,
  });

  it("produces the expected block sequence with stable ids", () => {
    expect(doc.blocks.map((b) => b.id)).toEqual([
      "b0001",
      "b0002",
      "b0003",
      "b0004",
      "b0005",
      "b0006",
      "b0007",
      "b0008",
    ]);
    expect(doc.blocks.map((b) => b.blockType)).toEqual([
      "HEADING",
      "PARAGRAPH",
      "PARAGRAPH",
      "TABLE",
      "HEADING",
      "HEADING",
      "LIST",
      "PARAGRAPH",
    ]);
  });

  it("anchors every block to its page and never invents slide numbers", () => {
    expect(doc.blocks[0]?.normalizedText).toBe("Page 1");
    expect(doc.blocks[0]?.pageNumber).toBe(1);
    expect(doc.blocks.slice(0, 4).every((b) => b.pageNumber === 1)).toBe(true);
    expect(doc.blocks.slice(4).every((b) => b.pageNumber === 2)).toBe(true);
    expect(doc.blocks.every((b) => b.slideNumber === undefined)).toBe(true);
  });

  it("keeps table rows and list items as structured evidence", () => {
    const table = doc.blocks[3];
    expect(table?.sourceText.split("\n")).toHaveLength(3);
    expect(table?.normalizedText).toContain("| Revenue | 100 | 112 |");
    const list = doc.blocks[6];
    expect(list?.normalizedText).toBe(
      "- Supply concentration\n- Currency exposure",
    );
  });

  it("carries section paths from headings", () => {
    expect(doc.blocks[6]?.sectionPath).toEqual(["Risks"]);
    expect(doc.blocks[7]?.sectionPath).toEqual(["Risks"]);
    expect(doc.blocks[7]?.normalizedText).toBe(
      "Management expects moderate growth.",
    );
  });

  it("reports no warning when anchors match the page count", () => {
    expect(doc.warnings).toEqual([]);
  });
});

describe("segmentDocument — PPTX grammar", () => {
  const doc = segmentDocument({
    markdown: PPTX_MARKDOWN,
    filename: "deck.pptx",
    sourceType: "pptx",
    pagesOrSlides: 2,
  });

  it("preserves slide titles and slide anchors", () => {
    expect(doc.blocks[2]?.normalizedText).toBe("Slide 2 — Revenue");
    expect(doc.blocks[2]?.slideNumber).toBe(2);
    expect(doc.blocks.every((b) => b.pageNumber === undefined)).toBe(true);
    expect(doc.blocks.slice(3).every((b) => b.slideNumber === 2)).toBe(true);
    expect(doc.warnings).toEqual([]);
  });
});

describe("segmentDocument — DOCX grammar", () => {
  const doc = segmentDocument({
    markdown: DOCX_MARKDOWN,
    filename: "study.docx",
    sourceType: "docx",
    pagesOrSlides: null,
  });

  it("builds heading-hierarchy section paths without page anchors", () => {
    expect(doc.blocks.every((b) => b.pageNumber === undefined)).toBe(true);
    expect(doc.blocks.every((b) => b.slideNumber === undefined)).toBe(true);
    expect(doc.blocks[3]?.normalizedText).toBe(
      "Growth of 8% CAGR is forecast.",
    );
    expect(doc.blocks[3]?.sectionPath).toEqual(["Market Study", "Findings"]);
  });
});

describe("segmentDocument — integrity and honesty", () => {
  it("is fully deterministic for identical input", () => {
    const a = segmentDocument({
      markdown: PDF_MARKDOWN,
      filename: "report.pdf",
      sourceType: "pdf",
      pagesOrSlides: 2,
    });
    const b = segmentDocument({
      markdown: PDF_MARKDOWN,
      filename: "report.pdf",
      sourceType: "pdf",
      pagesOrSlides: 2,
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("hashes every block over its exact source text", () => {
    const doc = segmentDocument({
      markdown: PDF_MARKDOWN,
      filename: "report.pdf",
      sourceType: "pdf",
      pagesOrSlides: 2,
    });
    for (const block of doc.blocks) {
      expect(block.contentHash).toBe(hash(block.sourceText));
    }
  });

  it("always validates against the versioned contract", () => {
    const doc = segmentDocument({
      markdown: DOCX_MARKDOWN,
      filename: "study.docx",
      sourceType: "docx",
      pagesOrSlides: null,
    });
    expect(ConvertedDocumentV1Schema.safeParse(doc).success).toBe(true);
  });

  it("warns when anchors do not match the reported page count", () => {
    const doc = segmentDocument({
      markdown: PDF_MARKDOWN,
      filename: "report.pdf",
      sourceType: "pdf",
      pagesOrSlides: 3,
      converterWarnings: ["Page 2 tables could not be extracted."],
    });
    expect(doc.warnings).toContain(
      "Converted text ends at page/slide 2, but the document reports 3.",
    );
    expect(doc.warnings).toContain("Page 2 tables could not be extracted.");
  });

  it("warns when no anchors exist but a page count was claimed", () => {
    const doc = segmentDocument({
      markdown: "Just plain text, no anchors.",
      filename: "odd.pdf",
      sourceType: "pdf",
      pagesOrSlides: 5,
    });
    expect(doc.warnings).toContain(
      "No page or slide anchors were found; page-level citations are unavailable.",
    );
  });

  it("reports empty input honestly instead of inventing content", () => {
    const doc = segmentDocument({
      markdown: "",
      filename: "blank.pdf",
      sourceType: "pdf",
      pagesOrSlides: 1,
    });
    expect(doc.blocks).toEqual([]);
    expect(doc.warnings).toContain(
      "Converted text contained no extractable content.",
    );
  });
});


