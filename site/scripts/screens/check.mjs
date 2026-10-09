#!/usr/bin/env node
// pnpm run screens:check [-- <file>] [--format]
//
// Checks story.json (or another file) and prints every problem as
//   story.json:LINE:COL /json/pointer: message (hint)
// or a summary of what it would capture. No server, no browser, no model. --format prints the story
// in its canonical layout instead (it never rewrites the file).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkStory, formatProblems, loadStory, STORY } from "./load-story.mjs";

const args = process.argv.slice(2);
const format = args.includes("--format");
const file = resolve(args.find((a) => !a.startsWith("--")) ?? STORY);

const r = await checkStory(file);
if (r.problems.length) {
  console.error(formatProblems(r.problems, file, r.pos, r.source));
  console.error(`\n${r.problems.length} problem${r.problems.length === 1 ? "" : "s"}; nothing was generated.`);
  process.exit(1);
}
for (const w of r.warnings) console.warn(`warning: ${formatProblems([w], file, r.pos)}`);

if (format) {
  process.stdout.write(canonical(JSON.parse(readFileSync(file, "utf8"))));
  process.exit(0);
}

const { plan } = await loadStory(file);
const live = plan.sessions.filter((s) => s.live);
const byViewport = {};
for (const s of plan.shots) byViewport[s.viewport] = (byViewport[s.viewport] ?? 0) + 1;
console.log(`ok: ${file}`);
console.log(`  sessions  ${plan.sessions.length} (${plan.sessions.length - live.length} static, ${live.length} live: ${live.map((s) => s.id).join(", ")})`);
console.log(`  workers   ${Object.keys(plan.workers).length}${plan.overseer ? ", plus the Overseer" : ""}`);
console.log(`  holds     ${Object.keys(plan.holds).join(", ") || "(none)"}`);
console.log(`  shots     ${plan.shots.length} (${Object.entries(byViewport).map(([k, n]) => `${n} ${k}`).join(", ")}), dark theme`);
console.log(`  slots     ${Object.keys(plan.pageShots).length}`);
if (plan.video) console.log(`  video     ${plan.video.session}, ${plan.video.beats.length} beats, poster ${plan.video.poster}`);

/** Two-space JSON, with short leaf objects and arrays of scalars on one line when they fit. */
function canonical(v) {
  const out = (x, ind) => {
    if (x === null || typeof x !== "object") return JSON.stringify(x);
    const leaf = Object.values(x).every((y) => y === null || typeof y !== "object");
    const flat = Array.isArray(x)
      ? `[${x.map((y) => JSON.stringify(y)).join(", ")}]`
      : `{ ${Object.entries(x).map(([k, y]) => `${JSON.stringify(k)}: ${JSON.stringify(y)}`).join(", ")} }`;
    if (leaf && (Array.isArray(x) ? x.length > 0 : Object.keys(x).length > 0) && flat.length + ind.length <= 100) return flat;
    if (Array.isArray(x) && x.length === 0) return "[]";
    if (!Array.isArray(x) && Object.keys(x).length === 0) return "{}";
    const next = `${ind}  `;
    if (Array.isArray(x)) return `[\n${x.map((y) => next + out(y, next)).join(",\n")}\n${ind}]`;
    return `{\n${Object.entries(x).map(([k, y]) => `${next}${JSON.stringify(k)}: ${out(y, next)}`).join(",\n")}\n${ind}}`;
  };
  return `${out(v, "")}\n`;
}
