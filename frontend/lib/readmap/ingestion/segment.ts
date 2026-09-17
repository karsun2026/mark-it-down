/**
 * Deterministic Markdown → evidence-block segmentation (READMAP Phase 1;
 * ADR-003 in docs/readmap/ARCHITECTURE_DECISIONS.md).
 *
 * The converter's Markdown output already carries machine-parseable anchors
 * (verified during the Phase 0 audit):
 *
 *   - PDF:  a `---` separator, then `## Page N` per page
 *           (converter/app/converters/pdf.py, `_convert_page`)
 *   - PPTX: a `---` separator, then `## Slide N` or `## Slide N — Title`
 *           (converter/app/converters/pptx.py, `_convert_slide`)
 *   - DOCX: Pandoc headings only — no page anchors exist for Word documents
 *
 * This module never calls a model and never invents structure: each block
 * keeps its exact source text and a SHA-256 content hash so citations can be
 * re-verified deterministically at the grounding gate. A block without a
 * page/slide anchor simply has none — it is never guessed.
 */

import { createHash } from "node:crypto";

import {
  ConvertedDocumentV1Schema,
  type ConvertedDocumentV1,
  type EvidenceBlockInput,
  type SourceType,
} from "../schemas/evidence";

/** `## Page N` — emitted once per PDF page by the converter. */
const PAGE_ANCHOR = /^## Page (\d+)$/;
/** `## Slide N` / `## Slide N — Title` — emitted once per PPTX slide. */
const SLIDE_ANCHOR = /^## Slide (\d+)(?:\s+[—–-]\s+(.+))?$/;
/** Any other ATX heading (`#` through `######`). */
const HEADING = /^(#{1,6})\s+(\S.*)$/;
/** Markdown table row. */
const TABLE_ROW = /^\s*\|/;
/** Markdown list item: bullet or ordered. */
const LIST_ITEM = /^\s*(?:[-*]|\d+[.)])\s+/;
/** The `---` separator the converters emit before page/slide anchors. */
const HR = /^-{3,}$/;

export interface SegmentInput {
  markdown: string;
  filename: string;
  sourceType: SourceType;
  /** Page count (PDF) or slide count (PPTX); null when unknown (DOCX). */
  pagesOrSlides: number | null;
  /** Converter warnings (`ConvertResponse.warnings`), passed through. */
  converterWarnings?: string[];
}

type BlockType = EvidenceBlockInput["blockType"];

interface PendingBlock {
  type: BlockType;
  lines: string[];
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Collapse whitespace without altering wording. */
function collapse(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

/**
 * Word count over prose content only (§6-L7): page/slide anchors and `---`
 * separators are skipped entirely, and table pipes are treated as separators
 * rather than words.
 */
function countProseWords(markdown: string): number {
  let count = 0;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (line === "" || HR.test(line)) continue;
    if (PAGE_ANCHOR.test(line) || SLIDE_ANCHOR.test(line)) continue;
    count += line
      .replace(/\|/g, " ")
      .split(/\s+/)
      .filter(Boolean).length;
  }
  return count;
}

export function segmentDocument(input: SegmentInput): ConvertedDocumentV1 {
  const warnings: string[] = [...(input.converterWarnings ?? [])];
  const blocks: EvidenceBlockInput[] = [];

  let pageNumber: number | undefined;
  let slideNumber: number | undefined;
  // Heading hierarchy, so blocks carry a section path like
  // ["Market Study", "Findings"]. Reset at every page/slide anchor.
  let headingStack: { level: number; text: string }[] = [];
  let pending: PendingBlock | null = null;
  let seq = 0;

  function flushPending(): void {
    if (pending === null) {
      return;
    }
    const sourceText = pending.lines.join("\n");
    // Tables and lists keep their line structure (rows/items are meaning);
    // prose is whitespace-collapsed without rewording.
    const normalizedText =
      pending.type === "TABLE" || pending.type === "LIST"
        ? sourceText.trim()
        : collapse(sourceText);
    seq += 1;
    blocks.push({
      id: `b${String(seq).padStart(4, "0")}`,
      pageNumber,
      slideNumber,
      sectionPath: headingStack.map((entry) => entry.text),
      blockType: pending.type,
      normalizedText,
      sourceText,
      extractionMethods: ["MARKDOWN"],
      contentHash: sha256(sourceText),
    });
    pending = null;
  }

  function pushPending(type: BlockType, line: string): void {
    if (pending !== null && pending.type === type) {
      pending.lines.push(line);
      return;
    }
    flushPending();
    pending = { type, lines: [line] };
  }

  /** Headings always stand alone as their own evidence block. */
  function emitHeading(text: string): void {
    flushPending();
    pushPending("HEADING", text);
    flushPending();
  }

  for (const raw of input.markdown.split("\n")) {
    const line = raw.trimEnd();

    const pageMatch = PAGE_ANCHOR.exec(line);
    if (pageMatch) {
      pageNumber = Number(pageMatch[1]);
      slideNumber = undefined;
      // Seed the section path with the page as its base. A PDF exposes no
      // semantic markdown headings (its prose headings arrive as plain text),
      // so without this every PDF block would carry an empty sectionPath and
      // the mapper's real section names could not be validated against the
      // evidence. The base sits at level 0 so a real ATX sub-heading (levels
      // 1-6) nests under it as ["Page N", "Heading"] rather than replacing it.
      headingStack = [{ level: 0, text: `Page ${pageNumber}` }];
      emitHeading(`Page ${pageNumber}`);
      continue;
    }

    const slideMatch = SLIDE_ANCHOR.exec(line);
    if (slideMatch) {
      slideNumber = Number(slideMatch[1]);
      pageNumber = undefined;
      const title = slideMatch[2]?.trim();
      const label = title
        ? `Slide ${slideNumber} — ${title}`
        : `Slide ${slideNumber}`;
      // Same reasoning as pages: the slide is the base of the section path.
      headingStack = [{ level: 0, text: label }];
      emitHeading(label);
      continue;
    }

    if (HR.test(line)) {
      flushPending();
      continue;
    }

    const headingMatch = HEADING.exec(line);
    if (headingMatch) {
      const level = headingMatch[1]?.length ?? 1;
      const text = (headingMatch[2] ?? "").trim();
      // The heading block itself belongs to its parent section; children
      // then carry it in their path.
      emitHeading(text);
      while (
        headingStack.length > 0 &&
        (headingStack[headingStack.length - 1]?.level ?? 0) >= level
      ) {
        headingStack.pop();
      }
      headingStack.push({ level, text });
      continue;
    }

    if (line.trim() === "") {
      // Blank lines end any run. A list or table split across a blank line
      // becomes separate evidence blocks, which is fine for citation
      // granularity.
      flushPending();
      continue;
    }

    if (TABLE_ROW.test(line)) {
      pushPending("TABLE", line.trim());
      continue;
    }

    if (LIST_ITEM.test(line)) {
      pushPending("LIST", line.trim());
      continue;
    }

    pushPending("PARAGRAPH", line);
  }
  flushPending();

  // Honest coverage signals — never silently papered over.
  const lastAnchor = blocks.reduce(
    (max, block) => Math.max(max, block.pageNumber ?? block.slideNumber ?? 0),
    0,
  );
  if (blocks.length === 0) {
    warnings.push("Converted text contained no extractable content.");
  } else if (input.pagesOrSlides !== null && lastAnchor === 0) {
    warnings.push(
      "No page or slide anchors were found; page-level citations are unavailable.",
    );
  } else if (
    input.pagesOrSlides !== null &&
    lastAnchor !== input.pagesOrSlides
  ) {
    warnings.push(
      `Converted text ends at page/slide ${lastAnchor}, but the document ` +
        `reports ${input.pagesOrSlides}.`,
    );
  }

  const result: ConvertedDocumentV1 = {
    schemaVersion: "1.0",
    document: {
      filename: input.filename,
      sourceType: input.sourceType,
      pagesOrSlides: input.pagesOrSlides,
      // §6-L7: words are counted from prose only. Page/slide anchor lines and
      // the `---` separators are converter scaffolding, and table pipes are
      // formatting — counting either inflated reading-time and compression
      // statistics.
      wordCount: countProseWords(input.markdown),
    },
    blocks,
    warnings,
  };

  // Validate against the versioned contract so a bug here fails loudly
  // instead of producing evidence the grounding gate cannot resolve.
  return ConvertedDocumentV1Schema.parse(result);
}

