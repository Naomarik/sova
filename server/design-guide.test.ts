import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  DESIGN_COORDINATOR_PROMPT,
  DESIGN_DEFAULT_DIRECTION_SETS,
  DESIGN_DIRECTIONS,
  DESIGN_GUIDE_TOPICS,
  DESIGN_INSTRUCTIONS,
  DESIGN_PAGE_END,
  DESIGN_PAGE_START,
  designGuide,
  designSessionPrompt,
} from "../pi-config/extensions/mode/design-guide.ts";
import { MINOR_MODES, MINOR_SURFACES, MINOR_WORKER, buildMinorPrompt } from "../pi-config/extensions/mode/minor.ts";
import { DESIGN_PAGE_CLOSE, DESIGN_PAGE_OPEN } from "../shared/design.ts";

const OWNER_NOTE = /<!--/;
const UNFILLED = /\{\{\w+\}\}/;

describe("the design mode's declaration", () => {
  test("turns on only from Sova's menu, reaches no worker, and pays its block", () => {
    assert.ok(MINOR_MODES.includes("design"));
    assert.equal(MINOR_SURFACES.design, "web");
    assert.equal(MINOR_WORKER.design, false);
    assert.equal(buildMinorPrompt("design"), DESIGN_INSTRUCTIONS);
  });
});

describe("the guide", () => {
  test("every topic the prompt names exists, and no owner note reaches a model", () => {
    for (const topic of DESIGN_GUIDE_TOPICS) {
      assert.ok(DESIGN_INSTRUCTIONS.includes(`\`${topic}\``), topic);
      assert.doesNotMatch(designGuide(topic), OWNER_NOTE);
    }
    assert.doesNotMatch(DESIGN_INSTRUCTIONS, OWNER_NOTE);
  });

  test("no topic returns the index; an unknown one names the real ones", () => {
    for (const topic of DESIGN_GUIDE_TOPICS) assert.ok(designGuide().includes(topic), topic);
    assert.throws(() => designGuide("nope"), new RegExp(DESIGN_GUIDE_TOPICS[0]));
  });
});

test("every default set names a real direction, among 20 distinct ones", () => {
  const names = new Set(DESIGN_DIRECTIONS.map((d) => d.name));
  assert.equal(names.size, 20);
  for (const name of DESIGN_DEFAULT_DIRECTION_SETS.flat()) assert.ok(names.has(name), name);
});

describe("a design session's prompt", () => {
  const prompts = (["none", "screenshot", "description"] as const).flatMap((reference) =>
    (["tool", "reply"] as const).flatMap((delivery) =>
      DESIGN_DIRECTIONS.map((d) => ({ delivery, direction: d, text: designSessionPrompt({ label: "AB", direction: d.name, reference, delivery }) })),
    ),
  );

  test("every combination comes out whole, with its direction's definition and its label", () => {
    for (const p of prompts) {
      assert.doesNotMatch(p.text, UNFILLED);
      assert.doesNotMatch(p.text, OWNER_NOTE);
      assert.ok(p.text.includes(p.direction.definition));
      assert.ok(p.text.includes("AB"));
    }
  });

  test("only the reply route writes the page between the markers Sova's decoder reads", () => {
    assert.equal(DESIGN_PAGE_START, DESIGN_PAGE_OPEN);
    assert.equal(DESIGN_PAGE_END, DESIGN_PAGE_CLOSE);
    for (const p of prompts) assert.equal(p.text.includes(DESIGN_PAGE_START), p.delivery === "reply");
  });

  test("an unknown direction is refused, never sent blank", () => {
    assert.throws(() => designSessionPrompt({ label: "A", direction: "Nope", reference: "none", delivery: "tool" }));
  });
});

test("the coordinator's prompt has no owner note and no unfilled slot", () => {
  assert.doesNotMatch(DESIGN_COORDINATOR_PROMPT, OWNER_NOTE);
  assert.doesNotMatch(DESIGN_COORDINATOR_PROMPT, UNFILLED);
});
