// The playbook card's rules that keep one thing from covering another (§chat.playbooks/run-card,
// run-strip), read from the stylesheet the page loads: while Jump to Latest would lie over a card
// in the conversation (lib/jump-cover marks the transcript), it isn't shown; and the gap under a run's strip is the page's own, so nothing
// of the conversation passing behind the strip shows under it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("../components/PlaybookCard.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the rule whose selector is exactly `selector`. */
function rule(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1]!.split(",").map((s) => s.trim()).includes(selector)) continue;
    for (const d of m[2]!.split(";")) {
      const i = d.indexOf(":");
      if (i > 0) out.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
    }
  }
  return out;
}

test("while Jump to Latest would lie over a playbook's card, it is neither seen nor pressed, even when it would show", () => {
  const r = rule(".transcript-wrap[data-pb-under-jump] > .jump-latest[data-shown]");
  assert.equal(r.get("visibility"), "hidden");
  assert.equal(r.get("pointer-events"), "none");
});

test("the gap under the strip is filled with the page's own colour, exactly as tall as the gap and as wide as the strip", () => {
  const gap = rule(".pb-layer").get("bottom");
  assert.ok(gap, "the layer stands a gap above the message box");
  const r = rule(".pb-layer:has(.pb-strip)::after");
  assert.equal(r.get("background"), "var(--color-bg)");
  assert.equal(r.get("height"), gap);
  assert.equal(r.get("top"), "100%");
  assert.equal(r.get("left"), "0");
  assert.equal(r.get("right"), "0");
  assert.equal(r.get("position"), "absolute");
});
