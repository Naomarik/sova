import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFINITION_KEYS } from "./project-contract";
import { LIMIT_KEYS, PROFILE_FIELDS } from "./profiles";
import { POWERS, POWER_INFO } from "./powers";
import { PO_PATCH_FIELDS, PO_CAP_LABEL } from "./project-overseer";
import { BUTTON_KEYS, OFFER_KEYS, OFFERS_FILE_KEYS } from "./session-offers";
import { MODE_KEYS } from "./project-modes";
import { PROJECT_EDIT_KEYS } from "./project-settings";
import { SETTINGS_REFERENCE, settingsIndex, type SettingId } from "./settings-reference";

// The ratchet (§app.project-overseer/settings): every key a settings parser reads has a reference entry,
// so the project overseer's knowledge can't fall behind the code. A new parsed key with no entry fails here.

const keysOf = (...ids: SettingId[]) => new Set(ids.flatMap((id) => Object.keys(SETTINGS_REFERENCE[id].keys)));
const missing = (want: readonly string[], have: Set<string>) => want.filter((k) => !have.has(k));

test("every field PATCH …/overseer reads has an entry", () => {
  const have = keysOf("overseer.watch", "overseer.powers", "overseer.brake", "overseer.models", "overseer.assistant-models", "overseer.abilities", "overseer.extra", "overseer.limits", "overseer.pace", "overseer.hold");
  assert.deepEqual(missing(PO_PATCH_FIELDS, have), []);
  assert.deepEqual(missing(Object.keys(PO_CAP_LABEL).map((k) => `caps.${k}`), have), []);
  assert.deepEqual(missing(POWERS.map((p) => `powers.overseer.${p}`), have), []);
  assert.deepEqual(missing(POWERS.filter((p) => POWER_INFO[p].assistant).map((p) => `powers.assistant.${p}`), have), []);
});

test("the project's own PATCH (name, root) has an entry", () => {
  // server/projects/routes.ts PATCH /api/projects/:pid reads exactly these.
  const route = readFileSync(join(import.meta.dirname, "..", "server", "projects", "routes.ts"), "utf8");
  const read = /editProject\([^,]+, \{ ([^}]*) \}/.exec(route)?.[1]?.split(",").map((x) => x.trim().split(":")[0]!) ?? [];
  assert.deepEqual(read.sort(), ["name", "root"]);
  assert.deepEqual(missing(read, keysOf("project.name")), []);
});

test("the project's other settings (stakeholder, owner's page, Frozen, archive) have entries, and the project edit takes each", () => {
  const src = (f: string) => readFileSync(join(import.meta.dirname, "..", f), "utf8");
  // PATCH /api/orgs/:id/projects/:pid/placement reads these; PATCH …/projects/:pid/spec reads frozen.
  const placement = /projects\/:pid\/placement",[\s\S]*?patchPlacement\(([^\n]*)/.exec(src("server/org-routes.ts"))?.[1] ?? "";
  const placementKeys = [...new Set([...placement.matchAll(/\bb\.(\w+) !== undefined/g)].map((m) => m[1]!))].sort();
  assert.deepEqual(placementKeys, ["ownerHidden", "stakeholder"]);
  const spec = /\$\{BASE\}\/spec`,\s*handle\(async[\s\S]*?\(await body\(c\)\)\.(\w+)/.exec(src("server/decisions-routes.ts"))?.[1];
  assert.equal(spec, "frozen");
  const project = keysOf("project.name", "project.stakeholder", "project.ownerHidden", "project.frozen", "project.archive");
  assert.deepEqual(missing([...placementKeys, spec!, "archived"], project), []);
  // The project edit of sova_settings propose names every one of them, and nothing without an entry.
  assert.deepEqual(missing([...placementKeys, spec!, "archived", "name", "root"], new Set(PROJECT_EDIT_KEYS)), []);
  assert.deepEqual(missing(PROJECT_EDIT_KEYS, project), []);
});

test("every profile field and limit has an entry", () => {
  assert.deepEqual(missing([...PROFILE_FIELDS, ...LIMIT_KEYS.map((k) => `limits.${k}`)], keysOf("profile")), []);
});

test("every playbook frontmatter key the parsers read has an entry (read from the parsers' own source)", () => {
  const src = ["server/playbooks.ts", "shared/schedules.ts"].map((f) => readFileSync(join(import.meta.dirname, "..", f), "utf8")).join("\n");
  const read = [...new Set([...src.matchAll(/\bfields\.([A-Za-z][\w]*)/g)].map((m) => m[1]!))].sort();
  assert.ok(read.includes("when") && read.includes("title"), read.join(","));
  assert.deepEqual(missing(read, keysOf("playbook", "schedule")), []);
});

test("every MODE.md key has an entry", () => {
  assert.deepEqual(missing(MODE_KEYS, keysOf("mode")), []);
});

test("every offers file, offer and button key has an entry", () => {
  const have = keysOf("offers");
  assert.deepEqual(missing([...OFFERS_FILE_KEYS, ...OFFER_KEYS.map((k) => `offers.<name>.${k}`), ...BUTTON_KEYS.map((k) => `buttons[].${k}`)], have), []);
});

test("every top-level and service key of the services contract has an entry", () => {
  assert.deepEqual(missing([...DEFINITION_KEYS.top, ...DEFINITION_KEYS.service.map((k) => `services.<name>.${k}`)], keysOf("services")), []);
});

test("the index names every setting once; a standalone project's leaves out what needs an organization", () => {
  const lines = settingsIndex().split("\n");
  assert.equal(lines.length, Object.keys(SETTINGS_REFERENCE).length);
  assert.doesNotMatch(settingsIndex(false), /gathering/i);
  for (const e of Object.values(SETTINGS_REFERENCE)) assert.ok(e.where === "sova" || e.file, `${e.id} names its file`);
});
