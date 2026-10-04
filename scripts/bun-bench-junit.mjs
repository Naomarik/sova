#!/usr/bin/env node
// Summarise a `bun test --reporter=junit` file: totals, per-file times, failures with their first message line.
// Usage: node scripts/bun-bench-junit.mjs <junit.xml> [out.json]
import fs from "node:fs";

const [file, out] = process.argv.slice(2);
const xml = fs.readFileSync(file, "utf8");
const unesc = (s) => s.replace(/&#10;/g, "\n").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const attr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const files = [];
for (const m of xml.matchAll(/^  <testsuite [^>]*>/gm)) {
	const t = m[0];
	files.push({ file: unesc(attr(t, "file")), tests: +attr(t, "tests"), failures: +attr(t, "failures"), skipped: +attr(t, "skipped"), ms: Math.round(+attr(t, "time") * 1000) });
}
const failures = [];
for (const m of xml.matchAll(/<testcase ([^>]*)>\s*<failure ([^>]*)/g)) {
	const msg = unesc(attr(m[2], "message") ?? "").split("\n").find((l) => l.trim()) ?? "";
	failures.push({ file: unesc(attr(m[1], "file")), test: unesc(attr(m[1], "name")), ms: Math.round(+attr(m[1], "time") * 1000), type: attr(m[2], "type"), first: msg.slice(0, 300) });
}
const top = xml.match(/<testsuites [^>]*>/)[0];
const summary = { tests: +attr(top, "tests"), failures: +attr(top, "failures"), skipped: +attr(top, "skipped"), seconds: +attr(top, "time"), files: files.length, failedFiles: files.filter((f) => f.failures).length };
const result = { summary, slowest: [...files].sort((a, b) => b.ms - a.ms).slice(0, 15), failures, files };
if (out) fs.writeFileSync(out, JSON.stringify(result, null, 1));
console.log(JSON.stringify(summary));
const byFile = new Map();
for (const f of failures) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
for (const [f, list] of byFile) console.log(`${f} (${list.length}): ${list[0].first}`);
