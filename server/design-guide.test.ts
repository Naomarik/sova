import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DESIGN_COORDINATOR_PROMPT,
  DESIGN_DEFAULT_DIRECTION_SETS,
  DESIGN_DIRECTIONS,
  DESIGN_PAGE_END,
  DESIGN_PAGE_START,
  designSessionPrompt,
} from "../pi-config/extensions/mode/design-guide.ts";
import { MINOR_MODES, VIS_GUIDE_NAMES, VIS_INSTRUCTIONS, VIS_KINDS, VIS_KIND_FILES, VIS_TOOL_ENTRIES, VIS_TOOL_PARTS, stripVisComments, visGuide } from "../pi-config/extensions/mode/minor.ts";
import { DESIGN_PAGE_CLOSE, DESIGN_PAGE_OPEN, DESIGN_TOOL } from "../shared/design.ts";
import { DESIGN_TOOLS, mainDesignTools } from "./design/tools.ts";

const OWNER_NOTE = /<!--/;
const UNFILLED = /\{\{\w+\}\}/;
const PARTS = ["lookbook-setup", "lookbook-directions", "lookbook-passing-on"];
const visFile = (name: string) => stripVisComments(readFileSync(new URL(`../pi-config/extensions/mode/vis/${name}.md`, import.meta.url), "utf8"));

describe("the Lookbook rides vis", () => {
  test("it is no minor mode, and its tool is the main chat's one Lookbook tool", () => {
    assert.ok(!(MINOR_MODES as readonly string[]).includes("design") && !(MINOR_MODES as readonly string[]).includes("lookbook"));
    assert.equal(DESIGN_TOOL, "lookbook");
    assert.deepEqual([...DESIGN_TOOLS], ["lookbook"]);
    assert.deepEqual(mainDesignTools(() => ({ sessionId: "s", path: "p" }), () => "").map((t) => t.name), ["lookbook"], "no design_guide: vis_guide serves the guide");
  });

  test("a tool-backed vis entry: vis_guide returns its core alone, and never as a drawing kind", () => {
    assert.ok(VIS_TOOL_ENTRIES.includes("lookbook"));
    assert.ok(VIS_KINDS.includes("lookbook"), "the catalogue lists it");
    for (const key of Object.keys(VIS_KIND_FILES)) assert.ok(!key.startsWith("lookbook") && !VIS_KIND_FILES[key]!.startsWith("lookbook"), key);
    const core = visGuide("lookbook");
    assert.equal(core, visFile("lookbook"), "the core alone, owner notes stripped");
    assert.doesNotMatch(core, /^# vis: rules for every kind/m, "no shared fence rules");
    for (const part of PARTS) {
      assert.ok(VIS_TOOL_PARTS.includes(part) && VIS_GUIDE_NAMES.includes(part) && !VIS_KINDS.includes(part), part);
      assert.equal(visGuide(part), visFile(part), part);
      assert.match(visGuide(part), new RegExp(`^# ${part}: `), `${part} opens with its own heading`);
      assert.doesNotMatch(visGuide(part), OWNER_NOTE);
      assert.ok(core.includes(`\`${part}\``), `the core names ${part}`);
    }
    assert.throws(() => visGuide("lookbook-other"), /No vis kind/);
  });

  test("the catalogue's one line and the core say when to open one, and what stays a quick drawing", () => {
    const line = VIS_INSTRUCTIONS.split("\n").filter((l) => l.startsWith("- lookbook: "));
    assert.equal(line.length, 1);
    assert.match(line[0]!, /asks for a Lookbook by name/);
    assert.match(line[0]!, /quick html or wireframe drawing instead/);
    assert.match(line[0]!, /never a `vis lookbook` fence/);
    const core = visGuide("lookbook");
    const not = core.slice(core.indexOf("Not a Lookbook"));
    for (const ask of ["mock up a login page", "draw a wireframe", "show me a design"]) assert.ok(not.includes(ask), ask);
    assert.match(core, /The ask lasts until the card is up/);
    assert.match(core, /Only the user's own words count/);
    assert.doesNotMatch(core, /design_guide/);
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
