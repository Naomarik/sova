import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { recordGoAhead } from "../../pi-config/extensions/worktrees/landing.ts";
import { join } from "node:path";
import { describe, test } from "node:test";
import { definitionAt } from "../project-services/deploy-recipe";
import type { Caller } from "../project-services/engine";
import { checksOf } from "./checks";
import { type Git, realGit } from "./guard";
import { SETUP_UNREADABLE } from "./setup-branch";
import { type IngestDeps, ingestOnce } from "./ingest";
import { merger } from "./routes";
import { ServedRule } from "./served";
import type { RunInput } from "./contract";
import { makeKit, makeRepo, type Repo, sh, until } from "./testing/queue-kit";

/**
 * The setup chat's trust rules (al_1): merge.setup (which saves the merge section on the target, or with dryRun runs the
 * checks there) stays the operator's own press; no chat reaches it, whatever its dryRun says, so a chat that leaves the
 * flag off can never save to main. A chat's own scripts calling the operator's route (`fromChat`) are a chat too.
 */

const op: Caller = { kind: "operator" };

function callerOf(root: string): { name: string; caller: Caller }[] {
  return [
    { name: "a chat of the project", caller: { kind: "session", id: "s-setup", root, own: [] } },
    { name: "the merge thread", caller: { kind: "session", id: "s-thread", root, own: [] } },
    { name: "the Project Overseer", caller: { kind: "project-overseer", id: "po1", root, act: {} as never } },
    { name: "the Project Assistant", caller: { kind: "assistant", id: "pa1", root } },
    { name: "a chat's script on the operator's route", caller: { kind: "operator", fromChat: true } },
  ];
}

describe("merge.setup is the operator's alone (any dryRun)", () => {
  for (const served of [false, true]) {
    test(`${served ? "a served project" : "a listed project with no setup"}: every chat-side caller is refused for dryRun absent, false and true; the target never moves and no try starts`, async () => {
      const k = makeKit({ checks: served ? "declared" : "unset" });
      try {
        const rule = new ServedRule({ listed: () => [{ root: k.repo.root, id: "prj_t" }], definitionAt: (r, ref) => definitionAt(r, ref), checksOf, ttlMs: 0 });
        const call = merger({
          queues: k.queues,
          served: { isListed: (r) => rule.isListed(r), served: async () => served, bareView: (r) => rule.bareView(r) },
          rootOf: async () => k.repo.root,
          isThreadChat: (_r, sid) => sid === "s-thread",
        });
        const before = k.repo.head();
        for (const { name, caller } of callerOf(k.repo.root)) {
          for (const dry of [undefined, false, true]) {
            const body = { project: k.repo.root, command: "true", ...(dry === undefined ? {} : { dryRun: dry }) };
            const r = await call("merge.setup", body, caller);
            assert.equal(r.ok, false, `${name}, dryRun ${dry}: refused`);
            assert.equal(r.error?.code, "forbidden", `${name}, dryRun ${dry}: ${JSON.stringify(r.error)}`);
            assert.equal(k.repo.head(), before, `${name}, dryRun ${dry}: the target didn't move`);
          }
        }
        assert.equal(k.run.inputs.length, 0, "no check ran for any of them");
        assert.equal(sh(k.repo.root, "log", "--oneline").split("\n").length, 1, "no setup commit");
        // The same call from the operator's own page reaches the setup (the refusal above is the caller's, not the body's).
        const mine = await call("merge.setup", { project: k.repo.root, command: "true", dryRun: true }, op);
        assert.equal(mine.ok, true, JSON.stringify(mine.error));
      } finally {
        await k.done();
      }
    });
  }
});

// ---- merge.try: a trial of a setup branch's head ----------------------------------------------------------------

type Hold = { release(): void; started: Promise<void> };
/** A stand-in run held open until released: its input is recorded when it starts. */
function holdRun(k: ReturnType<typeof makeKit>, when: (input: RunInput) => boolean = () => true): Hold {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const began = new Promise<void>((r) => (started = r));
  k.run.set(async (input) => {
    if (!when(input)) return {};
    started();
    await Promise.race([gate, new Promise<void>((r) => input.signal.addEventListener("abort", () => r()))]);
    return {};
  });
  return { release, started: began };
}

const CHECK = (id: string, run = "true") => ({ id, label: id, run: ["sh", "-c", run] });
const SERVICES = { db: { cmd: ["db-server"], ports: { pg: { base: 31000 } }, start: "on-demand" }, cache: { cmd: ["cache-server"], ports: { tcp: { base: 32000 } }, start: "on-demand" } };
const TARGET_DEF = { version: 1, services: SERVICES, merge: { checks: [{ ...CHECK("unit"), requires: ["db"] }] }, release: { playbook: ".sova/playbooks/release", checks: [CHECK("e2e"), CHECK("smoke")] } };

/** A kit whose target declares TARGET_DEF, read from Git (never a fixed stand-in definition). */
function realKit(git?: Git) {
  const repo = makeRepo({ prefix: "mq-setup-" });
  mkdirSync(join(repo.root, ".sova"), { recursive: true });
  writeFileSync(join(repo.root, ".sova", "project.json"), `${JSON.stringify(TARGET_DEF, null, 2)}\n`);
  sh(repo.root, "add", ".sova/project.json");
  sh(repo.root, "commit", "-q", "-m", "declare");
  sh(repo.root, "push", "-q", "origin", repo.target);
  const k = makeKit({ repo, deps: { definitionAt: (r, ref) => definitionAt(r, ref), checksOf, ...(git ? { git } : {}) } });
  const call = merger({
    queues: k.queues,
    served: { isListed: () => true, served: async () => true, bareView: async () => { throw new Error("served"); } },
    rootOf: async () => repo.root,
    isThreadChat: (_r, sid) => sid === "s-thread",
  });
  return { k, repo, call, done: async () => { await k.done(); repo.done(); } };
}

/** A branch whose .sova/project.json is TARGET_DEF changed by `edit`. */
function setupBranch(repo: Repo, name: string, edit: (d: Record<string, any>) => void, extra: Record<string, string> = {}) {
  const d = structuredClone(TARGET_DEF) as Record<string, any>;
  edit(d);
  return repo.branch(name, { ".sova/project.json": `${JSON.stringify(d, null, 2)}\n`, ...extra });
}

const chatOf = (root: string, id = "s-setup"): Caller => ({ kind: "session", id, root, own: [] });

describe("merge.try: who may run a trial", () => {
  test("any chat on its own project may (the setup chat or not), and the operator; an Overseer, the Assistant and a chat of another project are refused", async () => {
    const t = realKit();
    try {
      const b = setupBranch(t.repo, "setup/a", (d) => d.merge.checks.push(CHECK("lint")));
      const ok: { name: string; caller: Caller }[] = [
        { name: "the setup chat", caller: chatOf(t.repo.root) },
        { name: "another chat of the project", caller: chatOf(t.repo.root, "s-other") },
        { name: "a chat's script on the operator's route", caller: { kind: "operator", fromChat: true } },
        { name: "the operator", caller: op },
      ];
      for (const { name, caller } of ok) {
        const r = await t.call("merge.try", { project: t.repo.root, branch: "setup/a" }, caller);
        assert.equal(r.ok, true, `${name}: ${JSON.stringify(r.error)}`);
        assert.equal(r.merge?.trial?.commit, b.head);
        await (await t.k.q()).tryingNow();
      }
      const no: { name: string; caller: Caller }[] = [
        { name: "the Project Overseer", caller: { kind: "project-overseer", id: "po1", root: t.repo.root, act: {} as never } },
        { name: "the Project Assistant", caller: { kind: "assistant", id: "pa1", root: t.repo.root } },
        { name: "a chat of another project", caller: chatOf("/elsewhere/proj") },
      ];
      for (const { name, caller } of no) {
        const r = await t.call("merge.try", { project: t.repo.root, branch: "setup/a" }, caller);
        assert.equal(r.ok, false, name);
        assert.equal(r.error?.code, "forbidden", `${name}: ${JSON.stringify(r.error)}`);
      }
      assert.equal(t.k.run.inputs.length, ok.length, "a refused caller started no run");
    } finally {
      await t.done();
    }
  });
});

describe("merge.try: what a trial runs, and that it saves nothing", () => {
  test("it runs the branch head with that commit's own merge checks and its new or changed release checks; target, branch and queue stay as they were", async () => {
    const t = realKit();
    try {
      const b = setupBranch(t.repo, "setup/b", (d) => {
        d.merge.checks.push(CHECK("lint", "echo lint"));
        d.release.checks[1] = CHECK("smoke", "echo changed");
        d.release.checks.push(CHECK("perf"));
      });
      const target = t.repo.head();
      const r = await t.call("merge.try", { project: t.repo.root, branch: "setup/b" }, chatOf(t.repo.root));
      assert.equal(r.ok, true, JSON.stringify(r.error));
      const q = await t.k.q();
      await q.tryingNow();
      const input = t.k.run.inputs.at(-1)!;
      assert.equal(input.commit, b.head, "the branch head, not the target");
      assert.equal(input.base, b.head, "nothing is merged onto the target");
      assert.equal(input.tryOnly, true);
      const mergeIds = (input.project.def?.merge?.checks as { id: string }[]).map((c) => c.id);
      assert.deepEqual(mergeIds, ["unit", "lint"], "the branch's own merge checks (the target declares only unit)");
      assert.deepEqual((input.releaseChecks ?? []).map((c) => c.id).sort(), ["perf", "smoke"], "new and changed release checks run");
      const trial = q.trials()[0]!;
      assert.equal(trial.verdict, "passed");
      assert.deepEqual(trial.notRun?.map((c) => c.id), ["e2e"], "the unchanged release check is reported not run");
      assert.deepEqual(trial.by, { kind: "chat", session: "s-setup" });
      // Nothing saved: the target and the branch didn't move, no entry, no landing.
      assert.equal(t.repo.head(), target);
      assert.equal(t.repo.head("setup/b"), b.head);
      assert.equal(sh(t.repo.root, "rev-parse", `origin/${t.repo.target}`), target, "nothing pushed");
      const v = await q.view();
      assert.deepEqual([...v.checking, ...v.waiting, ...v.needsYou, ...v.needsFix, ...(v.waitingOnHost ?? [])], [], "a trial is no queue entry");
      assert.deepEqual(v.recent, [], "and lands nothing");
    } finally {
      await t.done();
    }
  });

  test("an unchanged release check doesn't run unless named; a named one does", async () => {
    const t = realKit();
    try {
      setupBranch(t.repo, "setup/c", (d) => d.merge.checks.push(CHECK("lint")));
      await t.call("merge.try", { project: t.repo.root, branch: "setup/c" }, chatOf(t.repo.root));
      await (await t.k.q()).tryingNow();
      assert.deepEqual((t.k.run.inputs.at(-1)!.releaseChecks ?? []).map((c) => c.id), [], "no release check changed: none runs");
      const named = await t.call("merge.try", { project: t.repo.root, branch: "setup/c", checks: ["smoke"] }, chatOf(t.repo.root));
      assert.equal(named.ok, true, JSON.stringify(named.error));
      await (await t.k.q()).tryingNow();
      assert.deepEqual((t.k.run.inputs.at(-1)!.releaseChecks ?? []).map((c) => c.id), ["smoke"]);
      assert.deepEqual(named.merge?.trial?.notRun?.map((c) => c.id), ["e2e"]);
    } finally {
      await t.done();
    }
  });
});

describe("Land on a setup branch waits for a passing trial of its exact head", () => {
  test("refused with no trial, while running, after a failing one; taken once a trial of that commit passed; a new commit needs a new trial", async () => {
    const t = realKit();
    try {
      const b = setupBranch(t.repo, "setup/d", (d) => d.merge.checks.push(CHECK("lint")));
      const land = () => t.call("merge.add", { project: t.repo.root, branch: "setup/d" }, op);
      let r = await land();
      assert.equal(r.ok, false, "no trial");
      assert.match(r.error?.message ?? "", /no passing trial/);
      // A running trial isn't a pass.
      const h = holdRun(t.k);
      await t.call("merge.try", { project: t.repo.root, branch: "setup/d" }, chatOf(t.repo.root));
      await h.started;
      r = await land();
      assert.equal(r.ok, false, "trial running");
      h.release();
      await (await t.k.q()).tryingNow();
      // A failing trial isn't a pass.
      t.k.run.set(() => ({ verdict: "failed", why: "lint failed" }));
      await t.call("merge.try", { project: t.repo.root, branch: "setup/d" }, chatOf(t.repo.root));
      await (await t.k.q()).tryingNow();
      r = await land();
      assert.equal(r.ok, false, "trial failed");
      assert.match(r.error?.message ?? "", /did not pass/);
      // A passing trial of an OLDER commit doesn't count for the new head.
      t.k.run.set(null);
      await t.call("merge.try", { project: t.repo.root, branch: "setup/d" }, chatOf(t.repo.root));
      await (await t.k.q()).tryingNow();
      const newer = t.repo.commitOn(b.path, { "note.txt": "more\n" });
      r = await land();
      assert.equal(r.ok, false, `a pass at ${b.head.slice(0, 7)} doesn't cover ${newer.slice(0, 7)}`);
      // A pass of the exact head: taken.
      await t.call("merge.try", { project: t.repo.root, branch: "setup/d" }, chatOf(t.repo.root));
      await (await t.k.q()).tryingNow();
      r = await land();
      assert.equal(r.ok, true, JSON.stringify(r.error));
    } finally {
      await t.done();
    }
  });

  test("the gate is the change, not the chat: any branch changing merge, release or deploy, or the release playbook, is gated; one that doesn't lands with no trial", async () => {
    const t = realKit();
    try {
      const gated: [string, (d: Record<string, any>) => void, Record<string, string>?][] = [
        ["feat/merge", (d) => d.merge.checks.push(CHECK("lint"))],
        ["feat/release", (d) => (d.release.quietMin = 7)],
        ["feat/deploy", (d) => (d.deploy = { targets: { staging: { about: "s", requires: { tests: "none" }, steps: [{ id: "push", run: ["./push"] }], rollback: { none: "rebuilt nightly" } } } })],
        ["feat/playbook", () => {}, { ".sova/playbooks/release/PLAYBOOK.md": "# steps\n" }],
      ];
      for (const [name, edit, extra] of gated) {
        setupBranch(t.repo, name, edit, extra);
        const r = await t.call("merge.add", { project: t.repo.root, branch: name }, op);
        assert.equal(r.ok, false, `${name}: gated`);
        assert.match(r.error?.message ?? "", /trial/, `${name}: ${JSON.stringify(r.error)}`);
      }
      // Another key of the definition (not a pipeline section) and plain code: no trial needed.
      setupBranch(t.repo, "feat/plain", (d) => (d.sources = ["src.txt"]), { "src.txt": "code\n" });
      const plain = await t.call("merge.add", { project: t.repo.root, branch: "feat/plain" }, op);
      assert.equal(plain.ok, true, JSON.stringify(plain.error));
    } finally {
      await t.done();
    }
  });

  test("a setup branch with nothing left is refused as nothing to land, and never told to run a trial", async () => {
    const t = realKit();
    try {
      setupBranch(t.repo, "setup/on", (d) => d.merge.checks.push(CHECK("lint")));
      const land = () => t.call("merge.add", { project: t.repo.root, branch: "setup/on" }, op);
      assert.match((await land()).error?.message ?? "", /no passing trial/, "with work left, the trial gate speaks");
      sh(t.repo.root, "merge", "-q", "--no-ff", "--no-edit", "setup/on");
      const r = await land();
      assert.equal(r.ok, false);
      assert.match(r.error?.message ?? "", new RegExp(`Nothing to land: everything on this branch is already on ${t.repo.target}\\.$`));
    } finally {
      await t.done();
    }
  });

  test("the gate is the change, not the chat: a target naming its own release playbook folder (ops/release) gates a branch that edits only that folder", async () => {
    const t = realKit();
    try {
      const d = structuredClone(TARGET_DEF) as Record<string, any>;
      d.release.playbook = "ops/release";
      t.repo.commitOn(t.repo.root, { ".sova/project.json": `${JSON.stringify(d, null, 2)}\n`, "ops/release/PLAYBOOK.md": "# steps\n" }, "release playbook in ops/release");
      sh(t.repo.root, "push", "-q", "origin", t.repo.target);
      const b = t.repo.branch("feat/ops-playbook", { "ops/release/PLAYBOOK.md": "# steps, changed\n" });
      const q = await t.k.q();
      assert.match((await q.setupUntried(t.repo.head(), b.head)) ?? "", /no passing trial/, "a setup branch: untried");
      const r = await t.call("merge.add", { project: t.repo.root, branch: "feat/ops-playbook" }, op);
      assert.equal(r.ok, false, "gated");
      assert.match(r.error?.message ?? "", /no passing trial/);
      // A file beside that folder is plain code: no trial needed.
      const plain = t.repo.branch("feat/ops-other", { "ops/notes.md": "n\n" });
      assert.equal(await q.setupUntried(t.repo.head(), plain.head), null);
    } finally {
      await t.done();
    }
  });

  test("services: a branch changing a service a merge check requires is gated; changing one no check requires lands with no trial", async () => {
    const t = realKit();
    try {
      const gated: [string, (d: Record<string, any>) => void][] = [
        ["svc/edit-required", (d) => (d.services.db.cmd = ["db-server", "--fsync=off"])],
      ];
      for (const [name, edit] of gated) {
        setupBranch(t.repo, name, edit);
        const r = await t.call("merge.add", { project: t.repo.root, branch: name }, op);
        assert.equal(r.ok, false, `${name}: gated`);
        assert.match(r.error?.message ?? "", /trial/, `${name}: ${JSON.stringify(r.error)}`);
      }
      // A service no merge check requires (on either side): edited or added, it lands with no trial.
      for (const [name, edit] of [
        ["svc/edit-unrequired", (d: Record<string, any>) => (d.services.cache.cmd = ["cache-server", "--big"])],
        ["svc/add-unrequired", (d: Record<string, any>) => (d.services.search = { cmd: ["search"], ports: { http: { base: 33000 } }, start: "on-demand" })],
      ] as const) {
        setupBranch(t.repo, name, edit);
        const r = await t.call("merge.add", { project: t.repo.root, branch: name }, op);
        assert.equal(r.ok, true, `${name}: ${JSON.stringify(r.error)}`);
      }
    } finally {
      await t.done();
    }
  });
});

describe("the user's typed \"land it\" on a setup branch (worktree land, served)", () => {
  test("its go-ahead is refused to the chat with the land gate's words and queues nothing; after a passing trial of that head it queues", async () => {
    const t = realKit();
    const dir = mkdtempSync(join(tmpdir(), "mq-setup-typed-"));
    try {
      const b = setupBranch(t.repo, "sova/setup-x", (d) => d.merge.checks.push(CHECK("lint")));
      const refused: { session: string; text: string }[] = [];
      const deps: IngestDeps = {
        file: join(dir, "landing.json"),
        seenFile: join(dir, "seen.json"),
        roots: () => [t.repo.root],
        served: async () => true,
        repoOf: async () => t.repo.root,
        queue: (root) => t.k.queues.get(root),
        refused: (session, text) => void refused.push({ session, text }),
      };
      assert.deepEqual(await ingestOnce(deps), [], "the first read is a baseline");
      recordGoAhead({ branch: "sova/setup-x", commit: b.head, session: "s-setup", at: "2026-11-05T10:00:00Z", by: "owner-chat" }, deps.file);
      const did = await ingestOnce(deps);
      assert.match(did[0] ?? "", /refused: This setup branch has no passing trial/);
      assert.deepEqual(refused, [{ session: "s-setup", text: `sova/setup-x at ${b.head.slice(0, 7)} couldn't be queued to land: This setup branch has no passing trial at ${b.head.slice(0, 7)}: run a trial of it first.` }]);
      const q = await t.k.q();
      assert.equal(q.entries().length, 0, "nothing queued");
      // A passing trial of that exact head: the same word, typed again, queues it.
      await t.call("merge.try", { project: t.repo.root, branch: "sova/setup-x" }, chatOf(t.repo.root));
      await q.tryingNow();
      recordGoAhead({ branch: "sova/setup-x", commit: b.head, session: "s-setup", at: "2026-11-05T10:00:01Z", by: "owner-chat" }, deps.file);
      const did2 = await ingestOnce(deps);
      assert.match(did2[0] ?? "", /^queued sova\/setup-x/);
      assert.equal(q.entries().find((e) => e.branch === "sova/setup-x")?.approval.commit, b.head, "pinned to the tried head");
      assert.equal(refused.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await t.done();
    }
  });
});

describe("the merge copy is held by one thing at a time", () => {
  test("a trial is refused (busy) while a landing holds the copy, and saves no trial record", async () => {
    const t = realKit();
    try {
      t.repo.branch("feat/x", { "x.txt": "x\n" });
      setupBranch(t.repo, "setup/e", (d) => d.merge.checks.push(CHECK("lint")));
      const h = holdRun(t.k);
      const add = await t.call("merge.add", { project: t.repo.root, branch: "feat/x" }, op);
      assert.equal(add.ok, true, JSON.stringify(add.error));
      await h.started;
      const r = await t.call("merge.try", { project: t.repo.root, branch: "setup/e" }, chatOf(t.repo.root));
      assert.equal(r.ok, false);
      assert.equal(r.error?.code, "busy", JSON.stringify(r.error));
      assert.equal((await t.k.q()).trials().length, 0);
      h.release();
    } finally {
      await t.done();
    }
  });

  test("a landing that comes due during a trial waits for the trial to end, then runs", async () => {
    const t = realKit();
    try {
      setupBranch(t.repo, "setup/f", (d) => d.merge.checks.push(CHECK("lint")));
      t.repo.branch("feat/y", { "y.txt": "y\n" });
      const h = holdRun(t.k, (i) => i.tryOnly === true);
      await t.call("merge.try", { project: t.repo.root, branch: "setup/f" }, chatOf(t.repo.root));
      await h.started;
      const add = await t.call("merge.add", { project: t.repo.root, branch: "feat/y" }, op);
      assert.equal(add.ok, true, JSON.stringify(add.error));
      // The queue kicks within its watch interval (25 ms here): 300 ms is a dozen chances to start the landing early.
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(t.k.run.inputs.length, 1, "only the trial has run");
      h.release();
      await until(() => t.k.run.inputs.length === 2, "the landing to start after the trial");
      assert.equal(t.k.run.inputs[1]!.tryOnly, undefined, "the second run is the landing");
    } finally {
      await t.done();
    }
  });
});

describe("the gate fails closed when Git can't read a definition", () => {
  test("a branch whose definitions Git can't read waits with SETUP_UNREADABLE, even plain code; readable again, it lands", async () => {
    let broken = false;
    const git: Git = (args, cwd, opts) => (broken && args[0] === "ls-tree" ? Promise.resolve({ code: 128, stdout: "", stderr: "boom" }) : realGit(args, cwd, opts));
    const t = realKit(git);
    try {
      const b = t.repo.branch("feat/code", { "src.txt": "code\n" });
      const q = await t.k.q();
      broken = true;
      assert.equal(await q.setupUntried(t.repo.head(), b.head), SETUP_UNREADABLE);
      const r = await t.call("merge.add", { project: t.repo.root, branch: "feat/code" }, op);
      assert.equal(r.ok, false, "refused while Git can't tell");
      broken = false;
      assert.equal(await q.setupUntried(t.repo.head(), b.head), null);
    } finally {
      await t.done();
    }
  });
});

describe("the gate fails closed when no queue can say", () => {
  test("with no queue running: a setup branch can't be confirmed (refused), a plain branch needs no trial, and an empty head or root is refused", async () => {
    const { setupUntriedAt, TRIAL_UNREADABLE } = await import("./wire");
    const repo = makeRepo({ prefix: "mq-setup-closed-" });
    try {
      mkdirSync(join(repo.root, ".sova"), { recursive: true });
      writeFileSync(join(repo.root, ".sova", "project.json"), `${JSON.stringify(TARGET_DEF, null, 2)}\n`);
      sh(repo.root, "add", ".sova/project.json");
      sh(repo.root, "commit", "-q", "-m", "declare");
      const setup = setupBranch(repo, "setup/closed", (d) => d.merge.checks.push(CHECK("lint")));
      const plain = repo.branch("feat/plain-closed", { "src.txt": "x\n" });
      assert.equal(await setupUntriedAt(repo.root, setup.head), TRIAL_UNREADABLE);
      assert.equal(await setupUntriedAt(repo.root, plain.head), null);
      assert.equal(await setupUntriedAt(repo.root, ""), TRIAL_UNREADABLE);
      assert.equal(await setupUntriedAt("", setup.head), TRIAL_UNREADABLE);
    } finally {
      repo.done();
    }
  });
});
