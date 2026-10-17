// Run: bun test server/project-mode-menu.test.ts (or pnpm test)
// The mode menu's project rows and the turn-on check (server/project-mode-menu.ts), on hand-built listings.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectModeListing, ProjectModeSnapshot } from "../shared/project-modes";
import { approvalNeededText, checkProjectSwitch, parseApprovals, parseProjectModes, projectModesInfo } from "./project-mode-menu";
import { defaultPatchOf, parseModePatch, parseModeRequest, pinEntryFor } from "./mode-state";

const H = (c: string) => c.repeat(64);
const snap = (id: string, over: Partial<ProjectModeSnapshot> = {}): ProjectModeSnapshot => ({
  v: 1,
  id,
  dir: `/repo/.sova/minor-modes/${id}`,
  description: `${id} words`,
  workers: false,
  tools: [],
  text: `# Project minor mode: ${id}`,
  sha: H("1"),
  toolsHash: "",
  ...over,
});
const tool = { name: "status", description: "Shows it", params: { type: "object", properties: {} }, command: ["./status.sh", "--x"], timeoutS: 60 };
const listing = (modes: ProjectModeSnapshot[], problems: ProjectModeListing["problems"] = []): ProjectModeListing => ({ root: "/repo", name: "repo", modes, problems });
const never = () => false;

test("rows: every mode offered, off, with its command line and the hash an approval approves", () => {
  const l = listing([snap("plain"), snap("rel", { tools: [tool], toolsHash: H("a") })], [{ id: "Bad_Name", kind: "bad-id", path: "/repo/.sova/minor-modes/Bad_Name", error: "not a mode name" }]);
  const info = projectModesInfo(l, [], new Map(), never);
  assert.equal("projectModes" in info, false, "nothing on: absent, not empty");
  assert.deepEqual(info.project, { root: "/repo", name: "repo" });
  assert.deepEqual(info.projectMinors, [
    { id: "plain", description: "plain words", workers: false, tools: [], dir: "/repo/.sova/minor-modes/plain" },
    { id: "rel", description: "rel words", workers: false, tools: [{ name: "status", description: "Shows it", command: ["./status.sh", "--x"] }], dir: "/repo/.sova/minor-modes/rel", needsApproval: true, toolsHash: H("a") },
    { id: "Bad_Name", description: "", workers: false, tools: [], dir: "/repo/.sova/minor-modes/Bad_Name", problem: "/repo/.sova/minor-modes/Bad_Name: not a mode name" },
  ]);
  const approved = projectModesInfo(l, [], new Map(), (root, id, hash) => root === "/repo" && id === "rel" && hash === H("a"));
  assert.equal(approved.projectMinors?.find((m) => m.id === "rel")?.needsApproval, undefined, "approved: no ask");
});

test("rows: an on mode shows the copy it runs; changed when the files differ; removed when gone", () => {
  const kept = snap("a", { description: "old words", sha: H("1") });
  const gone = snap("gone", { sha: H("2") });
  const now = listing([snap("a", { description: "new words", sha: H("3") }), snap("same", { sha: H("4") })]);
  const info = projectModesInfo(now, [{ id: "a", sha: H("1") }, { id: "same", sha: H("4") }, { id: "gone", sha: H("2") }], new Map([[H("1"), kept], [H("2"), gone], [H("4"), snap("same", { sha: H("4") })]]), never);
  assert.deepEqual(info.projectModes, ["a", "same", "gone"]);
  const row = (id: string) => info.projectMinors!.find((m) => m.id === id)!;
  assert.equal(row("a").description, "old words", "what the chat runs, not the files");
  assert.equal(row("a").changed, true);
  assert.equal(row("same").changed, undefined);
  assert.equal(row("gone").removed, true);
  assert.equal(row("gone").description, "gone words");
});

test("rows: no rows and nothing on is nothing at all", () => {
  assert.deepEqual(projectModesInfo({ root: null, name: "", modes: [], problems: [] }, [], new Map(), never), {});
  assert.deepEqual(projectModesInfo({ root: "/repo", name: "repo", modes: [], problems: [] }, [], new Map(), never), {}, "a checkout with no modes: the frame it always sent");
});

test("turn-on: unknown and broken refuse; tools need approval unless approved now, or by the Overseer", () => {
  const l = listing([snap("plain"), snap("rel", { tools: [tool], toolsHash: H("a") })], [{ id: "broken", kind: "parse", path: "/repo/.sova/minor-modes/broken/MODE.md", error: "no description" }]);
  assert.match((checkProjectSwitch(l, [], ["nope"], [], false, never) as { error: string }).error, /No project mode "nope"/);
  assert.match((checkProjectSwitch(l, [], ["broken"], [], false, never) as { error: string }).error, /no description/);
  assert.deepEqual(checkProjectSwitch(l, [], ["plain"], [], false, never), { ok: true, ids: ["plain"], record: [] }, "no tools: no approval");
  const ask = checkProjectSwitch(l, [], ["plain", "rel"], [], false, never);
  assert.ok("needsApproval" in ask);
  assert.deepEqual(ask.needsApproval.map((m) => [m.id, m.toolsHash]), [["rel", H("a")]]);
  const stale = checkProjectSwitch(l, [], ["rel"], [{ id: "rel", hash: H("b") }], false, never);
  assert.ok("needsApproval" in stale, "a stale hash approves nothing");
  assert.equal(approvalNeededText(stale), "The tools of rel changed since you looked; check them again.");
  assert.equal(approvalNeededText(ask), "Approve the tools of rel to turn it on.");
  assert.deepEqual(checkProjectSwitch(l, [], ["rel"], [{ id: "rel", hash: H("a") }], false, never), { ok: true, ids: ["rel"], record: [{ id: "rel", hash: H("a") }] });
  assert.deepEqual(checkProjectSwitch(l, [], ["rel"], [], true, never), { ok: true, ids: ["rel"], record: [{ id: "rel", hash: H("a") }] }, "the Overseer's turn-on approves (q7)");
  assert.deepEqual(checkProjectSwitch(l, [], ["rel"], [], false, () => true), { ok: true, ids: ["rel"], record: [] }, "already approved");
  assert.deepEqual(checkProjectSwitch(l, ["gone"], [], [], false, never), { ok: true, ids: [], record: [] }, "off is always allowed, removed ones too");
  assert.deepEqual(checkProjectSwitch(l, ["gone"], ["gone"], [], false, never), { ok: true, ids: ["gone"], record: [] }, "staying on is never re-checked");
});

test("body: projectModes and approve are checked; the closed minorModes list stays closed", () => {
  assert.deepEqual(parseProjectModes(["a", "a", "b-2"]), ["a", "b-2"]);
  assert.ok("error" in (parseProjectModes(["Bad"]) as object));
  assert.ok("error" in (parseApprovals([{ id: "a", hash: "x" }]) as object));
  assert.deepEqual(parseModePatch({ projectModes: ["rel"], approve: [{ id: "rel", hash: H("a") }] }), { projectModes: ["rel"], approve: [{ id: "rel", hash: H("a") }] });
  assert.ok("error" in parseModePatch({ approve: [] }), "approve alone means nothing");
  assert.ok("error" in parseModePatch({ minorModes: ["rel"] }), "a project id is never a minor mode");
  assert.equal((parseModePatch({ projectModes: ["x"], approvedBy: "overseer" }) as { approvedBy?: string }).approvedBy, undefined, "a body never approves as the Overseer");
  assert.ok("error" in parseModeRequest({ saveDefault: true, projectModes: [] }));
});

test("save as default never stores project modes; a pin keeps the chat's on set and never adds one", () => {
  const state = { mode: "normal" as const, strict: false, minorModes: ["spec" as const] };
  assert.deepEqual(Object.keys(defaultPatchOf({ ...state, projectModes: [{ id: "a", sha: H("1") }] } as never)).sort(), ["minorModes", "mode", "strict"]);
  const branch = [{ type: "custom", customType: "mode", data: { mode: "normal", active: { version: 1, mode: "normal", strict: false, minorModes: [], projectModes: [{ id: "a", sha: H("1") }] } } }];
  const pin = pinEntryFor(branch, state);
  assert.deepEqual(pin?.data.active.projectModes, [{ id: "a", sha: H("1") }]);
  assert.equal(pinEntryFor([], state)?.data.active.projectModes, undefined);
});
