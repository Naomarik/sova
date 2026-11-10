// Run: bun test server/project-mode-menu.test.ts (or pnpm test)
// The mode menu's project rows and the turn-on check (server/project-mode-menu.ts), on hand-built listings.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectModeListing, ProjectModeSnapshot } from "../shared/project-modes";
import { approvalNeededText, checkProjectSwitch, listingFor, parseApprovals, parseProjectModes, projectModesInfo } from "./project-mode-menu";
import { mergeModeListings } from "./modes/personal";
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
  assert.deepEqual(checkProjectSwitch(l, [], ["rel"], [{ id: "rel", hash: H("a") }], false, never), { ok: true, ids: ["rel"], record: [{ id: "rel", hash: H("a"), root: "/repo" }] });
  assert.deepEqual(checkProjectSwitch(l, [], ["rel"], [], true, never), { ok: true, ids: ["rel"], record: [{ id: "rel", hash: H("a"), root: "/repo" }] }, "the Overseer's turn-on approves (q7)");
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

// ── Personal modes (§chat.mode-menu/personal-modes) ──────────────────────────
const HOME = "/home/u/.pi/agent/sova/minor-modes";
const mine = (id: string, over: Partial<ProjectModeSnapshot> = {}) => snap(id, { dir: `${HOME}/${id}`, ...over });
const merged = (project: ProjectModeListing, personal: ProjectModeSnapshot[]) =>
  mergeModeListings(project, { root: HOME, name: "", modes: personal, problems: [] });

test("personal rows: marked personal, yours replaces the project's id (one row, `replaces`), the project's own rows unmarked", () => {
  const l = merged(listing([snap("lint"), snap("rel", { description: "theirs" })]), [mine("rel", { description: "mine" }), mine("tidy")]);
  const info = projectModesInfo(l, [], new Map(), never);
  assert.deepEqual(
    info.projectMinors!.map((m) => [m.id, m.description, m.personal ?? false, m.replaces ?? false]),
    [
      ["lint", "lint words", false, false],
      ["rel", "mine", true, true],
      ["tidy", "tidy words", true, false],
    ],
  );
  assert.deepEqual(info.project, { root: "/repo", name: "repo" }, "the group label is still the project's");
});

test("personal approval: asked and recorded for your folder, not the chat's checkout, so one approval holds in every project", () => {
  const asked: string[] = [];
  const approvedIn = (root: string) => (r: string) => (asked.push(r), r === root);
  const l = merged(listing([snap("lint", { tools: [tool], toolsHash: H("c") })]), [mine("tidy", { tools: [tool], toolsHash: H("d") })]);
  // Approved for the personal folder: no approval asked, in any project.
  assert.deepEqual(checkProjectSwitch(l, [], ["tidy"], [], false, approvedIn(HOME)), { ok: true, ids: ["tidy"], record: [] });
  const other = merged({ root: "/elsewhere", name: "elsewhere", modes: [], problems: [] }, [mine("tidy", { tools: [tool], toolsHash: H("d") })]);
  assert.deepEqual(checkProjectSwitch(other, [], ["tidy"], [], false, approvedIn(HOME)), { ok: true, ids: ["tidy"], record: [] });
  // Approved now: recorded for the folder; a project mode's for the checkout.
  assert.deepEqual(checkProjectSwitch(l, [], ["tidy", "lint"], [{ id: "tidy", hash: H("d") }, { id: "lint", hash: H("c") }], false, never), {
    ok: true,
    ids: ["tidy", "lint"],
    record: [
      { id: "tidy", hash: H("d"), root: HOME },
      { id: "lint", hash: H("c"), root: "/repo" },
    ],
  });
  // The menu asks the store with the same key.
  asked.length = 0;
  const rows = projectModesInfo(l, [], new Map(), approvedIn(HOME)).projectMinors!;
  assert.equal(rows.find((m) => m.id === "tidy")!.needsApproval, undefined);
  assert.equal(rows.find((m) => m.id === "lint")!.needsApproval, true);
  assert.deepEqual(asked.sort(), ["/repo", HOME].sort());
});

test("personal mode on but not offered now (removed, or the listing without yours): still marked personal by its copy's folder", () => {
  const before = process.env.SOVA_CHAT_STATE_ROOT;
  process.env.SOVA_CHAT_STATE_ROOT = "/home/u/.pi/agent/sova";
  try {
    const copy = mine("tidy", { sha: H("9") });
    const info = projectModesInfo(listing([]), [{ id: "tidy", sha: H("9") }], new Map([[H("9"), copy]]), never);
    assert.deepEqual(info.projectMinors!.map((m) => [m.id, m.removed, m.personal]), [["tidy", true, true]]);
    const theirs = projectModesInfo(listing([]), [{ id: "rel", sha: H("8") }], new Map([[H("8"), snap("rel", { sha: H("8") })]]), never);
    assert.equal(theirs.projectMinors![0]!.personal, undefined, "a project copy is never personal");
  } finally {
    if (before === undefined) delete process.env.SOVA_CHAT_STATE_ROOT;
    else process.env.SOVA_CHAT_STATE_ROOT = before;
  }
});

test("listingFor: yours only when asked (Sova runs the chat's modes), and never without a checkout", () => {
  assert.deepEqual(listingFor(undefined, false, true), { root: null, name: "", modes: [], problems: [] });
  assert.deepEqual(listingFor("/x", true, true), { root: null, name: "", modes: [], problems: [] }, "remote: none");
  const rel = listingFor("relative/dir", false, true);
  assert.equal(rel.root, null);
  assert.equal("personalIds" in rel, false, "no checkout: no personal merge");
});

test("switch off (Sova doesn't run the chat's modes): yours aren't offered, but one already on shows on and turns off", async () => {
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { discoverPersonalModes } = await import("./modes/personal");
  const { projectRowState } = await import("../src/lib/mode-menu");
  const base = mkdtempSync(join(tmpdir(), "personal-off-"));
  const before = process.env.SOVA_CHAT_STATE_ROOT;
  process.env.SOVA_CHAT_STATE_ROOT = join(base, "state");
  try {
    const repo = join(base, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, ".sova", "minor-modes", "lint"), { recursive: true });
    writeFileSync(join(repo, ".sova", "minor-modes", "lint", "MODE.md"), "---\ndescription: Lint\n---\nLint it.\n");
    const tidyDir = join(base, "state", "minor-modes", "tidy");
    mkdirSync(tidyDir, { recursive: true });
    writeFileSync(join(tidyDir, "MODE.md"), "---\ndescription: Tidy\n---\nTidy up.\n");
    const copy = discoverPersonalModes().modes[0]!;

    // On: offered, in "Your modes".
    const onListing = listingFor(repo, false, true);
    assert.deepEqual(projectModesInfo(onListing, [], new Map(), never).projectMinors!.map((m) => [m.id, m.personal ?? false]), [["lint", false], ["tidy", true]]);

    // Off: the project's modes only; turning one of yours on is refused.
    const offListing = listingFor(repo, false, false);
    assert.deepEqual(offListing.modes.map((m) => m.id), ["lint"]);
    assert.deepEqual(projectModesInfo(offListing, [], new Map(), never).projectMinors!.map((m) => m.id), ["lint"], "not offered");
    assert.match((checkProjectSwitch(offListing, [], ["tidy"], [], false, never) as { error: string }).error, /No project mode "tidy"/);

    // Off, but already on in this chat from its copy: listed (yours), on, not removed, and it turns off.
    const on = [{ id: "tidy", sha: copy.sha }];
    const info = projectModesInfo(offListing, on, new Map([[copy.sha, copy]]), never);
    assert.deepEqual(info.projectModes, ["tidy"]);
    const row = info.projectMinors!.find((m) => m.id === "tidy")!;
    assert.equal(row.personal, true);
    assert.equal(row.removed, undefined, "its folder is still there: it stays on, not 'removed'");
    assert.equal(row.description, "Tidy");
    const state = projectRowState(row, true);
    assert.equal(state.canToggle, true);
    assert.equal(state.note, null);
    assert.deepEqual(checkProjectSwitch(offListing, ["tidy"], [], [], false, never), { ok: true, ids: [], record: [] }, "turning it off is always allowed");
    assert.deepEqual(checkProjectSwitch(offListing, ["tidy"], ["tidy", "lint"], [], false, never), { ok: true, ids: ["tidy", "lint"], record: [] }, "staying on is never re-checked");

    // Its folder deleted: removed, as a project mode's would be.
    rmSync(tidyDir, { recursive: true, force: true });
    assert.equal(projectModesInfo(offListing, on, new Map([[copy.sha, copy]]), never).projectMinors!.find((m) => m.id === "tidy")!.removed, true);
  } finally {
    if (before === undefined) delete process.env.SOVA_CHAT_STATE_ROOT;
    else process.env.SOVA_CHAT_STATE_ROOT = before;
    rmSync(base, { recursive: true, force: true });
  }
});
