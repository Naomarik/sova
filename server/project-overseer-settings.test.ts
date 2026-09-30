import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { CONFIRM_KINDS, DEFAULT_CONFIRM_KINDS, DEFAULT_HOLD_MIN, HOLD_MIN_MAX, holdProblem } from "../shared/project-overseer";
import { OrgError } from "./orgs";
import { parsePoSettings, patchPoSettings, readPoSettings, type ProjectOverseerPaths } from "./project-overseer-store";

// The hold's length (§app.project-overseer/holds): plain data in overseer.json, read tolerantly and
// patched strictly, like every other setting of the project overseer.

const root = mkdtempSync(join(tmpdir(), "po-settings-"));
after(() => rmSync(root, { recursive: true, force: true }));

const pathsIn = (dir: string): ProjectOverseerPaths => ({
  orgId: "org_x",
  projectId: "prj_x",
  dir,
  settings: join(dir, "overseer.json"),
  notes: join(dir, "notes.md"),
  actions: join(dir, "actions.jsonl"),
  ideas: join(dir, "ideas"),
  todos: join(dir, "todos.json"),
  turn: join(dir, "turn.json"),
});

const SENTENCE = `The hold must be a whole number of minutes from 0 to ${HOLD_MIN_MAX} (0: no hold).`;

describe("holdMin: how long a held act waits (§app.project-overseer/holds)", () => {
  test("the default is 10 minutes, for a missing file and a file without the key", () => {
    assert.equal(DEFAULT_HOLD_MIN, 10);
    assert.equal(parsePoSettings(undefined).holdMin, 10);
    assert.equal(parsePoSettings({ autonomy: "L2" }).holdMin, 10);
  });

  test("the file: 0 and every whole number up to the maximum are kept", () => {
    for (const v of [0, 1, 10, 59, HOLD_MIN_MAX]) assert.equal(parsePoSettings({ holdMin: v }).holdMin, v);
  });

  test("the file: over the maximum reads as the maximum; any other bad value as the default", () => {
    assert.equal(parsePoSettings({ holdMin: HOLD_MIN_MAX + 1 }).holdMin, HOLD_MIN_MAX);
    assert.equal(parsePoSettings({ holdMin: 100_000 }).holdMin, HOLD_MIN_MAX);
    for (const v of [-1, 2.5, "10", null, true, {}, Number.NaN, HOLD_MIN_MAX + 0.5]) assert.equal(parsePoSettings({ holdMin: v }).holdMin, DEFAULT_HOLD_MIN, String(v));
  });

  test("holdProblem accepts exactly the whole numbers 0..max", () => {
    assert.equal(holdProblem(0), null);
    assert.equal(holdProblem(HOLD_MIN_MAX), null);
    for (const v of [-1, HOLD_MIN_MAX + 1, 1.5, "5", null, undefined]) assert.equal(holdProblem(v), SENTENCE, String(v));
  });

  test("a PATCH saves a valid value, 0 included, and leaves the rest of the file as it was", () => {
    const p = pathsIn(mkdtempSync(join(root, "ok-")));
    writeFileSync(p.settings, JSON.stringify({ autonomy: "L3", watchGapMin: 30 }));
    assert.equal(patchPoSettings(p, { holdMin: 0 }).holdMin, 0);
    const saved = JSON.parse(readFileSync(p.settings, "utf8"));
    assert.deepEqual([saved.holdMin, saved.autonomy, saved.watchGapMin], [0, "L3", 30]);
    assert.equal(patchPoSettings(p, { holdMin: 45 }).holdMin, 45);
    assert.equal(readPoSettings(p).holdMin, 45);
  });

  test("a PATCH with a bad value is refused whole (400, the sentence) and writes nothing", () => {
    const p = pathsIn(mkdtempSync(join(root, "bad-")));
    writeFileSync(p.settings, JSON.stringify({ holdMin: 5 }));
    const before = readFileSync(p.settings, "utf8");
    for (const v of [-1, HOLD_MIN_MAX + 1, 2.5, "10", null]) {
      assert.throws(
        () => patchPoSettings(p, { holdMin: v, watch: false }),
        (err: unknown) => err instanceof OrgError && err.status === 400 && err.message === SENTENCE,
        String(v),
      );
      assert.equal(readFileSync(p.settings, "utf8"), before, "nothing written, the valid key of the same PATCH neither");
    }
  });
});

describe("confirmKinds: the act kinds that wait for the overseer's confirmation (r8(4))", () => {
  test("every people- or code-facing kind is on by default, in display order", () => {
    assert.deepEqual(CONFIRM_KINDS, ["gather", "offer", "close", "promote", "build", "prompt", "owner-update", "roster-approve", "roster-decline"]);
    assert.deepEqual(DEFAULT_CONFIRM_KINDS, CONFIRM_KINDS);
    assert.deepEqual(parsePoSettings(undefined).confirmKinds, [...CONFIRM_KINDS]);
    assert.deepEqual(parsePoSettings({ autonomy: "L2" }).confirmKinds, [...CONFIRM_KINDS]);
  });

  test("the file: a list is kept in display order, an unknown kind dropped, anything else the default", () => {
    assert.deepEqual(parsePoSettings({ confirmKinds: [] }).confirmKinds, []);
    assert.deepEqual(parsePoSettings({ confirmKinds: ["promote", "offer", "someday"] }).confirmKinds, ["offer", "promote"]);
    assert.deepEqual(parsePoSettings({ confirmKinds: ["message", "gather"] }).confirmKinds, ["gather"], "r10: message is no kind (an old file's is dropped)");
    assert.deepEqual(parsePoSettings({ confirmKinds: "all" }).confirmKinds, [...CONFIRM_KINDS]);
  });

  test("a patch: known kinds only, each once; stored in display order", () => {
    const dir = join(root, "confirm");
    const p = pathsIn(dir);
    patchPoSettings(p, { confirmKinds: ["build", "gather"] });
    assert.deepEqual(readPoSettings(p).confirmKinds, ["gather", "build"]);
    assert.deepEqual(JSON.parse(readFileSync(p.settings, "utf8")).confirmKinds, ["gather", "build"]);
    for (const bad of [["gather", "gather"], ["nope"], "gather", [1]])
      assert.throws(() => patchPoSettings(p, { confirmKinds: bad as never }), (e: unknown) => e instanceof OrgError && e.status === 400 && /^confirmKinds must list act kinds from: gather, offer, close, promote, build, prompt, owner-update, roster-approve, roster-decline\.$/.test(e.message));
    assert.deepEqual(readPoSettings(p).confirmKinds, ["gather", "build"], "a refused patch writes nothing");
  });
});
