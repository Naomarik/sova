/**
 * The shape of a reviewer's verdict, checked by merge.review before it is taken (the reviewer has no shell, so the
 * check is Sova's, not a kit script's). The text is a one-sentence summary, then one line per finding:
 * `- [kind] file:line: text` (file and line optional). ok carries no finding; notes and blocking at least one; at
 * most 10. A refusal says what is wrong, so the reviewer fixes it and answers again.
 */
export const REVIEW_KINDS = ["dead-code", "duplication", "hack", "missing-test", "naming", "other"] as const;
export const MAX_FINDINGS = 10;
export const SUMMARY_MAX = 300;
export const FINDING_MAX = 400;
/** The whole text, as kept: a longer one ends in "…". */
export const REVIEW_TEXT_MAX = 2000;

export type ReviewKind = (typeof REVIEW_KINDS)[number];
export interface ReviewFinding {
  kind: ReviewKind;
  file?: string;
  line?: number;
  text: string;
}

const FINDING = /^- \[([^\]]*)\]\s+(?:([^\s:]+)(?::(\d+))?:\s+)?(.*)$/;

/** The format, as a refusal names it. */
export const REVIEW_FORMAT = `a one-sentence summary, then one line per finding: "- [kind] file:line: text" (kinds: ${REVIEW_KINDS.join(", ")})`;

/** One finding line, or what is wrong with it. */
function findingOf(line: string, at: string): ReviewFinding | string {
  const m = FINDING.exec(line);
  if (!m) return `${at} must read "- [kind] file:line: text"`;
  const kind = m[1]!.trim();
  if (!(REVIEW_KINDS as readonly string[]).includes(kind)) return `${at}: kind must be one of ${REVIEW_KINDS.join(", ")}`;
  if (m[3] !== undefined && Number(m[3]) < 1) return `${at}: line must be a positive whole number`;
  const text = m[4]!.trim();
  if (!text) return `${at}: text is required`;
  if (text.length > FINDING_MAX) return `${at}: text must be at most ${FINDING_MAX} characters`;
  return { kind: kind as ReviewKind, ...(m[2] ? { file: m[2] } : {}), ...(m[3] ? { line: Number(m[3]) } : {}), text };
}

/**
 * A verdict's text checked: `{ text }` as kept (trimmed, blank lines dropped, capped), or `{ why }` saying what is
 * wrong. ok may carry a bare summary or nothing.
 */
export function checkReviewText(verdict: "ok" | "notes" | "blocking", raw: string | undefined): { text: string; findings: ReviewFinding[] } | { why: string } {
  const lines = (raw ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return verdict === "ok" ? { text: "", findings: [] } : { why: `a ${verdict} verdict needs ${REVIEW_FORMAT}` };
  const [summary, ...rest] = lines as [string, ...string[]];
  if (summary.startsWith("- [")) return { why: `the text starts with its summary: ${REVIEW_FORMAT}` };
  if (summary.length > SUMMARY_MAX) return { why: `the summary must be at most ${SUMMARY_MAX} characters` };
  const findings: ReviewFinding[] = [];
  for (const [i, line] of rest.entries()) {
    const f = findingOf(line, `finding ${i + 1}`);
    if (typeof f === "string") return { why: f };
    findings.push(f);
  }
  if (findings.length > MAX_FINDINGS) return { why: `at most ${MAX_FINDINGS} findings` };
  if (verdict === "ok" && findings.length) return { why: "an ok verdict carries no findings (use notes)" };
  if (verdict !== "ok" && !findings.length) return { why: `a ${verdict} verdict needs at least one finding: ${REVIEW_FORMAT}` };
  const text = [summary, ...findings.map((f) => `- [${f.kind}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""}: ` : ""}${f.text}`)].join("\n");
  return { text: text.length <= REVIEW_TEXT_MAX ? text : `${text.slice(0, REVIEW_TEXT_MAX - 1)}…`, findings };
}
