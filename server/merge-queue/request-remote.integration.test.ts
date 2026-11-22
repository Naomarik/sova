import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { setup } from "./testing/scenario-kit";
import { git } from "./testing/repo";
import { standInHosts } from "./hosts.integration.fixture";

/**
 * A request project whose remote isn't named origin (merge.remote, §app.merge-queue/project-shapes): the branch is
 * published to that remote, and when the host merges the request the queue reads the landing from that remote's copy
 * of the target (fetched and polled by its name), never from a remote called origin. The real queue on the real run,
 * the real GitHub adapter and the stand-in gh first on PATH (hosts.integration.fixture.ts): nothing reaches GitHub.
 */
describe("a request project whose remote is named upstream", () => {
  test("published to upstream; the host's merge is read from upstream's target: landed by the host, from the commit it was tested on", async () => {
    const { fx, h } = await setup({ merge: { remote: "upstream" } }, () => ({ deps: { hostRepo: async () => ({ kind: "github", host: "github.com", path: "o/r", web: "https://github.com/o/r" }), pollMs: 100 } as never }));
    git(fx.project, ["remote", "rename", "origin", "upstream"]);
    const hosts = standInHosts({ origin: fx.origin });
    const prev = process.env.PATH;
    process.env.PATH = `${hosts.bin}:${prev ?? ""}`;
    try {
      const base = fx.head();
      const b = fx.branch("up", { "src/up.txt": "up\n" });
      const { entry } = await h.queue().add({ branch: b.branch, by: "typed", session: "s-up", via: "github-pr" });
      const r = await h.waitEntry(entry.id, (e) => ["request-review", "requested", "landed", "needs-fix", "with-chat", "cancelled"].includes(e.state), 40_000);
      assert.equal(r.state, "request-review", `${r.state} ${r.reason ?? ""}`);
      await h.queue().publish(entry.id, { title: "Up", body: "Opened by Sova", draft: false });
      const opened = await h.waitEntry(entry.id, (e) => e.state === "requested" || (e.state === "request-review" && !!e.reason && e.reason !== "publishing"), 40_000);
      assert.equal(opened.state, "requested", opened.reason ?? "");
      assert.ok(git(fx.origin, ["rev-parse", `refs/heads/${b.branch}`]), "the branch was pushed to upstream");
      assert.equal(git(fx.project, ["remote"]), "upstream", "no origin was made");

      // Someone else's merge reaches upstream's target first; the host then merges this request on top of it.
      const other = mkdtempSync(join(tmpdir(), "sova-up-other-"));
      git(other, ["clone", "-q", fx.origin, "."]);
      writeFileSync(join(other, "other.txt"), "other\n");
      git(other, ["add", "other.txt"]);
      git(other, ["commit", "-q", "-m", "another request, merged on the host"]);
      git(other, ["push", "-q", "origin", "HEAD:master"]);
      const between = git(other, ["rev-parse", "HEAD"]);
      const merged = hosts.merge("github", 1);
      const landed = await h.waitEntry(entry.id, (e) => e.state === "landed", 40_000);
      assert.equal(landed.landed?.via, "host");
      assert.equal(landed.landed?.sha, merged, "the host's merge commit, read from upstream's target");
      assert.equal(landed.landed?.from, base, "from the target the run was tested on (upstream's, as last fetched)");
      assert.equal(git(fx.project, ["rev-parse", "refs/remotes/upstream/master"]), merged, "fetched from upstream by its name");
      // Every first-parent commit from the tested target to the host's merge is the queue's own (the push guard and
      // the moved-target rule read it): told apart from upstream's copy as last fetched, never origin's.
      const landedList = (JSON.parse(readFileSync(join(h.queue().store.dir, "queue.json"), "utf8")) as { landed: string[] }).landed;
      assert.ok(landedList.includes(between) && landedList.includes(merged), `recorded as landed: ${JSON.stringify(landedList.slice(-4))}`);
    } finally {
      process.env.PATH = prev;
    }
  });
});
