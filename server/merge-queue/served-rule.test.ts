import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { readServed, servedRoot } from "../../pi-config/extensions/worktrees/served.ts";
import { definitionAt } from "../project-services/deploy-recipe";
import type { Caller } from "../project-services/engine";
import { checksOf } from "./checks";
import { merger } from "./routes";
import { LandingNotes, NOT_SERVED, ServedRule, servedKey, servedLine, startServedWriter, unservedLine, writeServedFile } from "./served";
import { projectKey } from "./store";
import { makeKit, makeRepo, type Repo, sh } from "./testing/queue-kit";

const op: Caller = { kind: "operator" };

/** Commit a .sova/project.json on the repo's target. */
function declare(repo: Repo, text: string): void {
  const dir = join(repo.root, ".sova");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "project.json"), text);
  sh(repo.root, "add", ".sova/project.json");
  sh(repo.root, "commit", "-q", "-m", "declare");
}

const ruleOver = (listed: string[], ttlMs = 0) => new ServedRule({ listed: () => listed.map((root) => ({ root })), definitionAt: (r, ref) => definitionAt(r, ref), checksOf, ttlMs });

describe("the served rule: on the Projects list AND merge setup done", () => {
  test("listed and set up: served, with its target; listed with no setup: not served; set up but unlisted: not served; a definition that doesn't parse counts as set up", async () => {
    const set = makeRepo({ prefix: "mq-served-" });
    const bare = makeRepo({ prefix: "mq-served-" });
    const loose = makeRepo({ prefix: "mq-served-", target: "main" });
    const broken = makeRepo({ prefix: "mq-served-" });
    try {
      declare(set, JSON.stringify({ version: 1, merge: { checks: "none" } }));
      declare(loose, JSON.stringify({ version: 1, merge: { checks: "none" } }));
      declare(broken, "{ not json");
      const rule = ruleOver([set.root, `${bare.root}/`, broken.root]);
      assert.equal(await rule.servedTarget(set.root), "master");
      assert.equal(await rule.served(set.root), true);
      assert.equal(await rule.served(bare.root), false, "listed, no merge setup: plain merges");
      assert.equal((await rule.setupOf(bare.root)).checks, "unset");
      assert.equal(rule.isListed(bare.root), true, "a trailing slash compares equal");
      assert.equal(await rule.served(loose.root), false, "its own settings file can't switch the queue on");
      assert.equal(rule.isListed(loose.root), false);
      assert.equal(await rule.served(broken.root), true, "a broken setup is said, never bypassed");
      assert.ok((await rule.setupOf(broken.root)).invalid);
      assert.deepEqual(await rule.servedRoots(), [servedKey(broken.root), servedKey(set.root)].sort().map((root) => ({ root, target: "master" })));
      // Asking never makes a queue's records.
      for (const r of [set, bare, loose, broken]) assert.equal(existsSync(join(r.state, "merge-queue")), false);
    } finally {
      for (const r of [set, bare, loose, broken]) r.done();
    }
  });

  test("a test command alone is a setup; a failing list read serves nothing", async () => {
    const repo = makeRepo({ prefix: "mq-served-" });
    try {
      declare(repo, JSON.stringify({ version: 1, test: { run: ["true"], smoke: ["a.test.ts"] } }));
      const rule = ruleOver([repo.root]);
      const s = await rule.setupOf(repo.root);
      assert.equal(s.invalid, undefined, "the definition parses");
      assert.equal(s.checks, "test-command");
      assert.equal(await rule.served(repo.root), true);
      const failing = new ServedRule({ listed: () => { throw new Error("org host closed"); }, definitionAt: (r, ref) => definitionAt(r, ref), checksOf });
      assert.equal(await failing.served(repo.root), false);
    } finally {
      repo.done();
    }
  });
});

describe("merge-served.json: the answer chats read", () => {
  test("written atomically (0600) only when its roots change; the chat's reader reads it back", () => {
    const repo = makeRepo({ prefix: "mq-served-" });
    try {
      const file = join(repo.state, "merge-served.json");
      assert.equal(writeServedFile(file, [{ root: "/b", target: "main" }, { root: "/a", target: "master" }], () => 0), true);
      const data = readServed(file)!;
      assert.deepEqual(data.roots, [{ root: "/a", target: "master" }, { root: "/b", target: "main" }]);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(writeServedFile(file, [{ root: "/a", target: "master" }, { root: "/b", target: "main" }], () => 1), false, "same roots: not rewritten");
      assert.equal(readServed(file)!.at, new Date(0).toISOString());
      assert.equal(writeServedFile(file, [], () => 2), true);
      assert.deepEqual(readServed(file)!.roots, []);
      assert.deepEqual(readdirSync(repo.state).filter((f) => f.includes(".tmp")), [], "no temp file left");
    } finally {
      repo.done();
    }
  });

  test("the writer's first pass is the rule's answer, so a chat in a served repo reads served and any other repo reads null", async () => {
    const set = makeRepo({ prefix: "mq-served-" });
    const other = makeRepo({ prefix: "mq-served-" });
    try {
      declare(set, JSON.stringify({ version: 1, merge: { checks: "none" } }));
      const file = join(set.state, "merge-served.json");
      const seen: string[][] = [];
      const w = startServedWriter(ruleOver([set.root, other.root]), file, { everyMs: 60_000, onRoots: (roots) => seen.push(roots.map((r) => r.root)) });
      try {
        await w.first;
        assert.deepEqual(servedRoot(set.root, file), { root: servedKey(set.root), target: "master" });
        assert.equal(servedRoot(other.root, file), null);
        assert.deepEqual(seen, [[servedKey(set.root)]]);
        // The other repo is set up: a refresh says so.
        declare(other, JSON.stringify({ version: 1, merge: { checks: "none" } }));
        await w.refresh();
        assert.deepEqual(servedRoot(other.root, file), { root: servedKey(other.root), target: "master" });
      } finally {
        w.stop();
      }
    } finally {
      set.done();
      other.done();
    }
  });
});

describe("the merge verbs answer only for repos the queue serves", () => {
  test("off the Projects list: every verb, the operator's too, is refused with the one sentence; listed but not set up: status is answered bare (served: false) and setup reaches the setup; neither status nor a refusal writes a queue record", async () => {
    const k = makeKit({ checks: "unset" });
    try {
      const b = k.repo.branch("feat/a", { "b.txt": "b\n" });
      let listed = false;
      let setUp = false;
      const rule = new ServedRule({ listed: () => (listed ? [{ root: k.repo.root, id: "prj_side" }] : []), definitionAt: (r, ref) => definitionAt(r, ref), checksOf, ttlMs: 0 });
      const call = merger({
        queues: k.queues,
        served: { isListed: (r) => rule.isListed(r), served: async (r) => setUp || (await rule.served(r)), bareView: (r) => rule.bareView(r) },
        rootOf: async () => k.repo.root,
      });
      const base = join(k.repo.state, "merge-queue");
      for (const verb of ["merge.status", "merge.add", "merge.setup", "merge.pause"]) {
        const r = await call(verb, { project: k.repo.root, checkout: b.path }, op);
        assert.equal(r.ok, false, verb);
        assert.equal(r.error?.code, "unsupported", verb);
        assert.equal(r.error?.message, NOT_SERVED, verb);
      }
      const chat: Caller = { kind: "session", id: "s1", root: k.repo.root, own: [] };
      assert.equal((await call("merge.status", {}, chat)).error?.message, NOT_SERVED, "a chat's own project");
      assert.equal(existsSync(base), false, "no queue record is made for it");

      // Archived: off the list.
      const archived = new ServedRule({ listed: () => [{ root: k.repo.root, archived: { at: "2026-11-01T00:00:00Z" } }], definitionAt: (r, ref) => definitionAt(r, ref), checksOf });
      assert.equal(archived.isListed(k.repo.root), false);

      listed = true;
      const st = await call("merge.status", { project: k.repo.root }, op);
      assert.equal(st.ok, true, JSON.stringify(st.error));
      assert.equal(st.merge?.view?.served, false, "no checks declared: the tab offers Initialize");
      assert.equal(st.merge?.view?.checks, "unset");
      assert.equal(st.merge?.view?.project, "prj_side");
      assert.equal(st.merge?.view?.heads.target, k.repo.head());
      const add = await call("merge.add", { project: k.repo.root, checkout: b.path }, op);
      assert.equal(add.error?.message, NOT_SERVED, "listed, not set up: Land is refused with the same sentence, never 'not set up'");
      assert.equal(existsSync(join(base, projectKey(k.repo.root), "queue.json")), false, "status and refusals of a listed project with no setup write no queue.json");
      assert.equal((await k.queues.loaded()).length, 0, "no queue is loaded for it");

      const dry = await call("merge.setup", { project: k.repo.root, none: true, dryRun: true }, op);
      assert.notEqual(dry.error?.message, NOT_SERVED, "Initialize reaches the setup");
      setUp = true;
      const ok = await call("merge.add", { project: k.repo.root, checkout: b.path }, op);
      assert.notEqual(ok.error?.message, NOT_SERVED);
    } finally {
      await k.done();
    }
  });

  test("the view says served: false for a listed project with no setup", async () => {
    const k = makeKit({ checks: "unset", deps: { listed: () => true } });
    try {
      assert.equal((await (await k.q()).view()).served, false);
    } finally {
      await k.done();
    }
  });
});

describe("the chat's landing lines (per turn, per repo)", () => {
  test("one line per repo at the first note, again only when a repo's answer changes; the queue's own chats get none", async () => {
    const targets = new Map<string, string | null>([["/r/sova", "master"], ["/r/side", null]]);
    const notes = new LandingNotes({
      repos: async (s) => (s === "thread" ? null : s === "both" ? ["/r/side", "/r/sova", "/r/sova"] : ["/r/side"]),
      targetOf: async (root) => targets.get(root) ?? null,
    });
    assert.equal(await notes.noteFor("both"), [unservedLine("/r/side"), servedLine("/r/sova", "master")].join("\n"));
    assert.equal(await notes.noteFor("both"), null, "said once");
    assert.equal(await notes.noteFor("thread"), null);
    assert.equal(await notes.noteFor("solo"), unservedLine("/r/side"), "each chat hears its own");
    targets.set("/r/side", "main");
    assert.equal(await notes.noteFor("both"), servedLine("/r/side", "main"), "the side repo was set up");
    assert.match(servedLine("/r/x", "master"), /only through Sova's merge queue/);
    assert.doesNotMatch(unservedLine("/r/x"), /merge queue's|Land\b/);
  });
});

