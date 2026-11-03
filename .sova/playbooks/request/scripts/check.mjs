#!/usr/bin/env node
// Check a drafted request's title and description against this kit's house style. The merge queue runs it with
//   {"title", "body", "host", "branch", "base"}
// as JSON on stdin, this folder as the working directory, and no host sign-in. Exit 0: the text passes. Any other
// exit: it is sent back to be rewritten, with the first lines this printed on stderr as the reason. Writes nothing.
// Self-contained: node's own modules only.
import { fileURLToPath } from "node:url";

export const TITLE_MAX = 72;
export const SECTIONS = ["## Why", "## What changes", "## Checks"];

/** null when the text passes, else what to fix (one sentence). */
export function problem(t) {
  if (!t || typeof t !== "object") return "the input must be an object with title and body";
  const title = typeof t.title === "string" ? t.title.trim() : "";
  const body = typeof t.body === "string" ? t.body : "";
  if (!title) return "the title is empty";
  if (title.length > TITLE_MAX) return `the title is ${title.length} characters; keep it to ${TITLE_MAX}`;
  if (/\.$/.test(title)) return "the title ends with a period; drop it";
  if (/\bwip\b/i.test(title)) return "the title says WIP; a request Sova opens is ready";
  if (!/^[A-Z]/.test(title)) return "the title starts with a capital letter (a verb, or the area then a colon)";
  for (const s of SECTIONS) if (!body.split("\n").some((l) => l.trim() === s)) return `the description has no "${s}" section`;
  if (!/Opened by Sova\s*$/.test(body)) return 'the description must end with "Opened by Sova"';
  return null;
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.stderr.write("check: the input isn't JSON\n");
    return 2;
  }
  const why = problem(input);
  if (why) {
    process.stderr.write(`${why}\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main();
