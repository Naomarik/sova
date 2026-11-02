import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { APP, LIST_PLUS, STATE, mergeCopyOf, mergesOnto, resolution, reversedResolution, reviewer, settled, setup, testedHead } from "./testing/scenario-kit";
import { Fixture, git, until } from "./testing/repo";
import type { HarnessOptions } from "./testing/harness";
import type { MergeEntry } from "../../shared/merge-queue";

/**
 * The merge queue's use cases (team brief, TESTING): conflicts the merge thread judges. Each on a real git repository in a temp dir with a bare
 * origin: the real queue on the real run, driven through the queue's verb methods (testing/harness.ts); only the
 * branch's chat, the merge thread and the reviewer chat are stood in for. Waits are on conditions.
 */
void [APP, LIST_PLUS, STATE, mergeCopyOf, mergesOnto, resolution, reviewer, settled, setup, testedHead, Fixture, git, until, existsSync, writeFileSync, join, assert];
export type _H = HarnessOptions | MergeEntry;

describe("conflicts", () => {
  async function twoAppenders(ho: HarnessOptions, fo: ConstructorParameters<typeof Fixture>[0] = {}) {
    const { fx, h } = await setup(fo, ho);
    const a = fx.branch("a", { "src/list.txt": LIST_PLUS("delta") });
    const b = fx.branch("b", { "src/list.txt": LIST_PLUS("echo") });
    const la = await h.waitEntry((await h.add({ branch: a.branch })).id, settled);
    assert.equal(la.state, "landed");
    return { fx, h, a, b };
  }

  test("S2: no behaviour change (both sides extend a list): the thread resolves, the approval carries, full checks run on it, it lands with a note saying what and why", async () => {
    let called = 0;
    const { fx, h, b } = await twoAppenders({
      thread: {
        conflict: async (h, e, ev) => {
          called++;
          assert.deepEqual(ev.files, ["src/list.txt"]);
          const c = resolution(h.fx, e.commit, "src/list.txt", LIST_PLUS("delta\necho"));
          await h.resolve(e.id, { verdict: "no-behaviour-change", files: ["src/list.txt"], ours: "master adds delta", theirs: "the branch adds echo", proposal: "keep both: delta then echo", commit: c, note: "resolved src/list.txt: both sides append; kept both" });
        },
      },
    });
    const mark = fx.calls().length;
    const eb = await h.add({ branch: b.branch });
    const landed = await h.waitEntry(eb.id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    assert.equal(called, 1);
    assert.equal(fx.fileAt(fx.head(), "src/list.txt"), LIST_PLUS("delta\necho"));
    assert.equal(testedHead(fx, mark), fx.head(), "full checks ran on the resolved tip that landed");
    assert.ok(landed.notes.some((n) => n.kind === "resolved" || /resolv/i.test(n.text)), `a note says it resolved: ${JSON.stringify(landed.notes)}`);
  });

  test("S2b: a 'safe' resolution that changes lines outside the conflict is treated as behaviour differs (mechanical sanity)", async () => {
    const { fx, h, b } = await twoAppenders({
      thread: {
        conflict: async (h, e) => {
          const c = resolution(h.fx, e.commit, "src/list.txt", "ALPHA\nbravo\ncharlie\ndelta\necho\n");
          await h.resolve(e.id, { verdict: "no-behaviour-change", files: ["src/list.txt"], ours: "delta", theirs: "echo", proposal: "keep both", commit: c });
        },
      },
    });
    const before = fx.head();
    const eb = await h.add({ branch: b.branch });
    const s = await h.waitEntry(eb.id, settled);
    assert.equal(s.state, "behaviour-differs", `${s.state}: ${s.reason}`);
    assert.equal(s.conflict?.sanity?.ok, false);
    assert.equal(fx.head(), before, "nothing landed without the user");
  });

  async function differing(ho: HarnessOptions) {
    const { fx, h } = await setup({}, ho);
    const a = fx.branch("a", { "src/app.txt": APP("THREE-A") });
    const b = fx.branch("b", { "src/app.txt": APP("THREE-B") });
    assert.equal((await h.waitEntry((await h.add({ branch: a.branch })).id, settled)).state, "landed");
    return { fx, h, b };
  }
  const differs: HarnessOptions = {
    thread: {
      conflict: async (h, e) => {
        const c = resolution(h.fx, e.commit, "src/app.txt", APP("THREE-B"));
        await h.resolve(e.id, { verdict: "behaviour-differs", files: ["src/app.txt"], ours: "line 3 reads THREE-A", theirs: "line 3 reads THREE-B", proposal: "take the branch's THREE-B", commit: c });
      },
    },
  };

  test("S3: behaviour differs: waits for the user with both sides; Accept runs the proposed resolution and lands it", async () => {
    const { fx, h, b } = await differing(differs);
    const before = fx.head();
    const eb = await h.add({ branch: b.branch });
    const w = await h.waitEntry(eb.id, settled);
    assert.equal(w.state, "behaviour-differs", `${w.state}: ${w.reason}`);
    assert.match(w.conflict?.ours ?? "", /THREE-A/);
    assert.match(w.conflict?.theirs ?? "", /THREE-B/);
    assert.equal(fx.head(), before);
    const v = await h.view();
    assert.ok(v.needsYou.some((x) => x.id === eb.id), "in the needs-you list");
    await h.answer(eb.id, "accept");
    const l = await h.waitEntry(eb.id, (x) => x.state === "landed" || x.state === "needs-fix");
    assert.equal(l.state, "landed", `${l.state}: ${l.reason}`);
    assert.match(fx.fileAt(fx.head(), "src/app.txt") ?? "", /THREE-B/);
  });

  test("S3b: behaviour differs, Send Back: the entry goes back to its chat; master unmoved", async () => {
    const { fx, h, b } = await differing(differs);
    const before = fx.head();
    const eb = await h.add({ branch: b.branch });
    assert.equal((await h.waitEntry(eb.id, settled)).state, "behaviour-differs");
    await h.answer(eb.id, "send-back");
    const s = await h.waitEntry(eb.id, ["needs-fix"]);
    assert.equal(s.state, "needs-fix");
    assert.equal(fx.head(), before);
    assert.ok(h.notices.some((n) => n.branch === b.branch && n.kind === "sent-back"), "its chat is told");
  });

  test("S2c: a resolution judged safe that then fails a test comes back to the user; the branch is not blamed", async () => {
    const { fx, h, b } = await twoAppenders(
      {
        thread: {
          conflict: async (h, e) => {
            const c = resolution(h.fx, e.commit, "src/list.txt", LIST_PLUS("delta\necho"));
            await h.resolve(e.id, { verdict: "no-behaviour-change", files: ["src/list.txt"], ours: "delta", theirs: "echo", proposal: "keep both", commit: c });
          },
        },
      },
      // tests/combo.txt fails when the list holds both delta and echo: each side alone passes, the resolution fails.
      { files: { "tests/combo.txt": "forbid delta echo\n" } },
    );
    const before = fx.head();
    const eb = await h.add({ branch: b.branch });
    const s = await h.waitEntry(eb.id, (x) => settled(x) && x.state !== "landed" || x.state === "landed");
    assert.notEqual(s.state, "landed");
    assert.equal(fx.head(), before);
    assert.equal(h.run(s.run!).blame, "resolution", `blamed on the resolution (${h.run(s.run!).blame})`);
    assert.ok((["behaviour-differs", "conflict"] as string[]).includes(s.state) || s.state === "needs-fix", `back to the user: ${s.state}`);
    assert.equal(h.notices.filter((n) => n.kind === "needs-fix").length, 0, "the branch's chat isn't told to fix it");
  });

  test("S2d: no thread (down): a conflict is handed back to its chat after the wait, nothing else held up", async () => {
    const { fx, h, b } = await twoAppenders({ conflictWaitMs: 500 });
    const c = fx.branch("c", { "c.txt": "c\n" });
    const eb = await h.add({ branch: b.branch });
    const ec = await h.add({ branch: c.branch });
    const lc = await h.waitEntry(ec.id, settled);
    assert.equal(lc.state, "landed", "the line moved on past the conflict");
    const s = await h.waitEntry(eb.id, ["needs-fix", "behaviour-differs"]);
    assert.equal(s.state, "needs-fix", `${s.state}: ${s.reason}`);
    assert.match(s.reason ?? "", /conflict/i);
  });

  test("S2e: a resolution with its parents reversed ([pinned, target]) is never landed: it waits for the user with a clear why", async () => {
    const { fx, h, b } = await twoAppenders({
      thread: {
        conflict: async (h, e) => {
          const c = reversedResolution(h.fx, e.commit, "src/list.txt", LIST_PLUS("delta\necho"));
          await h.resolve(e.id, { verdict: "no-behaviour-change", files: ["src/list.txt"], ours: "delta", theirs: "echo", proposal: "keep both", commit: c });
        },
      },
    });
    const before = fx.head();
    const s = await h.waitEntry((await h.add({ branch: b.branch })).id, settled);
    assert.equal(s.state, "behaviour-differs", `${s.state}: ${s.reason}`);
    assert.match(s.reason ?? JSON.stringify(s.conflict?.sanity), /second parent|approved commit/);
    assert.equal(fx.head(), before);
  });
});
