// Run: npx tsx --test src/lib/agents-board.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentsInsight, LiveAgentSession, SessionSummary, TeamInfo, WorktreeStatus } from "../../shared/protocol";
import {
  boardRows,
  boardState,
  boardTotals,
  filterCounts,
  gistTitle,
  hasUnmerged,
  inDefaultScope,
  matchesSearch,
  money,
  passesFilter,
  rowDetail,
  rowHasDetail,
  sortRows,
  teamForLink,
  totalsLine,
  treeLines,
  treeMerge,
  treeName,
  visibleRows,
  worktreePathsKey,
} from "./agents-board";
import { teamKey } from "./insights";

const NOW = Date.parse("2026-09-27T15:00:00.000Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const sess = (name: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id: name,
  path: `/s/${name}.jsonl`,
  cwd: `/w/${name}`,
  title: `Title ${name}`,
  createdAt: ago(600),
  lastActiveAt: ago(60),
  model: "anthropic/claude-opus-5-5",
  live: null,
  busy: false,
  origin: "external",
  archived: false,
  ...extra,
});

const agent = (path: string, extra: Partial<LiveAgentSession> = {}): LiveAgentSession => ({
  path,
  sessionId: null,
  name: null,
  cwd: "/w",
  pid: 1,
  mode: "rpc",
  embedded: true,
  fresh: true,
  state: "idle",
  workerCounts: { total: 0, working: 0, waiting: 0, done: 0, error: 0, killed: 0 },
  workers: [],
  teams: [],
  ...extra,
});

const tree = (path: string, extra: Partial<WorktreeStatus> = {}): WorktreeStatus => ({ path, source: "session", exists: true, branch: "feat/x", base: "master", ...extra });
const team = (id: string, parentPath: string, createdAt = 0): TeamInfo => ({ id, name: id, objective: "", createdAt, parentPath, live: true, members: [], working: 0 });
const insight = (sessions: LiveAgentSession[]): AgentsInsight => ({ at: NOW, totals: { sessions: 0, working: 0, total: 0, teams: 0, teamWorking: 0, soloWorking: 0 }, sessions });
const noBusy = () => false;
const none = () => undefined;

test("state: a question outranks work, work outranks what the last turn left, then idle or archived", () => {
  assert.equal(boardState(sess("a", { activity: { state: "needs-input" }, busy: true }), null, true).state, "needs-you");
  assert.equal(boardState(sess("a", { pendingDialogs: 2 }), null, false).reason, "2 dialogs are waiting on you.");
  assert.equal(boardState(sess("a", { turnError: {} }), null, true).state, "working", "busy wins over a failed last turn");
  assert.equal(boardState(sess("a"), agent("/s/a.jsonl", { workerCounts: { total: 2, working: 1, waiting: 1, done: 0, error: 0, killed: 0 } }), false).state, "working");
  assert.equal(boardState(sess("a", { workers: { working: 1, total: 1 } }), null, false).state, "working", "no live record: the list's counts");
  const failed = boardState(sess("a", { turnError: { message: "429" } }), null, false);
  assert.deepEqual(failed, { state: "needs-you", reason: "Last turn failed: 429" });
  assert.equal(boardState(sess("a", { signals: { kinds: ["looping"], at: 5 } } as Partial<SessionSummary>), null, false).state, "needs-you");
  assert.equal(boardState(sess("a", { signals: { kinds: ["looping"], at: 5 }, seenAt: 6 } as Partial<SessionSummary>), null, false).state, "idle", "seen since: nothing new");
  assert.deepEqual(boardState(sess("a", { signals: { kinds: ["asks-you"], at: 5 } } as Partial<SessionSummary>), null, false), { state: "needs-you", reason: "The last reply asks you something." });
  const asking = { align: { openDocs: 1, openQuestions: 2, questionDocs: 1, lead: { id: "al_1", title: "Export" } } };
  assert.deepEqual(boardState(sess("a", { ...asking, seenAt: 99 }), null, false), { state: "needs-you", reason: "2 open questions in al_1 Export" }, "open questions need you until answered");
  assert.equal(boardState(sess("a", { archived: true }), null, false).state, "archived");
  assert.equal(boardState(sess("a", { archived: true }), agent("/s/a.jsonl"), false).state, "idle", "an archived session something runs in is not shown as archived");
});

test("rows: main threads only, matched to their host record by path; headless workers don't match", () => {
  const list = [sess("a"), sess("w", { workerSession: true }), sess("o", { overseer: true }), sess("b")];
  const rows = boardRows(list, insight([agent("/s/a.jsonl"), agent("/s/b.jsonl", { embedded: false })]), noBusy);
  assert.deepEqual(rows.map((r) => r.session.id), ["a", "b"]);
  assert.equal(rows[0]!.live, true);
  assert.equal(rows[1]!.agent, null, "an rpc record that isn't embedded is a worker pi, not the session's");
  assert.equal(rows[1]!.live, false);
});

test("default scope: live, or started in Sova and not archived", () => {
  const rows = boardRows(
    [sess("live", { live: { pid: 1, status: "idle" } }), sess("web", { origin: "web" }), sess("arch", { origin: "web", archived: true }), sess("old"), sess("hosted", { activity: { state: "idle" } })],
    undefined,
    noBusy,
  );
  assert.deepEqual(rows.filter(inDefaultScope).map((r) => r.session.id), ["live", "web", "hosted"]);
});

test("filters: each chip says what it means; Unmerged needs a reading; Archived is only what you archived", () => {
  const rows = boardRows(
    [
      sess("live", { live: { pid: 1, status: "idle" }, workers: { working: 0, total: 3 } }),
      sess("web", { origin: "web", turnError: {} }),
      sess("arch", { origin: "web", archived: true }),
      sess("old", { turnError: {} }),
    ],
    undefined,
    noBusy,
  );
  const ids = (f: Parameters<typeof passesFilter>[1], treesOf: (p: string) => WorktreeStatus[] | undefined = none) => rows.filter((r) => passesFilter(r, f, treesOf(r.session.path))).map((r) => r.session.id);
  assert.deepEqual(ids("live"), ["live"]);
  assert.deepEqual(ids("needs-you"), ["web", "old"], "a session that asks is on the board wherever it is");
  assert.deepEqual(ids("has-workers"), ["live"]);
  assert.deepEqual(ids("archived"), ["arch"]);
  assert.deepEqual(ids("unmerged"), [], "nothing read yet: nothing is unmerged");
  const trees = (p: string) => (p === "/s/web.jsonl" || p === "/s/old.jsonl" ? [tree("/t/1", { merged: "no" })] : [tree("/t/2", { merged: "ancestor" })]);
  assert.deepEqual(ids("unmerged", trees), ["web"], "unmerged narrows the default scope");
  assert.equal(hasUnmerged([tree("/t", { exists: false, merged: "no" })]), false, "a tree that's gone isn't counted");
  const counts = filterCounts(rows, trees);
  assert.deepEqual(counts, { live: 1, "needs-you": 2, "has-workers": 1, unmerged: 1, archived: 1 });
});

test("sort: working, then needs-you, then last active, newest first", () => {
  const rows = [
    { id: "idle-new", state: "idle", lastActive: 50 },
    { id: "needs-old", state: "needs-you", lastActive: 1 },
    { id: "work-old", state: "working", lastActive: 2 },
    { id: "arch-newest", state: "archived", lastActive: 99 },
    { id: "work-new", state: "working", lastActive: 9 },
  ] as const;
  assert.deepEqual(sortRows(rows).map((r) => r.id), ["work-new", "work-old", "needs-old", "arch-newest", "idle-new"]);
});

test("search: every word, across title, gist, path and branch; a search with no chip looks everywhere", () => {
  const rows = boardRows([sess("a", { origin: "web", outlineGist: "Theme tokens" }), sess("b", { title: "Fix login" })], undefined, noBusy);
  const trees = (p: string) => (p === "/s/b.jsonl" ? [tree("/t/b", { branch: "feat/auth-fix" })] : undefined);
  assert.equal(matchesSearch(rows[0]!, "theme TOKENS", undefined), true);
  assert.equal(matchesSearch(rows[0]!, "theme login", undefined), false, "every word must match");
  assert.equal(matchesSearch(rows[1]!, "auth-fix", trees("/s/b.jsonl")), true);
  assert.equal(matchesSearch(rows[1]!, "/w/b", undefined), true, "cwd");
  assert.deepEqual(visibleRows(rows, { filter: null, query: "", treesOf: trees }).map((r) => r.session.id), ["a"], "b is outside the default scope");
  assert.deepEqual(visibleRows(rows, { filter: null, query: "auth", treesOf: trees }).map((r) => r.session.id), ["b"], "searching reaches it");
  assert.deepEqual(visibleRows(rows, { filter: "archived", query: "auth", treesOf: trees }), [], "a chip still narrows a search");
  assert.deepEqual(visibleRows(rows, { filter: null, query: "", treesOf: trees, pinned: "/s/b.jsonl" }).map((r) => r.session.id), ["a", "b"], "a team link's session is pinned in");
});

test("totals: sessions working and live, the ledger's spend today, unmerged trees counted once", () => {
  const rows = boardRows(
    [sess("a", { lastActiveAt: ago(30) }), sess("b", { lastActiveAt: ago(60 * 24 * 3) }), sess("c", { live: { pid: 2, status: "x" } })],
    insight([agent("/s/a.jsonl", { state: "working" }), agent("/s/b.jsonl")]),
    noBusy,
  );
  const shared = tree("/t/shared", { merged: "no" });
  // Today's figure is the ledger's, whatever the rows are: no row's spend is summed into it.
  const t = boardTotals(rows, [[shared, tree("/t/m", { merged: "content" })], [shared], [tree("/t/own", { merged: "no" })]], { usd: 7.25 });
  assert.deepEqual(t, { working: 1, live: 3, spendToday: 7.25, unmerged: 2 });
  assert.equal(totalsLine(t), "1 working · 3 live · $7.25 today · 2 unmerged");
  const blank = boardTotals(boardRows([sess("x")], undefined, noBusy), [], undefined);
  assert.deepEqual(blank, { working: 0, live: 0, spendToday: null, unmerged: null });
  assert.equal(totalsLine(blank), "0 working · 0 live", "no answer yet and no reading: nothing claimed");
  assert.equal(boardTotals([], [], { usd: 0 }).spendToday, null, "nothing spent today: left out");
});

test("money: symbol first, two decimals, a sub-cent spend is not $0.00", () => {
  assert.equal(money(1240), "$1,240.00");
  assert.equal(money(0.001), "<$0.01");
  assert.equal(money(0), "$0.00");
});

test("worktrees: merged either way, ahead/behind when not, and plain words for what's unknown", () => {
  assert.deepEqual(treeMerge(tree("/t", { merged: "ancestor" })).kind, "merged");
  const content = treeMerge(tree("/t", { merged: "content" }));
  assert.equal(content.kind === "merged" && content.text, "content merged");
  assert.deepEqual(treeMerge(tree("/t", { merged: "no", ahead: 3, behind: 1 })), { kind: "diverged", ahead: 3, behind: 1 });
  assert.deepEqual(treeMerge(tree("/t", { base: undefined })), { kind: "unknown", text: "no base" });
  assert.deepEqual(treeMerge({ path: "/t", source: "worker", exists: false }), { kind: "unknown", text: "gone" });
  assert.deepEqual(treeMerge(tree("/t", { error: "fatal" })), { kind: "unknown", text: "unreadable" });
  assert.equal(treeName(tree("/t", { branch: undefined })), "detached");
  assert.equal(treeName({ path: "/w/.worktrees/sova-x/", source: "session", exists: false }), "sova-x");
  assert.equal(worktreePathsKey(boardRows([sess("a"), sess("b")], undefined, noBusy)), "/s/a.jsonl,/s/b.jsonl");
});

test("gist as title: one line within the limit, and nothing when it already is the title", () => {
  assert.equal(gistTitle({ title: "x", outlineGist: "  Theme\n tokens " }), "Theme tokens");
  assert.equal(gistTitle({ title: "Theme tokens", outlineGist: "Theme tokens" }), null);
  assert.equal(gistTitle({ title: "x" }), null);
  const long = gistTitle({ title: "x", outlineGist: "a".repeat(200) })!;
  assert.equal(long.length, 80);
  assert.ok(long.endsWith("…"));
});

test("a team link finds its team by key or bare id", () => {
  const a = agent("/s/a.jsonl", { teams: [team("team_01", "/s/a.jsonl", 10)] });
  const b = agent("/s/b.jsonl", { teams: [team("team_01", "/s/b.jsonl", 20)] });
  const data = insight([a, b]);
  assert.equal(teamForLink(data, teamKey(a.teams[0]!))?.parentPath, "/s/a.jsonl", "the exact key");
  assert.equal(teamForLink(data, "team_01")?.parentPath, "/s/b.jsonl", "a bare id: the newest");
  assert.equal(teamForLink(data, "team_01.zzz"), null, "a key that names no live team");
});

test("tree lines: both counts when the branch changes any; nothing for +0 −0 or an unread count", () => {
  assert.deepEqual(treeLines(tree("/t", { added: 3, removed: 0 })), { added: 3, removed: 0 });
  assert.equal(treeLines(tree("/t", { added: 0, removed: 0 })), null);
  assert.equal(treeLines(tree("/t", { added: 3 })), null);
});

test("the open row: what it's about and where it stands, never the same fact twice", () => {
  const plain = boardRows([sess("a")], undefined, noBusy)[0]!;
  const empty = rowDetail(plain, [tree("/t")]);
  assert.equal(rowHasDetail(empty), false, "an idle session with one clean tree has nothing to say: no twist");
  assert.deepEqual(empty.trees, [], "one clean tree is the cell already");
  assert.equal(rowHasDetail(rowDetail(plain, undefined)), false, "trees not read yet");

  const dirty = rowDetail(plain, [tree("/t", { dirty: true })]);
  assert.equal(dirty.trees.length, 1, "one dirty tree gets its line");
  assert.equal(rowDetail(plain, [tree("/t"), tree("/u")]).trees.length, 2, "2 trees get their lines");

  const topics = boardRows([sess("b", { outlineTopics: 3 })], undefined, noBusy)[0]!;
  assert.equal(rowDetail(topics, []).topics, true);
  assert.equal(rowHasDetail(rowDetail(topics, [])), true, "topics known from the list count");
  const noTopics = boardRows([sess("c", { outlineTopics: 0, outlineNow: "  " })], undefined, noBusy)[0]!;
  assert.equal(rowHasDetail(rowDetail(noTopics, [])), false, "0 topics and a blank now line say nothing");

  const now = boardRows([sess("d", { outlineNow: "Wiring the dropdown" })], undefined, noBusy)[0]!;
  assert.equal(rowDetail(now, []).now, "Wiring the dropdown");

  // The reason already says the error: no second line for it.
  const failed = boardRows([sess("e", { turnError: { message: "rate limit" } })], undefined, noBusy)[0]!;
  const f = rowDetail(failed, []);
  assert.equal(f.reason, "Last turn failed: rate limit");
  assert.equal(f.error, null);

  // Waiting on input wins the reason; the error and the question still get their own lines.
  const both = boardRows(
    [sess("g", { activity: { state: "needs-input" }, turnError: {}, align: { openDocs: 1, openQuestions: 1, questionDocs: 1, lead: { id: "al_2", title: "Dropdown" } } })],
    undefined,
    noBusy,
  )[0]!;
  const g = rowDetail(both, []);
  assert.equal(g.reason, "Waiting on your input.");
  assert.equal(g.error, "Last turn failed.");
  assert.equal(g.questions, "1 open question in al_2 Dropdown");

  // The questions are the reason: said once.
  const asks = boardRows([sess("h", { align: { openDocs: 1, openQuestions: 2, questionDocs: 1, lead: { id: "al_2", title: "Dropdown" } } })], undefined, noBusy)[0]!;
  const h = rowDetail(asks, []);
  assert.equal(h.reason, "2 open questions in al_2 Dropdown");
  assert.equal(h.questions, null);
});
