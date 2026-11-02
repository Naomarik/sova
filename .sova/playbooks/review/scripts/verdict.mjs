#!/usr/bin/env node
// Write the review step's verdict file, refusing a malformed one.
//
//   node verdict.mjs --out <file> --verdict ok|notes|blocking --summary "<sentence>" [--finding '<json>' …]
//
// A finding is {"file"?: string, "line"?: positive integer, "kind": dead-code|duplication|hack|
// missing-test|naming|other, "text": string ≤ 400}. At most 10 findings. "ok" carries none; "notes"
// and "blocking" carry at least one. Writes {"verdict","summary","findings":[…]} atomically and prints
// it; exit 0 written, 1 refused (the reason on stderr). Self-contained: node's own modules only.
import { renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const VERDICTS = ["ok", "notes", "blocking"];
export const KINDS = ["dead-code", "duplication", "hack", "missing-test", "naming", "other"];
export const MAX_FINDINGS = 10;

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

function main(argv) {
  let out;
  const v = { findings: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--out") out = next();
    else if (a === "--verdict") v.verdict = next();
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
  out ??= process.env.SOVA_REVIEW_OUT;
  if (!out) {
    process.stderr.write("verdict: --out (or SOVA_REVIEW_OUT) is required\n");
    return 1;
  }
  const r = validate(v);
  if (typeof r === "string") {
    process.stderr.write(`verdict: refused: ${r}\n`);
    return 1;
  }
  const text = `${JSON.stringify(r, null, 2)}\n`;
  const tmp = `${out}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, out);
  process.stdout.write(text);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
