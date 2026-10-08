// The History tab's wide split in its stylesheet: every narrow rule that hides the timeline or the
// detail has, inside the wide container query, a rule with the SAME selector that shows it again,
// later in the file. Equal specificity and later source order is what makes the wide rule win; a
// shorter selector there once lost to the narrow one (0,4,0 over 0,3,0), and the timeline vanished
// beside the detail with no way back. Computed display at real widths is measured in Chromium by the
// browser pass (.cache/org-history-ui/measure.mjs); this pins the cascade between those runs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../org-history.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** `selector { …display: X… }` rules, with their offset, outside or inside the wide container block. */
function displayRules(text: string, base = 0): { selector: string; display: string; at: number }[] {
  const out: { selector: string; display: string; at: number }[] = [];
  const re = /([^{}@]+)\{([^{}]*)\}/g;
  for (let m; (m = re.exec(text)); ) {
    const d = /(?:^|;)\s*display\s*:\s*([a-z-]+)/.exec(m[2]!);
    if (d) for (const sel of m[1]!.split(",")) out.push({ selector: sel.trim().replace(/\s+/g, " "), display: d[1]!, at: base + m.index });
  }
  return out;
}

test("the wide split shows both panes with the narrow rules' own selectors, after them", () => {
  const open = /@container org-history \(min-width: 1000px\) \{/.exec(css);
  assert.ok(open, "the wide container query exists");
  // Its block: up to the matching close brace.
  let depth = 0;
  let end = open.index + open[0].length - 1;
  for (let i = end; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  const wideStart = open.index + open[0].length;
  const wide = displayRules(css.slice(wideStart, end), wideStart);
  const narrow = displayRules(css.slice(0, open.index)).filter((r) => r.display === "none" && /\.orghist-(main|inspector)$/.test(r.selector));
  assert.equal(narrow.length, 2, "the timeline (detail selected) and the detail (Causal View) hide when narrow");
  for (const n of narrow) {
    const show = wide.find((w) => w.selector === n.selector);
    assert.ok(show, `the wide block repeats ${n.selector}`);
    assert.notEqual(show.display, "none", n.selector);
    assert.ok(show.at > n.at, `${n.selector}: the wide rule comes later`);
  }
});
