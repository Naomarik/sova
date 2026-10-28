// Every pointer to the spec mode's instructions leads a reader to the writing procedure before any
// behavior change (§tools.spec/writing-on-demand): AGENTS.md (for agents with the mode off), the short
// part itself (`$core/../WRITING.md`), the hermetic agent dir that links it, the upgrade note for other
// projects, and the docs page. Reads files only.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const at = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(at(rel), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");
const WRITING = "pi-config/extensions/spec/WRITING.md";

test("the writing procedure exists where every pointer says, beside PROMOTE.md", () => {
  assert.ok(existsSync(at(WRITING)));
  assert.ok(existsSync(at("pi-config/extensions/spec/PROMOTE.md")), "$core/../ is the spec extension's own directory");
});

test("AGENTS.md sends an agent to the writing procedure before its first behavior-changing edit", () => {
  const agents = flat(read("AGENTS.md"));
  assert.match(agents, /read `pi-config\/extensions\/mode\/spec-mode\.md`/);
  assert.match(agents, /Before your first edit that changes behavior, read `pi-config\/extensions\/spec\/WRITING\.md`, the writing procedure/);
});

test("the short part names the procedure's path before any behavior change, and the procedure isn't in it", () => {
  const short = flat(read("pi-config/extensions/mode/spec-mode.md"));
  assert.match(short, /Before your first edit that changes behavior, read `\$core\/\.\.\/WRITING\.md`, the writing procedure/);
  assert.ok(!short.includes("sova-spec-draft.mjs"), "the draft commands are the procedure's");
});

test("the hermetic agent dir links the whole spec directory, so $core/../WRITING.md resolves there", () => {
  assert.match(read("scripts/hermetic-agent-dir.mjs"), /for \(const name of \["spec"\]\)/);
});

test("the upgrade note and the docs page name the writing procedure", () => {
  const changelog = flat(read("pi-config/extensions/spec/docs/CHANGELOG.md"));
  const upgrading = changelog.slice(changelog.indexOf("## UPGRADING another project"));
  assert.match(upgrading, /`spec\/WRITING\.md`/, "UPGRADING says the file ships");
  assert.match(upgrading, /must also name the writing procedure, before behavior-changing edits: `\$core\/\.\.\/WRITING\.md`/);
  assert.match(flat(read("site/src/content/docs/modes/spec.md")), /Before its first edit that changes what the product does, the agent reads the writing procedure\./);
});
