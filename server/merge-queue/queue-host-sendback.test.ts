// What the host says is the branch's goes back to its chat by itself (al_3, §app.merge-queue/send-back): on an open
// request, conflicts, the host's own checks failing and changes requested each become one request to the branch's chat
// with the host's reason, the entry back with the chat under the user's standing Land, once per problem and head; a
// publish refused for something in the branch (a private name in a commit) goes back the same way. Stand-in host.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { HostFactsWire } from "../../shared/merge-queue-hosts";
import type { QueueDeps } from "./queue";
import { hostProblem } from "./host-sendback";
import { writeOverride } from "./strategy";
import { makeKit, tryGit, until } from "./testing/queue-kit";

/** An in-process GitHub over the kit's bare origin; `said` is what it says of each request's checks, review and merge. */
function host() {
  const reqs = new Map<number, { head: string; base: string; state: "open" | "merged" | "closed" }>();
  const said: Pick<HostFactsWire, "checks" | "review" | "mergeable"> = { checks: "pending", review: "none", mergeable: "unknown" };
  let origin = "";
  let next = 1;
  const facts = (n: number) => {
    const r = reqs.get(n)!;
    return { number: n, url: `https://github.com/o/r/pull/${n}`, state: r.state, ...said, headSha: tryGit(origin, "rev-parse", `refs/heads/${r.head}`).out || null, headBranch: r.head, baseBranch: r.base, mergeCommit: null, mergedAt: null };
  };
  const adapter = {
    kind: "github" as const,
    cli: "gh" as const,
    auth: async () => ({ ok: true as const }),
    find: async (_r: unknown, q: { head: string; base: string }) => {
      for (const [n, r] of reqs) if (r.head === q.head && r.base === q.base && r.state === "open") return { ok: true as const, request: facts(n) };
      return { ok: true as const, request: null };
    },
    create: async (_r: unknown, c: { head: string; base: string }) => {
      const n = next++;
      reqs.set(n, { head: c.head, base: c.base, state: "open" });
      return { ok: true as const, request: facts(n) };
    },
    update: async () => ({ ok: true as const }),
    view: async (_r: unknown, n: number) => ({ ok: true as const, request: facts(n) }),
  };
  return {
    said,
    setOrigin: (o: string) => void (origin = o),
    deps: { hostAdapter: () => adapter, hostRepo: async () => ({ kind: "github", host: "github.com", path: "o/r", web: "https://github.com/o/r" }) } as unknown as Partial<QueueDeps>,
  };
}

test("hostProblem: conflicts, then failed checks, then changes requested; nothing for pending, passed, approved, merged or closed", () => {
  const f = (x: Partial<HostFactsWire>): HostFactsWire => ({ state: "open", checks: "pending", review: "none", mergeable: "unknown", headSha: "abc", ...x });
  const r = { host: "github" as const, number: 7, url: "https://github.com/o/r/pull/7" };
  assert.equal(hostProblem(f({ mergeable: "conflicts", checks: "fail" }), r, "master")?.kind, "conflicts");
  assert.match(hostProblem(f({ checks: "fail", review: "changes-requested" }), r, "master")!.why, /^GitHub's own checks failed on #7 \(https:\/\/github\.com\/o\/r\/pull\/7\)/);
  assert.equal(hostProblem(f({ review: "changes-requested" }), { ...r, host: "gitlab" }, "master")?.why.startsWith("a reviewer on GitLab asked for changes on !7"), true);
  assert.equal(hostProblem(f({ checks: "fail" }), r, "master")?.key, "checks:abc", "keyed by problem and head");
  for (const x of [f({}), f({ checks: "pass", review: "approved", mergeable: "mergeable" }), f({ state: "merged", checks: "fail" }), f({ state: "closed", mergeable: "conflicts" })]) assert.equal(hostProblem(x, r, "master"), null);
  assert.equal(hostProblem(undefined, r, "master"), null);
});

describe("the host's word on an open request goes back to the chat by itself", () => {
  test("the host's checks fail: one request with the host's reason, the entry back with the chat; polled again, nothing more", async () => {
    const h = host();
    const k = makeKit({ deps: h.deps });
    try {
      const q = await k.q();
      h.setOrigin(k.repo.origin);
      k.repo.branch("feat/h", { "h.txt": "h\n" });
      const { entry } = await q.add({ branch: "feat/h", by: "land-button", session: "s1", via: "github-pr" });
      await until(async () => (await k.entry(entry.id)).state === "request-review", "request-review");
      await q.publish(entry.id, { title: "H", body: "Adds h.", draft: false });
      assert.equal((await k.entry(entry.id)).state, "requested");
      // Control: pending checks are no problem.
      await q.pollHost();
      assert.equal((await k.entry(entry.id)).state, "requested");
      h.said.checks = "fail";
      await q.pollHost();
      const e = await k.entry(entry.id);
      assert.equal(e.state, "with-chat");
      assert.equal(e.requests?.length, 1);
      assert.equal(e.requests![0]!.kind, "fix");
      assert.match(e.requests![0]!.text, /GitHub's own checks failed on #1 \(https:\/\/github\.com\/o\/r\/pull\/1\)/);
      assert.equal(e.request?.number, 1, "the request on the host is kept: the fix goes onto it");
      assert.deepEqual(k.notices.filter((n) => n.kind === "needs-fix").length, 1);
      // Polled again while it is with the chat: it isn't requested any more, so nothing more goes.
      await q.pollHost();
      assert.equal((await k.entry(entry.id)).requests?.length, 1);
    } finally {
      await k.done();
    }
  });

  test("conflicts on the host and changes requested go back the same way", async () => {
    for (const said of [{ mergeable: "conflicts" as const }, { review: "changes-requested" as const }]) {
      const h = host();
      const k = makeKit({ deps: h.deps });
      try {
        const q = await k.q();
        h.setOrigin(k.repo.origin);
        k.repo.branch("feat/c", { "c.txt": "c\n" });
        const { entry } = await q.add({ branch: "feat/c", by: "land-button", session: "s1", via: "github-pr" });
        await until(async () => (await k.entry(entry.id)).state === "request-review", "request-review");
        await q.publish(entry.id, { title: "C", body: "Adds c.", draft: false });
        Object.assign(h.said, said);
        await q.pollHost();
        const e = await k.entry(entry.id);
        assert.equal(e.state, "with-chat", JSON.stringify(said));
        assert.match(e.requests!.at(-1)!.text, said.mergeable ? /no longer merges cleanly into master/ : /asked for changes on #1/);
      } finally {
        await k.done();
      }
    }
  });
});

describe("a publish refused for something in the branch goes back to the chat by itself", () => {
  test("a private name in a commit: a request with the refusal, the entry back with the chat, never a plain needs-fix", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      writeOverride(q.store.dir, "push-branch");
      writeFileSync(join(k.repo.state, "merge-round.json"), JSON.stringify({ v: 1, privateNames: ["acme-corp"] }));
      k.repo.branch("feat/n", { "n.txt": "made for acme-corp\n" });
      const { entry } = await q.add({ branch: "feat/n", by: "land-button", session: "s1" });
      await until(async () => ["with-chat", "needs-fix", "pushed"].includes((await k.entry(entry.id)).state), "published or refused");
      const e = await k.entry(entry.id);
      assert.equal(e.state, "with-chat", e.reason);
      assert.equal(e.sentBackFor, "host");
      assert.equal(e.requests?.length, 1);
      assert.match(e.requests![0]!.text, /private name/);
    } finally {
      await k.done();
    }
  });
});
