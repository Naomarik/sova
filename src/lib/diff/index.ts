// The diff engine: parse patches, diff texts, and render hunks to highlighted, word-marked rows.

export * from "./types";
export { parseUnifiedPatch, fromStructuredPatch, isStructuredPatch, patchStats, type StructuredHunk } from "./parse";
export { lineDiff, hunksFromOps, diffTexts, diffSnippets, addedFile, type Op } from "./line-diff";
export { pairLines, similarity, wordDiff, type Range } from "./intraline";
export { splitHighlighted, markRanges } from "./highlight";
export { renderFile, splitRows, highlightLines, viewKey, BIG_DIFF_ROWS, type RenderedFile, type RenderedHunk, type RenderedRow, type RenderedGap, type SplitRow } from "./render";
