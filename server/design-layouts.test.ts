import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DESIGN_DEFAULT_DIRECTION_SETS, DESIGN_DIRECTIONS, DESIGN_LAYOUTS, designSessionPrompt } from "../pi-config/extensions/mode/design-guide.ts";

const UNFILLED = /\{\{\w+\}\}/;
const KEEP_PLACES = /in similar logical positions|Follow the layout described/;

test("the 20 styles sit in 5 families, every name kept, and the 12 layouts are their own list", () => {
  const families = new Map<string, string[]>();
  for (const d of DESIGN_DIRECTIONS) families.set(d.family!, [...(families.get(d.family!) ?? []), d.name]);
  assert.deepEqual(Object.fromEntries(families), {
    Quiet: ["Minimalist", "Clean & Modern", "Balanced", "Light & Airy", "Subtle & Refined", "Elegant"],
    Bold: ["Bold & Vibrant", "High Contrast", "Dynamic & Energetic", "Dark & Moody"],
    Expressive: ["Playful", "Warm & Inviting", "Creative", "Artistic"],
    Business: ["Professional", "Corporate", "Technical"],
    Atmospheric: ["Rich & Detailed", "Heritage", "Immersive"],
  });
  assert.deepEqual(
    DESIGN_LAYOUTS.map((d) => d.name),
    ["Compact", "Spacious", "Single Column", "Split Screen", "Sidebar Navigation", "Card Grid", "Bento", "Dashboard", "Magazine", "Long-Scroll Story", "List and Detail", "Tabbed Panels"],
  );
  for (const l of DESIGN_LAYOUTS) assert.equal(l.family, undefined, `${l.name} is no style`);
  for (const name of DESIGN_DEFAULT_DIRECTION_SETS.flat()) assert.ok(DESIGN_DIRECTIONS.some((d) => d.name === name), name);
});

describe("a design session's layout", () => {
  const refs = ["none", "screenshot", "description"] as const;

  test("with a layout, its definition and the rule that the layout decides arrangement are in the standing instructions", () => {
    for (const reference of refs)
      for (const l of DESIGN_LAYOUTS) {
        const text = designSessionPrompt({ label: "A", direction: "Professional", layout: l.name, reference, delivery: "tool" });
        assert.doesNotMatch(text, UNFILLED);
        assert.ok(text.includes(`Arrange the page as "${l.name}".`), l.name);
        assert.ok(text.includes(l.definition), l.name);
        assert.match(text, /Where the style's description talks about arrangement, the layout wins\./);
        // After the style, so the precedence reads after what it overrides.
        assert.ok(text.indexOf("LAYOUT:") > text.indexOf("DESIGN DIRECTION:"));
      }
  });

  test("with no layout there is no layout block at all", () => {
    for (const reference of refs) {
      const text = designSessionPrompt({ label: "A", direction: "Professional", reference, delivery: "tool" });
      assert.doesNotMatch(text, UNFILLED);
      assert.doesNotMatch(text, /LAYOUT:|the layout wins/);
    }
  });

  test("a rebuild keeps its structure in place with no layout, and is rearranged by its layout with one", () => {
    for (const reference of ["screenshot", "description"] as const) {
      assert.match(designSessionPrompt({ label: "A", direction: "Minimalist", reference, delivery: "tool" }), KEEP_PLACES, reference);
      const laid = designSessionPrompt({ label: "A", direction: "Minimalist", layout: "Dashboard", reference, delivery: "tool" });
      assert.doesNotMatch(laid, KEEP_PLACES, reference);
      assert.match(laid, /Keep its purpose and content; arrange it as your LAYOUT says/, reference);
    }
  });

  test("an unknown layout is refused, never sent blank", () => {
    assert.throws(() => designSessionPrompt({ label: "A", direction: "Minimalist", layout: "Hexagon", reference: "none", delivery: "tool" }), /Unknown design layout/);
  });
});
