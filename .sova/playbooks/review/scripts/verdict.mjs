#!/usr/bin/env node
// Check the reviewer's verdict and print what to send with merge.review, refusing a malformed one.
//
//   node verdict.mjs --verdict ok|notes|blocking --summary "<sentence>" [--finding '<json>' …]
//
// A finding is {"file"?: string, "line"?: positive integer, "kind": dead-code|duplication|hack|
// missing-test|naming|other, "text": string ≤ 400}. At most 10 findings. "ok" carries none; "notes"
// and "blocking" carry at least one. Prints one JSON object {"verdict","text"}: the two values to pass
// to merge.review (text: the summary, then one line per finding, at most TEXT_MAX characters). Exit 0
// printed, 1 refused (the reason on stderr). Writes nothing. Self-contained: node's own modules only.
import { fileURLToPath } from "node:url";

export const VERDICTS = ["ok", "notes", "blocking"];
export const KINDS = ["dead-code", "duplication", "hack", "missing-test", "naming", "other"];
export const MAX_FINDINGS = 10;
export const TEXT_MAX = 2000;

/** The verdict object, or a string saying what is wrong with it. */
export function validate(v) {
  if (!v || typeof v !== "object") return "the verdict must be an object";
  if (!VERDICTS.includes(v.verdict)) return `verdict must be one of ${VERDICTS.join(", ")}`;
  if (typeof v.summary !== "string" || !v.summary.trim()) return "summary must be one sentence";
  if (v.summary.length > 300) return "summary must be at most 300 characters";
  if (!Array.isArray(v.findings)) return "findings must be a list";
  if (v.findings.length > MAX_FINDINGS) return `at most ${MAX_FINDINGS} findings`;
  if (v.verdict === "ok" && v.findings.length) return "an ok verdict carries no findings (use notes)";
  if (v.verdict !== "ok" && !v.findings.length) return `a ${v.verdict} verdict needs at least one finding`;
  for (const [i, f] of v.findings.entries()) {
    const at = `finding ${i + 1}`;
    if (!f || typeof f !== "object") return `${at} must be an object`;
    if (!KINDS.includes(f.kind)) return `${at}: kind must be one of ${KINDS.join(", ")}`;
    if (typeof f.text !== "string" || !f.text.trim()) return `${at}: text is required`;
    if (f.text.length > 400) return `${at}: text must be at most 400 characters`;
    if (f.file !== undefined && (typeof f.file !== "string" || !f.file)) return `${at}: file must be a path`;
    if (f.line !== undefined && (!Number.isInteger(f.line) || f.line < 1)) return `${at}: line must be a positive whole number`;
  }
  return { verdict: v.verdict, summary: v.summary.trim(), findings: v.findings.map((f) => ({ ...(f.file ? { file: f.file } : {}), ...(f.line ? { line: f.line } : {}), kind: f.kind, text: f.text.trim() })) };
}

/** merge.review's text for a valid verdict: the summary, then "- [kind] file:line: text" per finding. */
export function reviewText(v) {
  const lines = [v.summary, ...v.findings.map((f) => `- [${f.kind}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""}: ` : ""}${f.text}`)];
  const text = lines.join("\n");
  return text.length <= TEXT_MAX ? text : `${text.slice(0, TEXT_MAX - 1)}…`;
}

function main(argv) {
  const v = { findings: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--verdict") v.verdict = next();
    else if (a === "--summary") v.summary = next();
    else if (a === "--finding") {
      const raw = next();
      try {
        v.findings.push(JSON.parse(raw));
      } catch {
        process.stderr.write(`verdict: --finding is not JSON: ${raw}\n`);
        return 1;
      }
    } else {
      process.stderr.write(`verdict: unknown argument ${a}\n`);
      return 1;
    }
  }
  const r = validate(v);
  if (typeof r === "string") {
    process.stderr.write(`verdict: refused: ${r}\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify({ verdict: r.verdict, text: reviewText(r) })}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
