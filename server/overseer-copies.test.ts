// Copies and leftover processes on cards (§app.overseer/copies): the rows a card resolves, what the click that
// opened a turn approved per row and per verb (only a chosen label naming the act), and the card's refusals.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-ovcopies-agent-"));

const C = await import("./overseer-copies");
const { applyCardCall, cardLines, choiceNames } = await import("../shared/overseer-card");
const { historyOf, joinedText } = await import("./harness/pi/reader");
const confirm = await import("./overseer-confirm");
type Registry = import("./project-services/store").Registry;
type InstanceRecord = import("./project-services/store").InstanceRecord;

after(() => rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true }));

const rec = (id: string, over: Partial<InstanceRecord> = {}): InstanceRecord => ({
  id,
  project: "/p/demo",
  checkout: `/p/wt/${id}`,
  branch: `sova/${id}`,
  slot: 1,
  generation: 1,
  createdBy: "session:s-1",
  createdAt: "",
  cutWorktree: true,
  desired: { web: "running" },
  prints: {},
  data: {},
  ports: {},
  ...over,
});
const REG: Registry = { version: 1, instances: [rec("demo-a"), rec("demo-b", { slot: 2, createdBy: "operator", desired: { web: "stopped" } }), rec("demo-main", { slot: 0, checkout: "/p/demo" }), rec("other-x", { project: "/p/other" })], shared: [] };
const rowHost = (over: Partial<import("./overseer-copies").CopyRowHost> = {}): import("./overseer-copies").CopyRowHost => ({
  registry: () => REG,
  session: async (id) => (id === "s-1" ? ({ id, title: "Fix the login page", busy: true } as never) : null),
  projectName: () => "Demo",
  status: async (f) => (f.endsWith("demo-a") ? " M src/app.ts\n" : ""),
  exists: (p) => !p.endsWith("gone"),
  links: (id) => (id === "demo-a" ? 2 : 0),
  ...over,
});

test("a copy's row: by name, who started it, its edits, links and whether its session works; never slot 0 or another project's", async () => {
  const a = await C.copyItem("demo-a", rowHost());
  assert.deepEqual(a, {
    kind: "copy",
    id: "demo-a",
    project: "/p/demo",
    projectName: "Demo",
    slot: 1,
    branch: "sova/demo-a",
    checkout: "/p/wt/demo-a",
    state: "running",
    startedBy: { kind: "session", id: "s-1", title: "Fix the login page" },
    edits: "uncommitted",
    links: 2,
    working: true,
  });
  const b = (await C.copyItem("demo-b", rowHost())) as { startedBy: unknown; state: string; edits: string };
  assert.deepEqual([b.startedBy, b.state, b.edits], [{ kind: "operator", label: "the operator" }, "stopped", "clean"]);
  const gone = (await C.copyItem("demo-a", rowHost({ exists: () => false }))) as { state: string; edits: string };
  assert.deepEqual([gone.state, gone.edits], ["broken", "folder-gone"]);
  assert.equal(await C.copyItem("nope", rowHost()), null);
  assert.deepEqual(await C.copyItem("demo-main", rowHost()), { refused: `demo-main: ${C.MAIN_COPY_REFUSAL}` });
  assert.equal(C.MAIN_COPY_REFUSAL, "A project's main copy is never on a card.");
  assert.match(((await C.copyItem("other-x", rowHost(), "/p/demo")) as { refused: string }).refused, /another project/);
});

test("a card with copy rows: resolved after people and before sessions, click-only for either overseer; unknown and main copies refuse it", async () => {
  const lookup = {
    session: async (ref: string) => (ref === "s-1" ? ({ id: "s-1", title: "Fix", cwd: "/p/demo", lastActiveAt: "2026-10-01T00:00:00.000Z" } as never) : null),
    isSelf: () => false,
    idea: () => null,
    todo: () => null,
    copy: (ref: string) => C.copyItem(ref, rowHost()),
    leftover: async (project: string, port: number) => (port === 5174 ? ({ kind: "leftover", id: "5174:42:9", project, projectName: "Demo", slot: 1, port, pid: 42, start: "9", command: "vite", folder: "/gone (deleted)", reason: "folder-gone" } as const) : { refused: `port ${port} of ${project} is held by pid 7, which is in use: its worktree has uncommitted edits. A card lists only a process safe to stop.` }),
  };
  const refusal = (m: string) => new Error(m);
  const items = await confirm.resolveConfirmItems({ sessions: ["s-1"], copies: [{ instance: "demo-a", note: "Merged." }, "demo-b"], leftovers: [{ project: "/p/demo", port: 5174 }] }, lookup, refusal);
  assert.deepEqual(items.map((i) => i.kind), ["session", "copy", "copy", "leftover"]);
  assert.equal(await confirm.clickOnlyCard(items, lookup), true, "a project overseer's lookup (no people) too");
  assert.equal(await confirm.clickOnlyCard(items.filter((i) => i.kind === "session"), lookup), false);
  await assert.rejects(() => confirm.resolveConfirmItems({ copies: ["nope", "demo-main"] }, lookup, refusal), (e: Error) => /copies: nope/.test(e.message) && e.message.includes(C.MAIN_COPY_REFUSAL));
  await assert.rejects(() => confirm.resolveConfirmItems({ leftovers: [{ project: "/p/demo", port: 3000 }] }, lookup, refusal), /in use: its worktree has uncommitted edits/);
  // Without the copy lookups (a test host, an older caller), copies is a stray key.
  const plain = { session: lookup.session, isSelf: lookup.isSelf, idea: lookup.idea, todo: lookup.todo };
  await assert.rejects(() => confirm.resolveConfirmItems({ copies: ["demo-a"] }, plain, refusal), /items takes only sessions, ideas and todos/);
  const card = applyCardCall([], { ops: [{ op: "create", title: "Clean up?", choices: ["Tear Down", "Keep"] }] }, { now: "2026-10-26T10:00:00.000Z", prepared: { items: items.map((it) => ({ ...it, default: "a" })), hrefs: [], clickOnly: true } }).details.card!;
  assert.deepEqual(card.items.map((i) => [i.n, i.kind]), [[1, "copy"], [2, "copy"], [3, "leftover"], [4, "session"]], "copies and leftovers sit before sessions");
  const lines = cardLines(card, "").join("\n");
  assert.match(lines, /copy demo-a of Demo \(\/p\/demo\), slot 1, branch sova\/demo-a, running, started by \[Fix the login page\]\(sova:\/\/s\/s-1\) \(s-1\), uncommitted edits \(a teardown keeps them in its folder\), 2 active share links, its session is working now/);
  assert.match(lines, /leftover process on port 5174 \(slot 1\) of Demo .*pid 42, "vite", in \/gone \(deleted\), its folder was deleted/);
  assert.match(lines, /click-only: .*approves only the act its chosen label names/);
});

test("only a chosen label naming the act approves it: per row, per verb; Keep, Not Now and typed text approve nothing", () => {
  const a = { kind: "copy", id: "demo-a", project: "/p/demo", projectName: "Demo", slot: 1, branch: "sova/a", checkout: "/p/wt/a", state: "running", startedBy: { kind: "operator", label: "the operator" }, edits: "clean", links: 0 } as const;
  const b = { ...a, id: "demo-b", slot: 2 };
  const left = { kind: "leftover", id: "5174:42:9", project: "/p/demo", projectName: "Demo", slot: 1, port: 5174, pid: 42, start: "9", command: "vite", folder: "/x (deleted)", reason: "folder-gone" } as const;
  const created = applyCardCall(
    [],
    { ops: [{ op: "create", title: "Clean up?", options: [{ label: "Tear Down All" }, { label: "Not Now" }], choices: ["Tear Down", "Keep"] }] },
    { now: "2026-10-26T10:00:00.000Z", prepared: { items: [a, b, { ...left, choices: ["Stop", "Keep"] }], hrefs: [], clickOnly: true } },
  ).details;
  const result = (details: unknown, id = "k1") => ({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: "sova_card", details } });
  const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
  const branch = (...more: unknown[]) => historyOf([user("clean up the copies"), result(created), ...more] as never);
  const text = (h: Parameters<typeof joinedText>[0]) => joinedText(h, { images: false });
  const clicks = (card: string | null, ...more: unknown[]) => C.confirmedClicks(card, branch(...more), text);
  // The review's case: "1b Keep, 2a Tear Down" approves B's teardown, never A's.
  const perRow = clicks("c_1", user("c_1: 1b Keep, 2a Tear Down, 3a Stop"));
  assert.ok(perRow);
  assert.equal(C.clickApproves(perRow, "teardown", rec("demo-a")), false, "Keep approves nothing");
  assert.equal(C.clickApproves(perRow, "teardown", rec("demo-b", { slot: 2 })), true);
  assert.equal(C.clickApproves(perRow, "reset", rec("demo-b", { slot: 2 })), false, "a teardown choice approves no reset");
  assert.equal(C.clickApproves(perRow, "down", rec("demo-b", { slot: 2 })), false, "nor a stop");
  assert.equal(C.clickApproves(perRow, "teardown", rec("demo-b", { slot: 0 })), false, "never slot 0");
  assert.deepEqual(C.approvedLeftover(perRow, "/p/demo", 5174)?.pid, 42);
  assert.equal(C.approvedLeftover(perRow, "/p/demo", 5175), null);
  assert.equal(C.approvedLeftover(perRow, "/p/other", 5174), null);
  // A card-level option: "Tear Down All" approves every copy's teardown; "Not Now" nothing, though it touches every row.
  const all = clicks("c_1", user("c_1 a: Tear Down All"));
  assert.equal(C.clickApproves(all, "teardown", rec("demo-a")) && C.clickApproves(all, "teardown", rec("demo-b", { slot: 2 })), true);
  assert.equal(C.approvedLeftover(all, "/p/demo", 5174), null, "a Tear Down label stops no process");
  const not = clicks("c_1", user("c_1 b: Not Now"));
  assert.ok(not && not.length === 3, "a card-wide option touches every row");
  assert.equal(C.clickApproves(not, "teardown", rec("demo-a")), false);
  // Typed text approves nothing: no mark (a typed or pasted message, a Retry), or text that is not the click's.
  assert.equal(clicks(null, user("c_1: 1a Tear Down")), null, "typed or a Retry: no mark");
  assert.equal(clicks("c_1", user("yes, tear them down")), null);
  assert.equal(clicks("c_1", user("c_1: 1a Tear down")), null, "not the bytes a click composes");
  assert.equal(clicks("c_1", user("c_1: 1a Tear Down"), user("and the other one")), null, "a later turn");
  const dropped = applyCardCall([created.card!], { card: "c_1", ops: [{ op: "drop", reason: "Done by hand." }] }, { now: "2026-10-26T10:01:00.000Z" }).details;
  assert.equal(clicks("c_1", result(dropped, "k2"), user("c_1: 1a Tear Down")), null, "a dropped card");
  // The engine's hook reads the click per call.
  let now: ReturnType<typeof C.confirmedClicks> = perRow;
  const approved = C.copyApproval(() => now);
  assert.equal(approved("teardown", rec("demo-b", { slot: 2 })), true);
  now = null;
  assert.equal(approved("teardown", rec("demo-b", { slot: 2 })), false, "only in that turn");
});

test("the act words: Tear Down, Reset and Stop at the label's start; nothing else", () => {
  for (const [label, act, ok] of [
    ["Tear Down", "teardown", true],
    ["Teardown", "teardown", true],
    ["Tear Down All", "teardown", true],
    ["Reset Data", "reset", true],
    ["Stop", "down", true],
    ["Stop It", "stop-leftover", true],
    ["Keep", "teardown", false],
    ["Not Now", "down", false],
    ["Cancel", "reset", false],
    ["Don't Tear Down", "teardown", false],
    ["Stopwatch", "down", false],
  ] as const)
    assert.equal(choiceNames(label, act), ok, `${label} → ${act}`);
});

test("the Overseer's tool: leftovers is a read; stop-leftover goes through its act wrapper and needs a Stop click on that row", async () => {
  const { overseerVerbsTool, projectOverseerVerbsTool } = await import("./project-services/tools");
  const wrapped: string[] = [];
  let clicks: import("../shared/overseer-card").ClickChoice[] | null = null;
  const host = { platform: "darwin" } as never;
  const copies = { clicks: () => clicks, approved: C.copyApproval(() => clicks), host: () => host };
  const t = overseerVerbsTool((() => ({})) as never, () => "o-1", (exec) => (id, params, ...rest) => (wrapped.push(String(params?.verb)), exec(id, params, ...rest)), undefined, copies);
  const run = async (params: Record<string, unknown>) => ((await t.execute("k", params, undefined, undefined, undefined as never)) as { content: { text: string }[] }).content[0]!.text;
  assert.equal(await run({ verb: "leftovers", project: "/p/demo" }), "leftovers: Sova can't tell which process holds a port on this computer.");
  assert.deepEqual(wrapped, [], "a read: no act");
  assert.match(await run({ verb: "stop-leftover", project: "/p/demo", port: 5174 }), /^stop-leftover failed: needs-confirm: Stopping a leftover process runs only in the turn the user's click on a card listing it opens/);
  assert.deepEqual(wrapped, ["stop-leftover"], "an act: the wrapper keeps it to the user's turns");
  const row = { n: 1, kind: "leftover", id: "5174:42:9", project: "/p/demo", projectName: "Demo", slot: 1, port: 5174, pid: 42, start: "9", command: "vite", folder: "/x (deleted)", reason: "folder-gone" } as never;
  clicks = [{ item: row, choice: "Keep" }];
  assert.match(await run({ verb: "stop-leftover", project: "/p/demo", port: 5174 }), /needs-confirm/, "Keep approves nothing");
  clicks = [{ item: row, choice: "Stop" }];
  assert.equal(await run({ verb: "stop-leftover", project: "/p/demo", port: 5174 }), "stop-leftover failed: Sova can't tell which process holds a port on this computer.", "approved: the stop itself runs (and says it can't tell here)");
  // The project overseer's: only its own project.
  const p = projectOverseerVerbsTool((() => ({})) as never, { id: () => "po", root: () => "/p/demo", act: async () => {}, copies: { ...copies, root: async () => "/p/demo" } });
  const prun = async (params: Record<string, unknown>) => ((await p.execute("k", params, undefined, undefined, undefined as never)) as { content: { text: string }[] }).content[0]!.text;
  assert.match(await prun({ verb: "leftovers", project: "/p/other" }), /forbidden: this caller acts only on its own project/);
  assert.match(t.description, /only in the turn the user's click on a card listing it opens/);
  assert.match(t.description, /runs on the user's word once its conversation is finished or archived/);
  assert.match(t.description, /carries its URL: give it to the user in your reply/);
  assert.match(p.description, /On the operator's word \(a turn they started\): stopping a copy with an active share link/);
  assert.doesNotMatch(t.description, /down of a copy with an active link is the operator's/, "the old rule is gone from this tool's words");
});
