// The Costs tab's By project fold: registered projects (worktrees, subfolders, archived ones), unregistered
// checkouts with their worktrees, the Overseer, and Other folders, always last; the rows add up to the Total.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { after, test } from "node:test";
import { formatUsageRecord, type UsageRecord } from "../../pi-config/extensions/llm-inflight/usage-record";
import { EMPTY_TABLE, mergeFetched, normalizeModelsDev, type Aliases } from "../../shared/model-prices/prices";
import type { UsageCosts } from "../../shared/usage/wire";
import { scratchRoot } from "../test-scratch";
import { folderMatcher } from "../project-folder";
import { foldCache, foldInputOf, projectFold, type FoldInput } from "./project-fold";
import { ALIASES_FILE } from "./price-book";
import { createService } from "./service";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A checkout (a `.git` folder: git is never run, so none is needed), and a linked worktree of it. */
const repo = (dir: string) => mkdirSync(join(dir, ".git"), { recursive: true });
const worktree = (main: string, dir: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".git"), `gitdir: ${join(main, ".git", "worktrees", basename(dir))}\n`);
};

/** The folders every case names. */
function tree() {
  const root = scratchRoot("cost-fold-");
  dirs.push(root);
  const code = join(root, "code");
  const proj = join(code, "proj");
  const old = join(code, "old");
  const tool = join(code, "tool");
  const agent = join(root, "agent");
  const p = {
    root,
    proj,
    projSub: join(proj, "src", "deep"),
    projWorktree: join(code, ".worktrees", "proj-feat-x"),
    projWorktreeSub: join(code, ".worktrees", "proj-feat-x", "pkg"),
    projGoneWorktree: join(code, ".worktrees", "proj-gone-1"),
    projHusk: join(code, ".worktrees", "proj-husk-2", "tmp"),
    old,
    oldSub: join(old, "lib"),
    tool,
    toolSub: join(tool, "src"),
    toolWorktree: join(code, ".worktrees", "tool-wt1"),
    toolGoneWorktree: join(code, ".worktrees", "tool-old-9"),
    toolHusk: join(code, ".worktrees", "tool-husk-3"),
    toolGoneSub: join(tool, "deleted", "later"),
    scratch: join(root, "scratch", "a"),
    tempRepo: join(root, "tmp", "r"),
    goneNowhere: join(root, "nowhere", "x"),
    overseer: join(agent, "sova", "overseer"),
    workspace: join(agent, "sova", "workspaces", "acme"),
    orgElsewhere: join(root, "orgs", "beta"),
    placeholder: join(agent, "targets", "h1"),
  };
  for (const d of [p.projHusk, p.toolHusk, p.projSub, p.oldSub, p.toolSub, p.scratch, p.overseer, p.workspace, p.orgElsewhere, p.placeholder]) mkdirSync(d, { recursive: true });
  repo(proj);
  repo(old);
  repo(tool);
  repo(p.tempRepo);
  worktree(proj, p.projWorktree);
  mkdirSync(p.projWorktreeSub, { recursive: true });
  worktree(tool, p.toolWorktree);
  const input: FoldInput = {
    projects: [
      { id: "prj_live0001", name: "Live Project", root: proj },
      { id: "prj_arch0001", name: "Old Project", root: old, archived: true },
    ],
    overseer: [join(agent, "sova", "overseer"), join(agent, "sova", "workspaces"), p.orgElsewhere],
    exclude: agent,
    temp: [join(root, "tmp")],
  };
  return { p, input };
}

test("each folder falls in its group's row, and two groups never share one", () => {
  const { p, input } = tree();
  const fold = projectFold(input);
  const key = (cwd: string | null, kind = "main") => fold(cwd, kind, null).key;
  const groups: Record<string, (string | null)[]> = {
    live: [p.proj, p.projSub, p.projWorktree, p.projWorktreeSub, p.projGoneWorktree, p.projHusk],
    archived: [p.old, p.oldSub],
    tool: [p.tool, p.toolSub, p.toolWorktree, p.toolGoneWorktree, p.toolGoneSub, p.toolHusk],
    overseer: [p.overseer, p.workspace, p.orgElsewhere],
    other: [p.scratch, p.tempRepo, p.goneNowhere, p.placeholder, null, "relative/path"],
  };
  const keys = Object.fromEntries(Object.entries(groups).map(([g, cwds]) => [g, new Set(cwds.map((c) => key(c)))]));
  for (const [g, set] of Object.entries(keys)) assert.equal(set.size, 1, `${g}: ${[...set].join(", ")}`);
  const all = new Set(Object.values(keys).map((s) => [...s][0]));
  assert.equal(all.size, Object.keys(groups).length, "two groups share a row");

  assert.equal(fold(p.projSub, "main", null).name, input.projects[0]!.name);
  assert.equal(fold(p.projWorktree, "main", null).project, input.projects[0]!.id);
  assert.equal(fold(p.oldSub, "main", null).archived, true);
  assert.equal(fold(p.projSub, "main", null).archived, undefined);
  assert.equal(fold(p.toolWorktree, "main", null).kind, "folder");
  assert.equal(fold(p.toolGoneWorktree, "main", null).path, p.tool);
  assert.equal(fold(p.toolWorktree, "main", null).name, basename(p.tool));
  assert.equal(fold(p.workspace, "main", null).kind, "overseer");
  assert.equal(fold(null, "main", null).kind, "other");
  // An overseer call: the Overseer's unless it ran in a project (a project overseer runs in its root).
  assert.equal(key(null, "overseer"), key(p.overseer));
  assert.equal(key(p.scratch, "overseer"), key(p.overseer));
  assert.equal(key(p.toolSub, "overseer"), key(p.overseer));
  assert.equal(key(p.proj, "overseer"), key(p.proj));
  // A recorded project id wins, an unknown one keeps its own row.
  assert.equal(fold(p.scratch, "main", input.projects[0]!.id).key, key(p.proj));
  assert.notEqual(fold(null, "main", "prj_unknown1").key, key(null));
});

test("a husk worktree (its .git removed, the folder left) is its project's here, never in the sidebar's rule", () => {
  const { p, input } = tree();
  assert.equal(folderMatcher(input.projects, input.exclude)(p.projHusk), null);
  assert.equal(folderMatcher(input.projects, input.exclude, { husks: true })(p.projHusk), input.projects[0]!.id);
  assert.equal(folderMatcher(input.projects, input.exclude)(p.projGoneWorktree), input.projects[0]!.id);
});

test("without the archived project, its folders are an unregistered checkout's", () => {
  const { p, input } = tree();
  const fold = projectFold({ ...input, projects: input.projects.filter((x) => !x.archived) });
  assert.equal(fold(p.oldSub, "main", null).kind, "folder");
  assert.equal(fold(p.oldSub, "main", null).path, p.old);
});

test("the server's input is guarded and the fold is kept across polls", () => {
  assert.equal(foldInputOf(null), null);
  const g = foldInputOf({ projects: [{ id: "prj_a", root: "rel" }, { id: "prj_b", root: "/x", name: "" }, 3], overseer: ["/o", "rel", 4], exclude: "rel" })!;
  assert.deepEqual(g.projects, [{ id: "prj_b", name: "prj_b", root: "/x" }]);
  assert.deepEqual(g.overseer, ["/o"]);
  assert.equal(g.exclude, undefined);
  const clock = { now: 0 };
  const cache = foldCache(() => clock.now);
  const a = cache(g);
  assert.equal(cache({ ...g }), a);
  assert.notEqual(cache({ ...g, overseer: [] }), a);
  const b = cache(g);
  clock.now += 10 * 60_000;
  assert.notEqual(cache(g), b);
});

test("the By project rows add up to the Total, Other folders last, the other tables untouched", async () => {
  const { p, input } = tree();
  const usageRoot = join(p.root, "agent", "usage", "v1");
  const stateDir = join(p.root, "agent", "sova", "usage-ledger");
  const pricesPath = join(p.root, "agent", "sova", "model-prices.json");
  const now = Date.parse("2026-10-04T12:00:00.000Z");
  const day = "2026-10-04";
  mkdirSync(join(usageRoot, day), { recursive: true });
  let n = 0;
  // Spend that makes Other folders the costliest row: it still sorts last.
  const write = (cwd: string | null, kind: UsageRecord["kind"] = "main", input = 1000) => {
    n++;
    const rec: UsageRecord = {
      v: 1, key: `k${n}`, ts: now - n * 60_000, device: null, producer: "p1", src: "pi", provider: "zai", model: "glm-5.3",
      input, output: 10, cacheRead: 0, cacheWrite: 0, owner: `s${n}`, parent: null, kind, ...(cwd ? { cwd } : {}),
    };
    appendFileSync(join(usageRoot, day, "p1.jsonl"), formatUsageRecord(rec)!);
  };
  const cwds = [p.proj, p.projSub, p.projWorktree, p.projGoneWorktree, p.oldSub, p.tool, p.toolWorktree, p.toolGoneWorktree, p.overseer, p.workspace];
  for (const c of cwds) write(c);
  write(p.proj, "overseer");
  write(null, "overseer");
  write(null, "oneshot", 900_000);
  for (const c of [p.scratch, p.tempRepo, p.goneNowhere, p.placeholder]) write(c, "main", 900_000);
  const aliases = JSON.parse(readFileSync(ALIASES_FILE, "utf8")) as Aliases;
  const prices = mergeFetched(EMPTY_TABLE, normalizeModelsDev({ anthropic: { models: {} }, openai: { models: {} }, zai: { models: { "glm-5.3": { cost: { input: 1, output: 4 } } } }, deepseek: { models: {} }, "ollama-cloud": { models: {} } }, aliases), "2026-09-01T00:00:00.000Z").table;
  writeFileSync(pricesPath, JSON.stringify(prices));
  const s = createService({ usageRoot, stateDir, pricesPath, now: () => now, log: () => {}, prices: { enabled: false } });
  s.ledger.scanAll();
  s.ledger.indexAll();
  const ask = async (fold?: FoldInput) => (await s.answer({ op: "costs", range: "7d", tz: "UTC", ...(fold ? { fold } : {}) })) as UsageCosts;
  const c = await ask(input);
  const plain = await ask();

  const sum = (f: (r: UsageCosts["byProject"][number]) => number) => c.byProject.reduce((a, r) => a + f(r), 0);
  assert.equal(sum((r) => r.calls), c.total.calls);
  assert.equal(sum((r) => r.tokens.input + r.tokens.output), c.total.tokens.input + c.total.tokens.output);
  assert.ok(Math.abs(sum((r) => r.usd) - c.total.usd) < 1e-9);
  assert.ok(c.total.usd > 0);

  const kinds = c.byProject.map((r) => r.kind);
  assert.equal(kinds.at(-1), "other");
  assert.equal(kinds.filter((k) => k === "other").length, 1);
  assert.equal(kinds.filter((k) => k === "overseer").length, 1);
  assert.equal(new Set(c.byProject.map((r) => r.name)).size, c.byProject.length, "two rows share a name");
  assert.equal(c.byProject.length, 5);
  const other = c.byProject.at(-1)!;
  assert.ok(other.usd > Math.max(...c.byProject.slice(0, -1).map((r) => r.usd)), "Other folders is the costliest here");
  assert.equal(other.folders, 4);
  const live = c.byProject.find((r) => r.project === input.projects[0]!.id)!;
  assert.equal(live.folders, 4);
  assert.equal(live.calls, 5, "its folders and its overseer's conversation");
  assert.equal(live.path, p.proj);
  assert.equal(c.byProject.find((r) => r.project === input.projects[1]!.id)?.archived, true);
  const toolRow = c.byProject.find((r) => r.kind === "folder")!;
  assert.equal(toolRow.cwd, p.tool);
  assert.equal(toolRow.calls, 3);

  // Every other figure is the same with or without the fold.
  const { byProject: _a, asOf: _x, ...rest } = c;
  const { byProject: _b, asOf: _y, ...restPlain } = plain;
  assert.deepEqual(rest, restPlain);
  // Without a fold no project is registered: the projects' folders are checkouts.
  assert.equal(plain.byProject.filter((r) => r.kind === "project").length, 0);
  assert.equal(plain.byProject.reduce((a, r) => a + r.calls, 0), plain.total.calls);
});
