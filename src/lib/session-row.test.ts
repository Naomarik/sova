// Run: pnpm test -- src/lib/session-row.test.ts
// A row in the sessions pane (§app.session-list/anatomy, §app.extensions/row-chips): with no
// extension adding to rows, every row is exactly the row it was before line 3 became a place, its
// readiness badge included. Drawn with Solid's SSR build (src/lib/align-card-ssr.mjs) and compared
// with session-row.snapshot.json, taken from the rows as they stood before the place existed (base
// 9d508bba), retaken when the branch status replaced the "N of M" count (feat/pane-branch-status). Hydration keys and marker comments are left out: they say how Solid drew it, not what
// the page holds. Regenerate only for a change you mean:
// WRITE_ROW_SNAPSHOT=1 pnpm test -- src/lib/session-row.test.ts
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const { SessionRow } = await importSsr(new URL("../components/Sidebar.tsx", import.meta.url), (s: string) => import.meta.resolve(s));
const mesh = await import("./mesh");
const { RowPlaceContext } = await import("./row-place");
type RowChip = import("./row-place").RowChip;
type SessionSummary = import("../../shared/protocol").SessionSummary;
type SessionReadiness = import("../../shared/protocol").SessionReadiness;

const SNAPSHOT = new URL("./session-row.snapshot.json", import.meta.url);
const NOW = Date.parse("2026-02-01T02:00:00.000Z");

const session = (over: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id: "s-1",
    path: "/state/sessions/a.jsonl",
    cwd: "/work/a",
    title: "Fix the build",
    createdAt: "2026-02-01T00:00:00.000Z",
    lastActiveAt: "2026-02-01T00:00:00.000Z",
    model: "anthropic/claude-opus-5",
    ...over,
  }) as SessionSummary;

const tree = (branch: string, state: SessionReadiness["trees"][number]["state"], merged = false) => ({ path: `/work/${branch}`, branch, state, ...(merged ? { merged: true as const } : {}) });

type SessionBranchRow = import("../../shared/protocol").SessionBranchRow;
/** A branch as the list carries it, in a repo the queue serves. */
const branch = (name: string, over: Partial<SessionBranchRow> = {}): SessionBranchRow => ({ path: `/work/${name}`, branch: name, status: "active", exists: true, mergeServed: true, mergeProject: { target: "main", checks: "declared" }, ...over });
const SHA = "a".repeat(40);

/** Every line-3 shape a row has: no branches, each branch status, each badge after one, a remote row. */
const ROWS: Record<string, SessionSummary> = {
  plain: session(),
  "no model": session({ model: null }),
  "ready, beside one in progress": session({
    readiness: { trees: [tree("feat/a", "ready"), { ...tree("feat/b", "in-progress"), dirtyCount: 2 }], since: 0 },
    branches: [branch("feat/a"), branch("feat/b")],
  }),
  "needs a fix": session({ branches: [branch("feat/login", { queue: { state: "needs-fix", commit: SHA, reason: "Unit tests failed on the merge" } })] }),
  "needs you": session({ branches: [branch("feat/a", { queue: { state: "review-flagged", commit: SHA } }), branch("feat/b", { queue: { state: "needs-fix", commit: SHA } })] }),
  checking: session({ branches: [branch("feat/a", { queue: { state: "checking", commit: SHA } })] }),
  queued: session({ branches: [branch("feat/a", { queue: { state: "queued", commit: SHA, position: 2 } }), branch("feat/b", { queue: { state: "queued", commit: SHA, position: 3 } })] }),
  "inherited, ready": session({ branches: [branch("feat/parent", { sharedWith: "s-0" })] }),
  "restart pending": session({
    readiness: { trees: [tree("feat/a", "merged", true)], badge: "restart", since: 0, restartPending: true },
    branches: [branch("feat/a", { queue: { state: "landed", commit: SHA } })],
  }),
  "2 follow-ups": session({
    readiness: { trees: [tree("feat/a", "merged", true), tree("feat/c", "stale", true)], badge: "merged", since: 0, followUps: 2, followUp: { weight: "small", cue: "tidy the docs" } },
    branches: [branch("feat/a"), branch("feat/c")],
  }),
  "merged, no follow-up": session({ readiness: { trees: [tree("feat/a", "merged", true)], badge: "merged", since: 0 }, branches: [branch("feat/a", { status: "merged" })] }),
  "archived, sent back": session({ archived: true, branches: [branch("feat/old", { queue: { state: "needs-fix", commit: SHA } })] }),
  remote: session({ id: "s-r", path: "/peer/sessions/r.jsonl", readiness: { trees: [tree("feat/r", "merged", true)], badge: "restart", since: 0 }, branches: [branch("feat/r", { status: "merged" })] }),
};
mesh.noteHost("/peer/sessions/r.jsonl", "peer-1");

/** The row's markup, without Solid's hydration keys and marker comments. */
const drawRow = (s: SessionSummary, wrap?: (children: () => unknown) => unknown): string =>
  renderToString(() => {
    const row = () => solid.createComponent(SessionRow as never, { session: s, selected: null, now: NOW, targets: [] } as never);
    return (wrap ? wrap(row) : row()) as never;
  })
    .replace(/ data-hk="[^"]*"/g, "")
    .replace(/<!--[^>]*-->/g, "");

test("with no extension adding to rows, every row is exactly the row it was", () => {
  const drawn = Object.fromEntries(Object.entries(ROWS).map(([name, s]) => [name, drawRow(s)]));
  if (process.env.WRITE_ROW_SNAPSHOT) writeFileSync(SNAPSHOT, JSON.stringify(drawn, null, 2) + "\n");
  const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Record<string, string>;
  assert.deepEqual(Object.keys(drawn), Object.keys(snapshot));
  for (const name of Object.keys(snapshot)) assert.equal(drawn[name], snapshot[name], name);
  // The fixtures reach every shape: the badge in both words, and none.
  assert.match(snapshot["restart pending"]!, /<span class="session-readiness" title="[^"]*">restart pending<\/span>/);
  assert.match(snapshot["2 follow-ups"]!, />2 follow-ups<\/span>/);
  assert.doesNotMatch(snapshot.plain!, /session-readiness/);
  // The branch status: the chat's headline as a mark and a number, after the time, before the badge and the model.
  assert.doesNotMatch(snapshot.plain!, /session-branch-status/, "no branches: nothing");
  const mark = (name: string) => /<span class="session-branch-status ([^"]+)" title="([^"]*)"><span class="icon icon-sm" style="--icon:url\(\/icons\/([a-z-]+)\.svg\)" aria-hidden="true"><\/span><span class="text-num" aria-hidden="true">(\d+)<\/span><span class="visually-hidden">([^<]*)<\/span><\/span>/.exec(snapshot[name]!);
  const expect: Record<string, [cls: string, icon: string, n: string, first: string]> = {
    "ready, beside one in progress": ["session-branch-status-success session-branch-status-ready", "check-circle", "1", "1 ready"],
    "needs a fix": ["session-branch-status-error session-branch-status-fix", "alert-triangle", "1", "1 needs a fix"],
    "needs you": ["session-branch-status-warn session-branch-status-you", "alert-circle", "1", "1 needs you"],
    checking: ["session-branch-status-accent session-branch-status-checking", "progress", "1", "1 checking"],
    queued: ["session-branch-status-info session-branch-status-queued", "clock", "2", "2 queued"],
    "inherited, ready": ["session-branch-status-success session-branch-status-ready", "check-circle", "1", "1 ready"],
    "restart pending": ["session-branch-status-muted session-branch-status-worktrees", "branch", "1", "1 worktree"],
    // A stale tree reads Ready in the chat's rows too (its readiness isn't "merged", nothing uncommitted is counted).
    "2 follow-ups": ["session-branch-status-success session-branch-status-ready", "check-circle", "1", "1 ready"],
    "merged, no follow-up": ["session-branch-status-muted session-branch-status-worktrees", "branch", "1", "1 worktree"],
    "archived, sent back": ["session-branch-status-error session-branch-status-fix", "alert-triangle", "1", "1 needs a fix"],
  };
  for (const [name, [cls, icon, n, first]] of Object.entries(expect)) {
    const m = mark(name);
    assert.ok(m, name);
    assert.deepEqual([m[1], m[3], m[4]], [cls, icon, n], name);
    assert.equal(m[2]!.split("\n")[0], first, `${name}: the title starts with the chat's words`);
    assert.equal(m[5]!.split(". ")[0], first, `${name}: so does the row's name`);
  }
  assert.match(mark("needs a fix")![2]!, /\nfeat\/login: Needs a fix · Unit tests failed on the merge$/, "then each branch in the Worktrees window's words");
  assert.match(mark("restart pending")![2]!, /\nA merge changed the server since it started: restart it to run the new code\.$/, "then what follows a merge");
  assert.match(snapshot["restart pending"]!, /ago · <span class="session-branch-status [^]*?<\/span><\/span> · <span class="session-readiness"[^>]*>restart pending<\/span> · <span class="text-mono"/, "time, status, badge, model");
  assert.match(snapshot["2 follow-ups"]!, /<\/span><\/span> · <span class="session-readiness"[^>]*>2 follow-ups<\/span>/);
  for (const html of Object.values(snapshot)) assert.doesNotMatch(html, /\d+ of \d+/, "the old count is gone");
});

test("what extensions add stands after the readiness badge and before the model, as plain text", () => {
  const chips: RowChip[] = [
    { extension: "ci", extensionTitle: "CI", label: "CI green", tone: "ok", title: "All 12 checks passed" },
    { extension: "pr", extensionTitle: "Reviews", label: "PR 12", tone: "muted" },
  ];
  const withChips = (children: () => unknown) =>
    solid.createComponent(RowPlaceContext.Provider, {
      value: (s: SessionSummary) => (s.id === "s-1" ? chips : undefined),
      get children() {
        return children() as never;
      },
    });
  const html = drawRow(ROWS["restart pending"]!, withChips);
  const meta = html.slice(html.indexOf('<p class="list-meta">'));
  assert.match(
    meta,
    /restart pending<\/span> · <span class="session-row-chip session-row-chip-ok" title="All 12 checks passed · From CI"><span class="chip-dot" aria-hidden="true"><\/span>CI green<span class="visually-hidden">, from CI<\/span><\/span> · <span class="session-row-chip" title="PR 12 · From Reviews"><span class="chip-dot" aria-hidden="true"><\/span>PR 12<span class="visually-hidden">, from Reviews<\/span><\/span> · <span class="text-mono"/,
  );
  // Everything else on the row is exactly the snapshot's.
  const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Record<string, string>;
  assert.equal(html.replace(/ · <span class="session-row-chip[^]*?<\/span><\/span>/g, ""), snapshot["restart pending"]);
  // Another session in the same pane shows none.
  assert.equal(drawRow({ ...ROWS.plain!, id: "s-2" }, withChips), snapshot.plain);
});

test("a shut-down chat with a background job running shows `job running` after the time; a running chat shows none", () => {
  const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Record<string, string>;
  const html = drawRow(session({ jobsRunning: 2 }));
  assert.match(html, /ago · <span class="session-job-running">job running<\/span> · <span class="text-mono"/);
  // Nothing else on the row moves.
  assert.equal(html.replace(/ · <span class="session-job-running">job running<\/span>/, ""), snapshot.plain);
  // A chat with a process (its `chat` field) shows none, whatever the count says; so does an older server's row.
  const held = { model: "anthropic/claude-opus-5", thinking: "off", mode: "auto", minorModes: [], strict: false, applies: [] } as unknown as SessionSummary["chat"];
  assert.doesNotMatch(drawRow(session({ jobsRunning: 1, chat: held })), /job running/);
  assert.equal(drawRow(session({ jobsRunning: 0 })), snapshot.plain);
});
