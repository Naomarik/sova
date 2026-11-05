// Run: pnpm test -- server/form-inventory.test.ts
// Every box, list and switch in Sova is drawn by the form kit (src/components/form/), so each one
// checks, shows and explains a bad value the same way. This scans src/**/*.tsx and the card toolkit
// for a control drawn by hand (<input, <textarea, <select, contenteditable) outside the kit. Each hit
// is either a named exemption below, with its reason, or counted in server/form-inventory-baseline.test.json:
// the controls not moved to the kit yet. The baseline only shrinks: a new control outside the kit
// fails here, and so does a file that now has fewer than its baseline says (lower it with
// FORM_INVENTORY_WRITE=1 pnpm test -- server/form-inventory.test.ts, which never raises a count).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const KIT = "src/components/form/";
const BASELINE = join(import.meta.dirname, "form-inventory-baseline.test.json");

/** Controls the kit doesn't draw, on purpose. The list only shrinks. */
const EXEMPT: { why: string; is(file: string, kind: string, tag: string): boolean }[] = [
  { why: "the chat message box: its own growing textarea, paste and drop", is: (f, k, t) => f === "src/components/Composer.tsx" && k === "textarea" && t.includes("composer-input") },
  { why: "file and image pickers: hidden, opened by a button", is: (_f, k, t) => k === "input" && /type="file"/.test(t) },
  { why: "the command palette's query line: a combobox over its own list", is: (f, k, t) => f === "src/components/CommandPalette.tsx" && k === "input" && t.includes('role="combobox"') },
];

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) return files(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** Exemptions that matched a control in the last scan. */
const used = new Set<string>();

/** Hand-drawn controls per file, exemptions left out. */
function scan(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const file of files("src")) {
    if (file.startsWith(KIT) || (!file.endsWith(".tsx") && !file.startsWith("src/card-toolkit/"))) continue;
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const m of text.matchAll(/<(input|textarea|select)\b|\scontent[eE]ditable\s*=\s*[{"]/g)) {
      const kind = m[1] ?? "contenteditable";
      const end = text.indexOf("/>", m.index);
      const tag = text.slice(m.index, end < 0 ? m.index + 600 : Math.min(end, m.index + 600));
      const exempt = EXEMPT.find((x) => x.is(file, kind, tag));
      if (exempt) used.add(exempt.why);
      if (exempt) continue;
      out[file] = (out[file] ?? 0) + 1;
    }
  }
  return out;
}

test("every control outside the form kit is a named exemption or in the shrinking baseline", () => {
  const now = scan();
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, number>;
  const grown = Object.entries(now).filter(([f, n]) => n > (baseline[f] ?? 0));
  assert.deepEqual(grown, [], `controls drawn by hand outside ${KIT}: draw them with the kit (TextField, NumberField, TextArea, Select, Toggle, Choice, SearchField)`);
  if (process.env.FORM_INVENTORY_WRITE) {
    const lowered = Object.fromEntries(Object.keys(baseline).filter((f) => now[f]).sort().map((f) => [f, now[f]]));
    writeFileSync(BASELINE, `${JSON.stringify(lowered, null, 2)}\n`);
  }
  const shrunk = Object.entries(baseline).filter(([f, n]) => (now[f] ?? 0) < n);
  assert.deepEqual(shrunk, [], `${relative(ROOT, BASELINE)} counts controls these files no longer draw by hand: lower it (FORM_INVENTORY_WRITE=1)`);
});

test("every exemption still matches a control (one that matches none comes off the list)", () => {
  scan();
  assert.deepEqual(EXEMPT.map((x) => x.why).filter((why) => !used.has(why)), []);
});
