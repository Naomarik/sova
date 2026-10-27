// Go on a Ready to land row of an Overseer card (§app.overseer/card-land), end to end over a real git repository:
// the card snapshots the branch and head at raise, the Apply's click opens the turn, sova_land records the go-ahead
// for exactly that commit (or, the branch moved, nothing, and the row stays undecided with the reason), Not Yet
// records nothing, a turn no click opened records nothing, and every attempt is a line in overseer-actions.jsonl.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { SessionSummary, WorktreeReadiness } from "../shared/protocol";
import type { OverseerToolHost } from "./overseer-tools";
import { scratchRoot } from "./test-scratch";

const root = scratchRoot("sova-overseer-land-card-");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
after(() => rmSync(root, { recursive: true, force: true }));

const { overseerTools, TurnLimits, LAND_REST_REFUSAL, LAND_NO_CLICK_REFUSAL } = await import("./overseer-tools");
const overseer = await import("./overseer");
const confirm = await import("./overseer-confirm");
const { historyOf } = await import("./harness/pi/reader");
const { applyCardCall, cardLines, itemsClick } = await import("../shared/overseer-card");
const { DEFAULT_CAPS, overseerActionsFile } = await import("./overseer-store");
const { recordCardGoAhead } = await import("./overseer-land");
const { readLanding, recordGoAhead } = await import("../pi-config/extensions/worktrees/landing.ts");

const NOW = "2026-10-27T10:00:00.000Z";
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A repository with a worktree on `branch`, one commit ahead; commit() adds another and returns its sha. */
function repo(name: string, branch: string) {
  const main = join(root, name);
  mkdirSync(main, { recursive: true });
  sh(main, "init", "-q", "-b", "master");
  sh(main, "config", "user.email", "t@example.invalid");
  sh(main, "config", "user.name", "t");
  sh(main, "config", "commit.gpgsign", "false");
  writeFileSync(join(main, "a.txt"), "one\n");
  sh(main, "add", "a.txt");
  sh(main, "commit", "-q", "-m", "one");
  const tree = join(root, `${name}-wt`);
  sh(main, "worktree", "add", "-q", "-b", branch, tree);
  let n = 0;
  const commit = () => (writeFileSync(join(tree, `f${++n}.txt`), String(n)), sh(tree, "add", "."), sh(tree, "commit", "-q", "-m", `c${n}`), sh(tree, "rev-parse", "HEAD"));
  return { tree, commit, head: () => sh(tree, "rev-parse", "HEAD") };
}

/**
 * One land card over sessions s1 (feat/one) and s2 (feat/two), each Ready to land at its head when raised, then an
 * Apply composing `picks`; the sova_land tool in that turn (or, `click: false`, in a typed turn), the real recorder
 * over a landing.json of its own, wakes counted.
 */
async function scene(name: string, picks: Record<number, string>, opts: { click?: boolean } = {}) {
  const one = repo(`${name}-one`, "feat/one");
  const two = repo(`${name}-two`, "feat/two");
  one.commit();
  two.commit();
  const trees: Record<string, { tree: string; branch: string }> = { s1: { tree: one.tree, branch: "feat/one" }, s2: { tree: two.tree, branch: "feat/two" } };
  const summary = (id: string) => ({ id, path: `/sessions/${id}.jsonl`, cwd: trees[id]!.tree, title: `Session ${id}` }) as SessionSummary;
  /** Readiness as Sova would read it now: Ready to land at the branch's current head. */
  const ready = (id: string): WorktreeReadiness => {
    const t = trees[id]!;
    return { path: t.tree, branch: t.branch, state: "ready", landing: { state: "ready", commit: sh(t.tree, "rev-parse", "HEAD") } };
  };
  const lookup = {
    session: async (ref: string) => (trees[ref] ? summary(ref) : null),
    isSelf: () => false,
    idea: () => null,
    todo: () => null,
    person: () => null,
    project: () => null,
    readyToLand: async (s: SessionSummary) => [ready(s.id)].map((t) => ({ branch: t.branch, head: t.landing!.commit })),
  };
  const items = await confirm.resolveConfirmItems(
    { sessions: [{ id: "s1", land: true, section: "Ready to land", note: "Finished and green." }, { id: "s2", land: "feat/two", section: "Ready to land", note: "Finished and green." }] },
    lookup,
    (m) => new Error(m),
  );
  const created = applyCardCall(
    [],
    { ops: [{ op: "create", title: "Get things moving", choices: ["Go", "Not Yet"] }] },
    { now: NOW, prepared: { items, hrefs: [], clickOnly: await confirm.clickOnlyCard(items, lookup) } },
  ).details;
  const card = created.card!;
  const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
  const result = (details: unknown, id: string) => ({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: "sova_card", details } });
  const apply = itemsClick(card, picks)!;
  const branch = historyOf([user("get things moving"), result(created, "k1"), user(opts.click === false ? "yes, land them" : apply)]);
  const file = join(root, `${name}-landing.json`);
  const wakes: string[] = [];
  const host = {
    overseerId: () => "ov",
    caps: () => DEFAULT_CAPS,
    attended: () => true,
    session: async (ref: string) => (trees[ref] ? summary(ref) : null),
    confirmed: () => overseer.confirmedItems(opts.click === false ? null : "c_1", branch),
    confirmedRows: () => overseer.confirmedRows(opts.click === false ? null : "c_1", branch),
    landAtCommit: (input: { session: string; branch: string; head: string }) =>
      recordCardGoAhead(input, {
        pathOf: async (id) => (trees[id] ? `/sessions/${id}.jsonl` : undefined),
        summary: async (p) => summary(p.slice("/sessions/".length, -".jsonl".length)),
        readiness: async (s) => ({ trees: [ready(s.id)] }) as SessionSummary["readiness"],
        record: (rec) => recordGoAhead({ ...rec, by: "overseer-card" }, file),
        wake: () => void wakes.push(input.branch),
        now: () => new Date(NOW),
      }),
  } as unknown as OverseerToolHost;
  const land = overseerTools(host, new TurnLimits()).find((t) => t.name === "sova_land")!;
  const call = (session: string) =>
    land.execute(`${name}-${session}`, { session }, undefined, undefined, undefined as never).then(
      (r) => (r.content[0] as { text: string }).text,
      (e: Error) => `ERROR: ${e.message}`,
    );
  const recorded = () => (existsSync(file) ? readLanding(file).goAheads : []);
  return { one, two, card, apply, call, recorded, wakes };
}

/** The audit lines sova_land wrote for these tool call ids. */
const audit = (...ids: string[]) =>
  readFileSync(overseerActionsFile(), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { tool: string; toolCallId: string; outcome: string; args: { session: string } })
    .filter((l) => l.tool === "sova_land" && ids.includes(l.toolCallId));

describe("Go on an Overseer card's Ready to land row (§app.overseer/card-land)", () => {
  test("the card snapshots each land row's branch and head at raise, is click-only, and tells the model", async () => {
    const s = await scene("raise", { 1: "a", 2: "a" });
    const rows = s.card.items.map((it) => (it.kind === "session" ? [it.id, it.land?.branch, it.land?.head] : []));
    assert.deepEqual(rows, [["s1", "feat/one", s.one.head()], ["s2", "feat/two", s.two.head()]]);
    assert.equal(s.card.clickOnly, true);
    assert.match(cardLines(s.card, "").join("\n"), new RegExp(`land feat/one at ${s.one.head().slice(0, 7)}: Go lands it with sova_land`));
  });

  test("Go at the unchanged head records the go-ahead at that head and wakes the captain; Not Yet records nothing", async () => {
    const s = await scene("go", { 1: "a", 2: "b" });
    const A = s.one.head();
    assert.match(await s.call("s1"), new RegExp(`^Recorded the user's go-ahead to land feat/one at ${A.slice(0, 7)} \\(Apply on the Overseer's card\\)`));
    assert.match(await s.call("s2"), /^ERROR: The user didn't choose Go on the feat\/two row \(they chose b\): nothing was recorded/);
    assert.deepEqual(s.recorded(), [{ branch: "feat/one", commit: A, session: "s1", at: NOW, by: "overseer-card" }]);
    assert.deepEqual(s.wakes, ["feat/one"]);
    assert.deepEqual(audit("go-s1", "go-s2").map((l) => [l.args.session, l.outcome]), [["s1", "ok"], ["s2", "refused"]]);
  });

  test("the branch moved after the card was raised: nothing is recorded, no wake, and the refusal says why and to leave the row undecided", async () => {
    const s = await scene("moved", { 1: "a", 2: "a" });
    const A = s.one.head();
    const B = s.one.commit();
    const out = await s.call("s1");
    assert.equal(out, `ERROR: feat/one has a newer commit (${B.slice(0, 7)}) than the one you saw (${A.slice(0, 7)}). ${LAND_REST_REFUSAL}`);
    assert.deepEqual(s.recorded(), []);
    assert.deepEqual(s.wakes, []);
    assert.deepEqual(audit("moved-s1").map((l) => l.outcome), ["refused"]);
    // The other row, unmoved, still lands at its own head.
    assert.match(await s.call("s2"), /^Recorded the user's go-ahead to land feat\/two/);
    assert.deepEqual(s.recorded().map((g) => g.branch), ["feat/two"]);
  });

  test("a turn no click on the card opened records nothing, whatever the typed words; so does a session that isn't a land row", async () => {
    const s = await scene("typed", { 1: "a", 2: "a" }, { click: false });
    assert.equal(await s.call("s1"), `ERROR: ${LAND_NO_CLICK_REFUSAL}`);
    assert.deepEqual(s.recorded(), []);
    assert.deepEqual(s.wakes, []);
    const c = await scene("other", { 1: "a" });
    assert.match(await c.call("s2"), /^ERROR: s2 isn't a Ready to land row of the card whose click opened this turn: nothing was recorded/, "the click gave row 2 no pick");
    assert.match(await c.call("s9"), /isn't a Ready to land row/);
    assert.deepEqual(c.recorded(), []);
  });
});

describe("raising a land row (resolveConfirmItems)", () => {
  const s1 = { id: "s1", path: "/s/s1.jsonl", cwd: "/x", title: "One" } as SessionSummary;
  const base = { session: async (ref: string) => (ref === "s1" ? s1 : null), isSelf: () => false, idea: () => null, todo: () => null };
  const ready = (...branches: string[]) => ({ ...base, readyToLand: async () => branches.map((b) => ({ branch: b, head: "a".repeat(40) })) });
  const raise = (lookup: object, land: unknown) => confirm.resolveConfirmItems({ sessions: [{ id: "s1", land }] }, lookup as never, (m) => new Error(m));

  test("refused with its reason when the session has no ready branch, more than one unnamed, or a named one that isn't ready", async () => {
    await assert.rejects(raise(ready(), true), /s1 has no worktree Ready to land now, so it can't be a land row/);
    await assert.rejects(raise(ready("feat/a", "feat/b"), true), /s1 has 2 branches Ready to land \(feat\/a, feat\/b\): name the one this row lands, land: "<branch>"/);
    await assert.rejects(raise(ready("feat/a"), "feat/z"), /feat\/z isn't Ready to land now \(ready: feat\/a\)/);
    assert.deepEqual((await raise(ready("feat/a", "feat/b"), "feat/b"))[0], { kind: "session", id: "s1", title: "One", project: "x", land: { branch: "feat/b", head: "a".repeat(40) } });
  });

  test("the project overseer (no readyToLand) takes no land rows; a land row needs choices", async () => {
    await assert.rejects(raise(base, true), /land rows are the global Overseer's only/);
    const items = await raise(ready("feat/a"), true);
    assert.throws(() => applyCardCall([], { ops: [{ op: "create", title: "Land?", options: [{ label: "Ok" }] }] }, { now: NOW, prepared: { items, hrefs: [] } }), /s1 is a land row, so it needs choices/);
  });
});
