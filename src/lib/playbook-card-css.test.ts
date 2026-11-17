// The open playbook card never scrolls its own box: only its body does (§chat.playbooks/run-card).
// A box with `overflow: hidden` still scrolls programmatically, and the form kit's visually hidden
// labels (absolute, no insets) belong to the nearest positioned ancestor: with the card itself as
// that ancestor they sat far below its box, so focus landing while the card rose (Start pressed in
// its first 0.3 s) scrolled the head out of view. Read from the stylesheet the page loads.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("../components/PlaybookCard.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the rule whose selector is exactly `selector`, last value of each property winning. */
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

test("the card's own box can't be scrolled: its overflow ends as clip", () => {
  assert.equal(rule(".pb-card").get("overflow"), "clip");
});

test("the card's body, its one scroller, holds the hidden labels: it is positioned", () => {
  const body = rule(".pb-body");
  assert.equal(body.get("overflow-y"), "auto", "the body is the card's scroller");
  assert.match(body.get("position") ?? "static", /^(relative|absolute|sticky|fixed)$/);
});
