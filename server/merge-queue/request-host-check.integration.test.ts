import assert from "node:assert/strict";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { setup } from "./testing/scenario-kit";
import { git } from "./testing/repo";
import type { QueueHarness } from "./testing/harness";
import { standInHosts, type StandInHosts } from "./hosts.integration.fixture";
import { writeOverride } from "./strategy";
import { MergeFailure } from "./queue";
import { typedGoAhead } from "../../pi-config/extensions/worktrees/landing.ts";

/**
 * al_3 implementation review (blocking): a request approval is checked against origin's host and this computer's
 * sign-in AT the approval, never discovered at publish after a full run.
 * T1: typed "open a PR/MR" follows origin's host (a GitLab origin opens a merge request); an origin on neither host is
 *     refused at queue.add.
 * T2 (a11): signed out, queue.add refuses with exactly "Sign in to GitHub on this computer first (gh auth login)" and
 *     starts no run; the same for an origin on the other host than the effective How it lands.
 * The real queue on the real run, the real host adapters, and the stand-in gh/glab (hosts.integration.fixture.ts) first
 * on PATH: nothing reaches GitHub or GitLab. The fixture's origin is a local bare repository, so the queue's `hostRepo`
 * seam says which host it stands for.
 */

type Kind = "github" | "gitlab" | null;
const REPOS = {
  github: { kind: "github", host: "github.com", path: "o/r", web: "https://github.com/o/r" },
  gitlab: { kind: "gitlab", host: "gitlab.com", path: "g/r", web: "https://gitlab.com/g/r" },
} as const;

/** A fixture project whose origin stands for `kind`'s host (null: a host Sova opens requests on neither), with the
 *  stand-in tools first on PATH for the whole test. */
async function project(kind: Kind, signedIn: { github: boolean; gitlab: boolean } = { github: true, gitlab: true }) {
  let hosts!: StandInHosts;
  const { fx, h } = await setup({}, () => ({ deps: { hostRepo: async () => (kind ? REPOS[kind] : null) } as never }));
  hosts = standInHosts({ origin: fx.origin, signedIn });
  const prev = process.env.PATH;
  process.env.PATH = `${hosts.bin}:${prev ?? ""}`;
  return { fx, h, hosts, restore: () => void (process.env.PATH = prev) };
}

/** No run was started for anything: no entry, and no run folder in the queue's records. */
function noRun(h: QueueHarness): void {
  const q = h.queue();
  assert.deepEqual(q.entries().map((e) => [e.branch, e.state]), [], "no entry in line");
  const runs = join(q.store.dir, "runs");
  assert.deepEqual(existsSync(runs) ? readdirSync(runs) : [], [], "no run started");
}

async function rejectsAdd(h: QueueHarness, req: Parameters<ReturnType<QueueHarness["queue"]>["add"]>[0], words: string | RegExp): Promise<void> {
  await assert.rejects(h.queue().add(req), (err: unknown) => {
    assert.ok(err instanceof MergeFailure, `a MergeFailure, not ${String(err)}`);
    if (typeof words === "string") assert.equal(err.message, words);
    else assert.match(err.message, words);
    return true;
  });
}

describe("T1: a typed request follows origin's host", () => {
  test("GitLab origin: typed 'open a PR' ends with a GitLab merge request opened, never a host-mismatch refusal", async () => {
    const { fx, h, hosts, restore } = await project("gitlab");
    try {
      const b = fx.branch("t1", { "src/t1.txt": "t1\n" });
      const word = typedGoAhead("open a PR");
      assert.ok(word?.via, "the words ask for a request");
      const { entry } = await h.queue().add({ branch: b.branch, by: "typed", session: "s-t1", via: word.via });
      const r = await h.waitEntry(entry.id, (e) => ["request-review", "requested", "landed", "needs-fix", "cancelled"].includes(e.state));
      assert.equal(r.state, "request-review", `checks passed, the request's text waits: ${r.state} ${r.reason ?? ""}`);
      await h.queue().publish(entry.id, { title: "T1", body: "Opened by Sova", draft: false });
      const done = await h.waitEntry(entry.id, (e) => e.state === "requested" || (e.state === "request-review" && !!e.reason && e.reason !== "publishing"));
      assert.equal(done.state, "requested", `opened, not refused: ${done.reason ?? ""}`);
      assert.doesNotMatch(done.reason ?? "", /origin is on|isn't on|change How it lands/);
      assert.equal(done.request?.host, "gitlab");
      const opened = hosts.state().requests;
      assert.deepEqual(opened.map((x) => [x.host, x.head]), [["gitlab", b.branch]], "one GitLab merge request from the branch");
      assert.ok(!hosts.calls().some((c) => c.cli === "gh" && c.args[0] === "pr"), "gh never asked to open a pull request");
    } finally {
      restore();
    }
  });

  test("an origin on neither host: typed 'open a PR' is refused at queue.add, before any run", async () => {
    const { fx, h, restore } = await project(null);
    try {
      const b = fx.branch("t1n", { "src/t1n.txt": "n\n" });
      await rejectsAdd(h, { branch: b.branch, by: "typed", via: typedGoAhead("open a PR")!.via! }, "origin isn't on GitHub or GitLab, so Sova can't open a pull or merge request here");
      noRun(h);
    } finally {
      restore();
    }
  });
});

describe("T2: sign-in and host checked up front (a11)", () => {
  const SIGN_IN = "Sign in to GitHub on this computer first (gh auth login)";

  test("signed out of GitHub: the Land button on a pull-request project is refused with the exact words; no run", async () => {
    const { fx, h, restore } = await project("github", { github: false, gitlab: true });
    try {
      writeOverride(h.queue().store.dir, "github-pr");
      const b = fx.branch("t2b", { "src/t2b.txt": "b\n" });
      await rejectsAdd(h, { branch: b.branch, by: "land-button" }, SIGN_IN);
      noRun(h);
    } finally {
      restore();
    }
  });

  test("signed out of GitHub: typed 'open a PR' on a local project is refused with the exact words; no run", async () => {
    const { fx, h, restore } = await project("github", { github: false, gitlab: true });
    try {
      const b = fx.branch("t2t", { "src/t2t.txt": "t\n" });
      await rejectsAdd(h, { branch: b.branch, by: "typed", via: typedGoAhead("open a PR")!.via! }, SIGN_IN);
      noRun(h);
    } finally {
      restore();
    }
  });

  test("origin on the other host than How it lands (pull request on GitHub, origin on GitLab): refused at queue.add; no run", async () => {
    const { fx, h, restore } = await project("gitlab");
    try {
      writeOverride(h.queue().store.dir, "github-pr");
      const b = fx.branch("t2w", { "src/t2w.txt": "w\n" });
      await rejectsAdd(h, { branch: b.branch, by: "land-button" }, "origin is on GitLab, not GitHub: change How it lands");
      noRun(h);
      assert.equal(git(fx.origin, ["branch", "--list", b.branch]), "", "nothing pushed to origin");
    } finally {
      restore();
    }
  });
});
