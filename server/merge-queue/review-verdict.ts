/**
 * The shape of a reviewer's verdict, checked by merge.review before it is taken (the reviewer has no shell, so the
 * check is Sova's, not a kit script's). The text is a one-sentence summary, then one line per finding:
 * `- [kind] file:line: text` (file and line optional). ok carries no finding; notes and blocking at least one; at
 * most 10. A refusal says what is wrong, so the reviewer fixes it and answers again.
 */
import { REVIEW_KINDS, type ReviewFinding, type ReviewKind } from "../../shared/merge-queue";

export { REVIEW_KINDS, type ReviewFinding, type ReviewKind };
export const MAX_FINDINGS = 10;
export const SUMMARY_MAX = 300;
export const FINDING_MAX = 400;
/** A finding's file path, at most this long. */
export const PATH_MAX = 500;
/** The longest text the format allows (summary, then each finding with its kind, path and line), rounded up: the verb's
 *  own length limit on merge.review's text, so a valid review is never refused before it is checked. */
export const REVIEW_TEXT_LIMIT = SUMMARY_MAX + MAX_FINDINGS * (FINDING_MAX + PATH_MAX + 40) + 1000;

const FINDING = /^- \[([^\]]*)\]\s+(?:([^\s:]+)(?::(\d+))?:\s+)?(.*)$/;

/** The format, as a refusal names it. */
export const REVIEW_FORMAT = `a one-sentence summary, then one line per finding: "- [kind] file:line: text" (kinds: ${REVIEW_KINDS.join(", ")})`;

/** One finding line, or what is wrong with it. */
function findingOf(line: string, at: string): ReviewFinding | string {
  const m = FINDING.exec(line);
  if (!m) return `${at} must read "- [kind] file:line: text"`;
  const kind = m[1]!.trim();
  if (!(REVIEW_KINDS as readonly string[]).includes(kind)) return `${at}: kind must be one of ${REVIEW_KINDS.join(", ")}`;
  if (m[2] && m[2].length > PATH_MAX) return `${at}: file must be at most ${PATH_MAX} characters`;
  if (m[3] !== undefined && Number(m[3]) < 1) return `${at}: line must be a positive whole number`;
  const text = m[4]!.trim();
  if (!text) return `${at}: text is required`;
  if (text.length > FINDING_MAX) return `${at}: text must be at most ${FINDING_MAX} characters`;
  return { kind: kind as ReviewKind, ...(m[2] ? { file: m[2] } : {}), ...(m[3] ? { line: Number(m[3]) } : {}), text };
}

/**
 * A verdict's text checked: `{ text, summary, findings }` as kept (trimmed, blank lines dropped, whole: the format's
 * own limits bound it), or `{ why }` saying what is wrong. ok may carry a bare summary or nothing.
 */
export function checkReviewText(verdict: "ok" | "notes" | "blocking", raw: string | undefined): { text: string; summary: string; findings: ReviewFinding[] } | { why: string } {
  const lines = (raw ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return verdict === "ok" ? { text: "", summary: "", findings: [] } : { why: `a ${verdict} verdict needs ${REVIEW_FORMAT}` };
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
  return { text, summary, findings };
}
