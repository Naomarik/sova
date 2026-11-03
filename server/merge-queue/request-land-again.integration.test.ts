import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { setup } from "./testing/scenario-kit";
import { git, until } from "./testing/repo";
import type { QueueHarness } from "./testing/harness";
import { writeOverride } from "./strategy";

/**
 * Plan review al_3 b1: Land Again on a branch with an open pull request adds the new work on top of what was published,
 * never rewriting it (q6). The real queue on the real run, a local bare origin, and a stand-in `gh` on PATH
 * (testing/stand-in-gh.mjs): nothing reaches GitHub.
 */

const HERE = new URL(".", import.meta.url).pathname;
const BIN = join(process.env.TMPDIR ?? "/tmp", `sova-standin-gh-${process.pid}`);
mkdirSync(BIN, { recursive: true });
if (!existsSync(join(BIN, "gh"))) symlinkSync(join(HERE, "testing/stand-in-gh.mjs"), join(BIN, "gh"));
process.env.PATH = `${BIN}:${process.env.PATH ?? ""}`;

type Stand = { prs: { number: number; head: string; base: string; state: string }[]; calls: string[][] };
const ghState = (file: string): Stand => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Stand) : { prs: [], calls: [] });

/** The queue's host seams (landing-core): the fixture's local origin read as github.com/o/r. */
const hostDeps = () => ({ hostRepo: async () => ({ kind: "github", host: "github.com", path: "o/r", web: "https://github.com/o/r" }) });

type Q = ReturnType<QueueHarness["queue"]>;
/** q10's Publish, with the text as drafted (title, description; ready, not draft). */
async function publish(q: Q, id: string): Promise<void> {
  const f = (q as unknown as { publish?: (id: string, t: { title: string; body: string; draft: boolean }) => Promise<unknown> }).publish;
  assert.ok(f, "ProjectQueue.publish (q10's review step) isn't built");
  await f.call(q, id, { title: "Feature x", body: "Opened by Sova", draft: false });
}

describe("a pull request project: Land Again", () => {
  test("open a request, add a commit, Land Again: the second published head has the first as an ancestor on origin; one request", async () => {
    const { fx, h } = await setup({}, () => ({ deps: hostDeps() as never }));
    const stateFile = join(fx.root, "gh-state.json");
    process.env.GH_STANDIN_STATE = stateFile;
    process.env.GH_STANDIN_ORIGIN = fx.origin;
    const q = h.queue();
    writeOverride(q.store.dir, "github-pr");
    const masterBefore = fx.head();
    const b = fx.branch("x", { "src/x.txt": "x one\n" });

    // First Land: Sova's checks, then the request's text for review (q10), then Publish opens the request.
    const e1 = await h.add({ branch: b.branch, session: "s-x" });
    const r1 = await h.waitEntry(e1.id, (e) => ["request-review", "requested", "landed", "needs-fix"].includes(e.state));
    assert.equal(r1.state, "request-review", `checks passed, waiting for the request's text: ${r1.state} ${r1.reason ?? ""}`);
    await publish(q, e1.id);
    await h.waitEntry(e1.id, (e) => (e.state as string) === "requested");
    const first = git(fx.origin, ["rev-parse", `refs/heads/${b.branch}`]);
    assert.equal(ghState(stateFile).prs.length, 1, "one pull request opened");
    assert.equal(fx.head(), masterBefore, "a request project never moves the local target");

    // New work on the branch, then Land Again.
    const c2 = fx.commitIn(b.checkout, { "src/x.txt": "x two\n" }, "x: more");
    const e2 = await h.add({ branch: b.branch, session: "s-x" });
    assert.equal(e2.id, e1.id, "Land Again re-queues the same entry (its request carries over)");
    // Checked again (merged with the host's latest main), then its text for review, or straight onto the open request.
    const r2 = await h.waitEntry(e1.id, (e) => (e.commit === c2 && ["request-review", "requested"].includes(e.state)) || ["needs-fix", "landed", "cancelled"].includes(e.state));
    assert.ok(["request-review", "requested"].includes(r2.state), `Land Again checked and publishing: ${r2.state} ${r2.reason ?? ""}`);
    if (r2.state === "request-review") await publish(q, e1.id);
    const second = await until("the second publication on origin", () => {
      const h2 = git(fx.origin, ["rev-parse", `refs/heads/${b.branch}`]);
      return h2 !== first ? h2 : null;
    });

    // The check b1 names: exits 0 on the stand-in origin.
    git(fx.origin, ["merge-base", "--is-ancestor", first, second]);
    git(fx.origin, ["merge-base", "--is-ancestor", c2, second]);
    const s = ghState(stateFile);
    assert.equal(s.prs.length, 1, "the same request, never a second one");
    assert.ok(!s.calls.some((c) => c.includes("--force") || c.includes("--force-with-lease")), "nothing forced");
    // q9 = c: the chat's own folder has the published commit, so its next push of the branch doesn't clash.
    git(b.checkout, ["merge-base", "--is-ancestor", second, "HEAD"]);
    assert.equal(fx.head(), masterBefore, "still no local move");
  });
});
