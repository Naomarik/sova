import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitRepoSummary, SessionSetup } from "../../shared/protocol";
import {
  agoLabel,
  CONTEXT_NONE,
  contextHeading,
  contextRows,
  contextSum,
  fileFacts,
  gitView,
  isSumEmpty,
  linesLabel,
  loadoutView,
  sizeLabel,
  skillsHeading,
  skillsNone,
  skillsNote,
  skillsSum,
  sumFacts,
  systemContextSum,
} from "./session-setup";

type Loaded = Extract<SessionSetup, { state: "ok" }>;

const setup = (over: Partial<Loaded>): Loaded => ({
  state: "ok",
  where: { kind: "local" },
  cwd: "/home/u/proj",
  context: [],
  skills: [],
  fromRuntime: true,
  checkedAt: 0,
  ...over,
});

const base: GitRepoSummary = {
  state: "repo",
  where: { kind: "local" },
  cwd: "/home/u/proj",
  root: "/home/u/proj",
  head: { kind: "branch", name: "main" },
  unborn: false,
  upstream: null,
  counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  clean: true,
  lastCommit: null,
  files: [],
  filesTotal: 0,
  statusPartial: false,
  lines: "ok",
  added: 0,
  removed: 0,
  checkedAt: 0,
};
const repo = (over: Partial<GitRepoSummary>): GitRepoSummary => ({ ...base, ...over });
const NOW = Date.parse("2026-09-23T12:00:00Z");

test("size: bytes below 1 KB, one decimal from exactly 1024, whole KB from 10", () => {
  assert.equal(sizeLabel(0), "0 B");
  assert.equal(sizeLabel(1023), "1023 B");
  assert.equal(sizeLabel(1024), "1.0 KB");
  assert.equal(sizeLabel(4300), "4.2 KB");
  // 10 KB never reads as "10.0 KB": the switch to whole numbers happens where rounding would.
  assert.equal(sizeLabel(10_188), "9.9 KB");
  assert.equal(sizeLabel(10_190), "10 KB");
  assert.equal(sizeLabel(2_000_000), "1,953 KB");
});

test("lines: singular only for exactly 1, thousands separated", () => {
  assert.equal(linesLabel(1), "1 line");
  assert.equal(linesLabel(0), "0 lines");
  assert.equal(linesLabel(2), "2 lines");
  assert.equal(linesLabel(1204), "1,204 lines");
  assert.equal(fileFacts({ path: "/a", bytes: 1024, lines: 1 }), "1.0 KB · 1 line");
});

test("context: system prompt first, context files in order, appended sources last — each role said", () => {
  const rows = contextRows(
    setup({
      systemPrompt: { path: "/home/u/proj/.pi/SYSTEM.md", bytes: 10, lines: 1 },
      context: [
        { path: "/home/u/.pi/agent/AGENTS.md", bytes: 10, lines: 1 },
        { path: "/home/u/proj/CLAUDE.md", bytes: 10, lines: 1 },
      ],
      appendSystemPrompt: [{ path: "/home/u/proj/.pi/APPEND_SYSTEM.md", bytes: 10, lines: 1 }],
    }),
    "/home/u",
  );
  assert.deepEqual(
    rows.map((r) => [r.label, r.role]),
    [
      ["~/proj/.pi/SYSTEM.md", "replaces the system prompt"],
      ["~/.pi/agent/AGENTS.md", null],
      ["~/proj/CLAUDE.md", null],
      ["~/proj/.pi/APPEND_SYSTEM.md", "appended to the system prompt"],
    ],
  );
  assert.equal(contextHeading(rows.length), "Context · 4");
});

test("empty lists: zero counts in the labels and a sentence each, never a blank group", () => {
  const empty = setup({});
  assert.deepEqual(contextRows(empty, "/home/u"), []);
  assert.equal(contextHeading(0), "Context · 0");
  assert.equal(skillsHeading(0), "Skills · 0");
  assert.equal(CONTEXT_NONE, "No context files. pi loads AGENTS.md or CLAUDE.md when a folder has one.");
  assert.equal(skillsNone(empty), "No skills offered to this session.");
});

test("sums: one aggregate line, and the two sections below add up to it to the byte", () => {
  const s = setup({
    systemPrompt: { path: "/p/.pi/SYSTEM.md", bytes: 1024, lines: 10 },
    context: [{ path: "/a/AGENTS.md", bytes: 2048, lines: 20 }],
    appendSystemPrompt: [{ path: "/p/.pi/APPEND_SYSTEM.md", bytes: 512, lines: 5 }],
    skills: [{ path: "/s/k/SKILL.md", name: "k", bytes: 4096, lines: 40 }],
  });
  // the system prompt and the appended source are in the prompt, so they are in the Context sum
  assert.deepEqual(contextSum(s), { bytes: 3584, lines: 35 });
  assert.deepEqual(skillsSum(s), { bytes: 4096, lines: 40 });
  // the aggregate line's figures, figured the way one row's figures are
  assert.equal(sumFacts(systemContextSum(s)), "7.5 KB · 75 lines");
  assert.deepEqual(systemContextSum(s), {
    bytes: contextSum(s).bytes + skillsSum(s).bytes,
    lines: contextSum(s).lines + skillsSum(s).lines,
  });
  // and the line counts exactly the rows the card draws — no file summed that isn't listed
  const drawn = [...contextRows(s, null).map((r) => r.file), ...s.skills];
  assert.equal(drawn.length, contextRows(s, null).length + s.skills.length);
  assert.equal(drawn.reduce((n, f) => n + f.bytes, 0), systemContextSum(s).bytes);
  assert.equal(drawn.reduce((n, f) => n + f.lines, 0), systemContextSum(s).lines);
});

test("sums: a zero total is never drawn, and an empty file still gets its row", () => {
  assert.deepEqual(systemContextSum(setup({})), { bytes: 0, lines: 0 });
  assert.equal(isSumEmpty(systemContextSum(setup({}))), true);
  const blank = setup({ context: [{ path: "/a/AGENTS.md", bytes: 0, lines: 0 }] });
  assert.equal(contextRows(blank, null).length, 1); // the list draws it
  assert.equal(isSumEmpty(contextSum(blank)), true); // the total doesn't
  assert.equal(isSumEmpty(skillsSum(blank)), true);
  assert.equal(isSumEmpty(contextSum(setup({ context: [{ path: "/a/AGENTS.md", bytes: 1, lines: 0 }] }))), false);
});

test("skills: offered, not loaded — and a list Sova built itself says what it can't see", () => {
  assert.equal(skillsNote(setup({})), "Offered to this session. A skill loads when it is used.");
  assert.equal(skillsNote(setup({ fromRuntime: false })), "Offered to this session. A skill loads when it is used. Skills an extension adds aren't listed.");
  assert.equal(skillsNone(setup({ fromRuntime: false })), "No skills offered to this session. Skills an extension adds aren't listed.");
});

test("loadout: local reads get the groups; remote and unavailable get exactly one line", () => {
  const ok = setup({});
  assert.deepEqual(loadoutView(ok), { kind: "groups", setup: ok });
  assert.deepEqual(loadoutView({ state: "remote", where: { kind: "remote", target: "box" }, cwd: "/home/u/.pi/agent/sova/remote/box", checkedAt: 0 }), {
    kind: "line",
    text: "Skills and context files are read on box, so they aren't listed here.",
  });
  assert.deepEqual(loadoutView({ state: "unavailable", where: { kind: "local" }, cwd: "/gone", reason: "The folder /gone doesn't exist.", checkedAt: 0 }), {
    kind: "line",
    text: "The folder /gone doesn't exist.",
  });
});

test("git repo: the Repository pane's words, the sum only when there is one, the commit shortened", () => {
  const v = gitView(
    repo({
      upstream: { name: "origin/main", ahead: 2, behind: 0 },
      clean: false,
      counts: { staged: 1, unstaged: 2, untracked: 3, conflicted: 0 },
      added: 40,
      removed: 7,
      lastCommit: { oid: "1a2b3c4d5e6f7a8b", subject: "fix the thing", at: NOW - 2 * 3600_000 },
    }),
    "/home/u",
    NOW,
  );
  assert.deepEqual(v, {
    kind: "repo",
    head: "main",
    upstream: "2 ahead origin/main",
    changes: "1 staged · 2 unstaged · 3 untracked",
    lines: { added: 40, removed: 7 },
    note: null,
    commit: { oid: "1a2b3c4", subject: "fix the thing", ago: "2h ago" },
    noCommit: null,
  });
  const clean = gitView(base, "/home/u", NOW);
  assert.equal(clean.kind === "repo" && clean.changes, "Clean");
  assert.equal(clean.kind === "repo" && clean.upstream, null); // no upstream: nothing said, not "None set"
  assert.equal(clean.kind === "repo" && clean.lines, null); // never "+0 −0"
  assert.equal(clean.kind === "repo" && clean.noCommit, "The last commit couldn't be read.");
  const unborn = gitView(repo({ unborn: true }), "/home/u", NOW);
  assert.equal(unborn.kind === "repo" && unborn.head, "main · no commits yet");
  assert.equal(unborn.kind === "repo" && unborn.noCommit, null);
});

test("git partial: a status cut short never reads as clean, and says why", () => {
  const nothing = gitView(repo({ clean: false, statusPartial: true }), "/home/u", NOW);
  assert.equal(nothing.kind, "repo");
  if (nothing.kind !== "repo") return;
  assert.notEqual(nothing.changes, "Clean");
  assert.equal(nothing.changes, "Not fully read");
  assert.equal(nothing.note, "Git status was cut short, so these counts are lower bounds.");
  const some = gitView(repo({ clean: false, statusPartial: true, counts: { staged: 0, unstaged: 4, untracked: 0, conflicted: 0 } }), "/home/u", NOW);
  assert.equal(some.kind === "repo" && some.changes, "At least 4 unstaged");
  const timedOut = gitView(repo({ lines: "timeout" }), "/home/u", NOW);
  assert.equal(timedOut.kind === "repo" && timedOut.note, 'Counting lines took too long in this repository. Rows say "not counted".');
});

test("git none and unavailable: one sentence each", () => {
  assert.deepEqual(gitView({ state: "none", where: { kind: "local" }, cwd: "/home/u/scratch", checkedAt: 0 }, "/home/u", NOW), {
    kind: "line",
    text: "~/scratch isn't inside a git repository.",
  });
  assert.deepEqual(gitView({ state: "none", where: { kind: "remote", target: "box" }, cwd: "/srv/x", checkedAt: 0 }, "/home/u", NOW), {
    kind: "line",
    text: "box:/srv/x isn't inside a git repository.",
  });
  assert.deepEqual(gitView({ state: "unavailable", where: { kind: "local" }, cwd: "/gone", reason: "The folder /gone doesn't exist.", checkedAt: 0 }, null, NOW), {
    kind: "line",
    text: "The folder /gone doesn't exist.",
  });
});

test("ago: a ms epoch reads like relativeTime, and a bad number reads as nothing", () => {
  assert.equal(agoLabel(NOW - 10_000, NOW), "just now");
  assert.equal(agoLabel(NOW - 3 * 86_400_000, NOW), "3d ago");
  assert.equal(agoLabel(Number.NaN, NOW), "");
});
