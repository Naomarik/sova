import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { QueueDeps } from "./queue";
import { writeOverride } from "./strategy";
import { makeKit, sh, tryGit, until, untilAborted } from "./testing/queue-kit";

/** An in-process host over the kit's bare origin: requests by number; `close` and `merge` are the host's buttons. */
function host() {
  const reqs = new Map<number, { head: string; base: string; title: string; state: "open" | "merged" | "closed"; mergeCommit: string | null }>();
  let origin = "";
  let next = 1;
  const facts = (n: number) => {
    const r = reqs.get(n)!;
    return { number: n, url: `https://github.com/o/r/pull/${n}`, state: r.state, checks: "pending" as const, review: "none" as const, mergeable: "unknown" as const, headSha: tryGit(origin, "rev-parse", `refs/heads/${r.head}`).out || null, headBranch: r.head, baseBranch: r.base, mergeCommit: r.mergeCommit, mergedAt: null };
  };
  const adapter = {
    kind: "github" as const,
    cli: "gh" as const,
    auth: async () => ({ ok: true as const }),
    find: async (_r: unknown, q: { head: string; base: string }) => {
      for (const [n, r] of reqs) if (r.head === q.head && r.base === q.base && r.state === "open") return { ok: true as const, request: facts(n) };
      return { ok: true as const, request: null };
    },
    create: async (_r: unknown, c: { head: string; base: string; title: string }) => {
      const n = next++;
      reqs.set(n, { head: c.head, base: c.base, title: c.title, state: "open", mergeCommit: null });
      return { ok: true as const, request: facts(n) };
    },
    update: async () => ({ ok: true as const }),
    view: async (_r: unknown, n: number) => ({ ok: true as const, request: facts(n) }),
  };
  return {
    reqs,
    setOrigin: (o: string) => void (origin = o),
    deps: { hostAdapter: () => adapter, hostRepo: async () => ({ kind: "github", host: "github.com", path: "o/r", web: "https://github.com/o/r" }) } as unknown as Partial<QueueDeps>,
  };
}

describe("how it lands, at the queue", () => {
  test("a project that never chose lands locally, and its approval records no way of landing (as before)", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      k.repo.branch("feat/a", { "a2.txt": "a\n" });
      const { entry } = await q.add({ branch: "feat/a", by: "land-button" });
      await until(async () => (await k.entry(entry.id)).state === "landed", "landed");
      const e = await k.entry(entry.id);
      assert.equal("how" in e.approval, false);
      assert.equal(e.request, undefined);
      assert.equal(e.landed?.via, undefined);
    } finally {
      await k.done();
    }
  });

  test("Push branch only: checked, the chat's branch pushed to origin, the entry Pushed; local main never moves", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      writeOverride(q.store.dir, "push-branch");
      const before = k.repo.head();
      const b = k.repo.branch("feat/p", { "p.txt": "p\n" });
      const { entry } = await q.add({ branch: "feat/p", by: "land-button" });
      assert.equal(entry.approval.how, "push-branch");
      await until(async () => ["pushed", "request-review", "needs-fix"].includes((await k.entry(entry.id)).state), "published");
      const e = await k.entry(entry.id);
      assert.equal(e.state, "pushed", e.reason);
      assert.equal(e.request?.publishedHead, b.head);
      assert.equal(sh(k.repo.origin, "rev-parse", "refs/heads/feat/p"), b.head);
      assert.equal(k.repo.head(), before);
      assert.equal(sh(k.repo.origin, "rev-parse", "master"), before);
      assert.deepEqual(k.notices.map((n) => n.kind), ["pushed"]);
    } finally {
      await k.done();
    }
  });

  test("typed 'open a PR' on a local project opens a request; closed on the host: Closed; Land Again re-queues the same entry", async () => {
    const h = host();
    const k = makeKit({ deps: h.deps });
    try {
      const q = await k.q();
      h.setOrigin(k.repo.origin);
      const b = k.repo.branch("feat/r", { "r.txt": "r\n" });
      const { entry } = await q.add({ branch: "feat/r", by: "typed", via: "github-pr" });
      assert.equal(entry.approval.via, "github-pr");
      await until(async () => (await k.entry(entry.id)).state === "request-review", "request-review");
      assert.ok((await k.entry(entry.id)).request?.text?.body.includes("Opened by Sova"));
      await q.publish(entry.id, { title: "R", body: "Adds r.\n\nOpened by Sova", draft: false });
      assert.equal((await k.entry(entry.id)).state, "requested");
      const v = await q.view();
      assert.deepEqual(v.waitingOnHost?.map((x) => x.id), [entry.id]);
      h.reqs.get(1)!.state = "closed";
      await q.pollHost();
      assert.equal((await k.entry(entry.id)).state, "closed");
      k.repo.commitOn(b.path, { "r.txt": "r2\n" });
      const again = await q.add({ branch: "feat/r", by: "land-button" });
      assert.equal(again.entry.id, entry.id, "the same entry goes back in line");
      assert.equal(again.entry.state, "queued");
    } finally {
      await k.done();
    }
  });

  test("Sova stopped after pushing and before opening: at load the host is asked and the request opened once", async () => {
    const h = host();
    const k = makeKit({ deps: h.deps });
    try {
      const q = await k.q();
      h.setOrigin(k.repo.origin);
      writeOverride(q.store.dir, "github-pr");
      const b = k.repo.branch("feat/s", { "s.txt": "s\n" });
      const { entry } = await q.add({ branch: "feat/s", by: "land-button" });
      await until(async () => (await k.entry(entry.id)).state === "request-review", "request-review");
      // As if the push went out and Sova stopped before the request was created.
      sh(k.repo.root, "push", "-q", "origin", `${b.head}:refs/heads/feat/s`);
      const file = q.file;
      file.publish = { entry: entry.id, run: (await k.entry(entry.id)).run!, how: "github-pr", branch: "feat/s", step: "create", head: b.head, at: new Date().toISOString() };
      q.save();
      await k.queues.stop();
      const k2 = makeKit({ repo: k.repo, deps: h.deps });
      try {
        const q2 = await k2.q();
        assert.equal((await k2.entry(entry.id)).state, "requested");
        assert.equal(h.reqs.size, 1);
        assert.equal(q2.file.publish, undefined);
        await q2.recover();
        assert.equal(h.reqs.size, 1, "never a second request");
      } finally {
        await k2.queues.stop();
      }
    } finally {
      k.repo.done();
    }
  });

  test("q7: a settings save on a request project goes as its own sova/settings-… request; local main never moves", async () => {
    const h = host();
    const k = makeKit({ deps: h.deps });
    try {
      const q = await k.q();
      h.setOrigin(k.repo.origin);
      writeOverride(q.store.dir, "github-pr");
      const before = k.repo.head();
      const r = await q.saveSettings({ push: false });
      // The save's answer says it went as a request, and where.
      assert.equal(r.state, "requested");
      assert.equal(k.repo.head(), before, "local main never moves");
      assert.equal(sh(k.repo.origin, "rev-parse", "master"), before, "origin's main waits for the host's merge");
      const published = q.lastSettingsPublish;
      assert.equal(published?.state, "requested");
      assert.match(published?.branch ?? "", /^sova\/settings-\d{8}-\d{4}$/);
      assert.equal(sh(k.repo.origin, "rev-parse", `refs/heads/${published!.branch}^`), before);
      assert.match(sh(k.repo.origin, "show", `refs/heads/${published!.branch}:.sova/project.json`), /"push": false/);
      assert.equal([...h.reqs.values()][0]?.title.startsWith("Merge queue settings:"), true);
      assert.ok(r.state === "requested" && r.branch === published!.branch && r.number === (published as { number: number }).number && r.url === (published as { url: string }).url && r.commit === published!.commit);
    } finally {
      await k.done();
    }
  });

  test("q7: a request project's save while a branch is checking doesn't wait: it opens its request at once", async () => {
    const h = host();
    const k = makeKit({ deps: h.deps });
    let release = () => {};
    try {
      const q = await k.q();
      h.setOrigin(k.repo.origin);
      writeOverride(q.store.dir, "github-pr");
      const gate = new Promise<void>((r) => (release = r));
      k.run.set(async (input) => {
        await Promise.race([gate, untilAborted(input)]);
        return {};
      });
      k.repo.branch("feat/a", { "b.txt": "b\n" });
      await q.add({ branch: "feat/a", by: "land-button" });
      await until(() => k.run.inputs.length === 1, "a's run started");
      const before = k.repo.head();
      const r = await q.saveSettings({ push: false });
      assert.equal(r.state, "requested", `never "waiting" on a request project, got ${JSON.stringify(r)}`);
      assert.equal(q.file.pendingSave, undefined);
      assert.equal(k.repo.head(), before, "local main never moves");
    } finally {
      release();
      await k.done();
    }
  });

  test("a publication waits for a busy chat (flagged publishRequested); stopped mid-way, it is finished from its run, never rerun", async () => {
    let idle = false;
    const k = makeKit({ deps: { chatIdle: async () => idle } as Partial<QueueDeps> });
    try {
      const q = await k.q();
      writeOverride(q.store.dir, "push-branch");
      const b = k.repo.branch("feat/w", { "w.txt": "w\n" });
      const { entry } = await q.add({ branch: "feat/w", by: "land-button", session: "s-w" });
      // No docs here, so the idle gate needs a docs commit to matter: give the run one.
      k.run.set((input, merged) => {
        if (!("tip" in merged)) return {};
        const tree = sh(k.repo.root, "rev-parse", `${merged.tip}^{tree}`);
        const docs = sh(k.repo.root, "commit-tree", tree, "-p", merged.tip, "-m", `Spec: land w\n\nSova-Spec-Landing: merge-queue ${input.runId}`);
        return { tip: docs, mergeSha: merged.tip };
      });
      await until(async () => (await k.entry(entry.id)).state === "request-review", "waiting");
      const waiting = await k.entry(entry.id);
      assert.equal(waiting.request?.publishRequested, true, "on its way, not the user's to write");
      assert.match(waiting.reason ?? "", /busy/);
      const runs = waiting.runs.length;
      // As if Sova stopped mid-publish while the entry still read Checking.
      waiting.state = "checking";
      q.save();
      await k.queues.stop();
      idle = true;
      const k2 = makeKit({ repo: k.repo, deps: { chatIdle: async () => idle } as Partial<QueueDeps> });
      try {
        const q2 = await k2.q();
        assert.equal((await k2.entry(entry.id)).state, "request-review", "kept, not requeued");
        await q2.pollHost();
        const e = await k2.entry(entry.id);
        assert.equal(e.state, "pushed", e.reason);
        assert.equal(e.runs.length, runs, "never rerun");
        assert.equal(e.request?.publishRequested, undefined);
        assert.equal(sh(k.repo.root, "rev-parse", "feat/w^"), b.head, "one docs commit on the chat's branch");
      } finally {
        await k2.queues.stop();
      }
    } finally {
      k.repo.done();
    }
  });

  test("Update Local Main refuses a dirty main folder with the reason and pauses nothing", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      const other = join(k.repo.scratch, "host");
      sh(k.repo.scratch, "clone", "-q", k.repo.origin, other);
      writeFileSync(join(other, "h.txt"), "h\n");
      sh(other, "add", "h.txt");
      sh(other, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "merged on the host");
      sh(other, "push", "-q", "origin", "HEAD:master");
      writeFileSync(join(k.repo.root, "a.txt"), "dirty\n");
      await assert.rejects(q.updateLocalMain(), /uncommitted changes/);
      assert.equal(q.isPaused(), false);
      sh(k.repo.root, "checkout", "--", "a.txt");
      assert.equal((await q.updateLocalMain()).kind, "updated");
      assert.equal(k.repo.head(), sh(other, "rev-parse", "HEAD"));
    } finally {
      await k.done();
    }
  });
});
