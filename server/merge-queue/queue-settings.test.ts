import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { SETTINGS_DIRTY_WORDS } from "../../shared/merge-queue-settings";
import { parseDefinition } from "../../shared/project-contract";
import { writeModels } from "./models";
import { PUSH_WAITS_NEXT_LANDING } from "./queue";
import { makeKit, makeRepo, sh, tryGit, until, untilAborted } from "./testing/queue-kit";
import { existsSync, readdirSync } from "node:fs";
import { realGit } from "./guard";
import { bareSettings } from "./settings";
import { projectKey } from "./store";

// §app.merge-queue/settings, §app.merge-queue/settings-save, §app.merge-queue/models, §app.merge-queue/view

/** The definition as the target has it (the settings come from there, never the working tree). */
const realDefinition = {
  definitionAt: async (root: string, ref: string) => {
    const r = tryGit(root, "show", `${ref}:.sova/project.json`);
    if (r.code !== 0) return { def: null, error: "no .sova/project.json" };
    try {
      return { def: parseDefinition(r.out), error: null };
    } catch (err) {
      return { def: null, error: String(err) };
    }
  },
};

const FILE = `{
  "version": 1,
  "merge": {
    "push": true,
    "checks": [
      {"id": "unit", "label": "Unit tests", "run": ["true"], "timeout": 600},
      {"id": "e2e", "label": "Walkthroughs", "run": ["true"], "timeout": 1800, "rerun": true, "optional": true}
    ],
    "review": ".sova/playbooks/review"
  }
}
`;
const KIT = { ".sova/playbooks/review/PLAYBOOK.md": "# Review\n", ".sova/playbooks/review/references/checklist.md": "- x\n" };

function kit() {
  const k = makeKit({ deps: { ...realDefinition, projectIdOf: () => "prj_test", hasReviewKit: (d) => !!d?.merge?.review } });
  k.repo.commitOn(k.repo.root, { ".sova/project.json": FILE, ...KIT }, "definition");
  sh(k.repo.root, "push", "-q", "origin", "master");
  return k;
}

describe("the strip's Pushed to origin", () => {
  test("a fresh record reads origin's copy from its tracking ref; No remote only without origin", async () => {
    const k = kit();
    try {
      const q = await k.q();
      assert.deepEqual(q.file.heads, {}, "the record started after the last push");
      let v = await q.view();
      assert.equal(v.heads.hasOrigin, true);
      assert.equal(v.heads.pushed, k.repo.head(), "Pushed at the target's head, from refs/remotes/origin/master");
      sh(k.repo.root, "remote", "remove", "origin");
      q.settingsChanged();
      v = await q.view();
      assert.equal(v.heads.hasOrigin, false);
      assert.equal(v.heads.pushed, undefined);
    } finally {
      await k.done();
    }
  });
});

describe("the settings block", () => {
  test("values come from the target's file; the kit's files and both playbooks are listed; models default to new chats", async () => {
    const k = kit();
    try {
      const q = await k.q();
      const s = (await q.view()).settings!;
      assert.equal(s.at, k.repo.head());
      assert.equal(s.projectFileDiffers, false);
      assert.equal(s.editBlocked, undefined);
      assert.deepEqual(s.landing, { target: "master", push: true, names: { setUp: true, count: 0 } });
      assert.deepEqual(s.checks.list, [
        { id: "unit", label: "Unit tests", timeoutSec: 600, rerun: false, optional: false },
        { id: "e2e", label: "Walkthroughs", timeoutSec: 1800, rerun: true, optional: true },
      ]);
      assert.equal(s.review.on, true);
      assert.deepEqual(s.review.files, ["PLAYBOOK.md", "references/checklist.md"]);
      assert.deepEqual(s.review.folder, { label: "Review instructions", source: { kind: "project", project: "prj_test", ref: k.repo.head(), dir: ".sova/playbooks/review" } });
      assert.equal(s.thread.playbooks[0]!.source.kind, "builtin");
      assert.equal(s.review.model.picked, null);
      assert.equal(s.fixed.reviewTimeoutMin, 20);
      assert.equal(s.fixed.checkMaxMin, 30);
      assert.ok(s.fixed.mergeCopy.endsWith("proj-merge"));
      assert.ok(!JSON.stringify(s).includes("privateNames"), "never the names themselves");
      writeModels(q.store.dir, { review: { model: "zai/glm-5.3", thinking: "low" } });
      q.settingsChanged();
      assert.deepEqual((await q.settings()).review.model, { picked: { model: "zai/glm-5.3", thinking: "low" }, effective: { model: "zai/glm-5.3", thinking: "low" } });
    } finally {
      await k.done();
    }
  });

  test("an uncommitted edit of the settings file: the folder differs, saves are refused with why", async () => {
    const k = kit();
    try {
      const q = await k.q();
      writeFileSync(join(k.repo.root, ".sova/project.json"), FILE.replace('"push": true', '"push": false'));
      const s = await q.settings();
      assert.equal(s.projectFileDiffers, true);
      assert.equal(s.editBlocked, SETTINGS_DIRTY_WORDS);
      assert.equal(s.landing.push, true, "the target's value, not the folder's");
      const before = k.repo.head();
      await assert.rejects(q.saveSettings({ push: false }), (e: Error) => e.message === SETTINGS_DIRTY_WORDS);
      assert.equal(k.repo.head(), before);
    } finally {
      await k.done();
    }
  });
});

describe("the merge thread's playbook", () => {
  test("flagged when the project folder's copy (which the thread reads) isn't the target's", async () => {
    const k = kit();
    try {
      k.repo.commitOn(k.repo.root, { ".sova/playbooks/merge-queue/PLAYBOOK.md": "# Ours\n" }, "playbook");
      const q = await k.q();
      const book = () => q.settings().then((s) => s.thread.playbooks.find((p) => p.source.kind === "project")!);
      assert.equal((await book()).differsFromFolder, false);
      writeFileSync(join(k.repo.root, ".sova/playbooks/merge-queue/PLAYBOOK.md"), "# Edited\n");
      q.settingsChanged();
      assert.equal((await book()).differsFromFolder, true);
      sh(k.repo.root, "checkout", "--", ".sova/playbooks/merge-queue/PLAYBOOK.md");
      writeFileSync(join(k.repo.root, ".sova/playbooks/merge-queue/new.md"), "n\n");
      q.settingsChanged();
      assert.equal((await book()).differsFromFolder, true, "an untracked file counts");
    } finally {
      await k.done();
    }
  });
});

describe("saving", () => {
  test("idle: one commit on the target, only the changed values edited, the queue's own move, pushed with the next landing", async () => {
    const k = kit();
    try {
      const q = await k.q();
      await q.view();
      const before = k.repo.head();
      const r = await q.saveSettings({ push: false, checks: { unit: { timeoutSec: 1500 } } });
      assert.equal(r.state, "saved");
      const commit = (r as { commit: string }).commit;
      assert.equal(k.repo.head(), commit);
      assert.equal(sh(k.repo.root, "rev-parse", `${commit}^`), before);
      assert.equal(sh(k.repo.root, "log", "-1", "--format=%s", commit), "Merge queue settings: push off; unit: 25 min");
      assert.equal(sh(k.repo.root, "show", `${commit}:.sova/project.json`) + "\n", FILE.replace('"push": true', '"push": false').replace('"timeout": 600}', '"timeout": 1500}'));
      assert.deepEqual(sh(k.repo.root, "diff", "--name-only", before, commit).split("\n"), [".sova/project.json"]);
      assert.equal(q.file.knownTarget, commit);
      assert.ok(q.file.landed.includes(commit));
      assert.equal(q.file.heads.pushWhy, PUSH_WAITS_NEXT_LANDING);
      // The main folder followed (fast-forwarded, never forced).
      assert.equal(sh(k.repo.root, "rev-parse", "HEAD"), commit);
      const s = await q.settings();
      assert.equal(s.landing.push, false);
      assert.equal(s.checks.list[0]!.timeoutSec, 1500);
    } finally {
      await k.done();
    }
  });

  test("review off removes the kit's line; on puts it back; a change that can't apply is refused at once", async () => {
    const k = kit();
    try {
      const q = await k.q();
      await q.saveSettings({ review: false });
      assert.equal((await q.settings()).review.on, false);
      assert.equal((await q.settings()).review.canTurnOn, true);
      await q.saveSettings({ review: true });
      assert.equal(sh(k.repo.root, "show", "master:.sova/project.json") + "\n", FILE);
      await assert.rejects(q.saveSettings({ checks: { nope: { rerun: true } } }), /no check "nope"/);
      await assert.rejects(q.saveSettings({ checks: { unit: { optional: true } } }), /valid definition/);
      await assert.rejects(q.saveSettings({}), /names nothing/);
    } finally {
      await k.done();
    }
  });

  test("a save during a run waits; a second joins it; cancelled, nothing is committed after the landing", async () => {
    const k = kit();
    let release = () => {};
    try {
      const q = await k.q();
      const gate = new Promise<void>((r) => (release = r));
      k.run.set(async (input) => {
        await Promise.race([gate, untilAborted(input)]);
        return {};
      });
      k.repo.branch("feat/a", { "b.txt": "b\n" });
      const { entry } = await q.add({ branch: "feat/a", by: "land-button" });
      await until(() => k.run.inputs.length === 1, "a's run started");
      assert.deepEqual(await q.saveSettings({ push: false }), { state: "waiting" });
      assert.deepEqual(await q.saveSettings({ checks: { unit: { rerun: true } } }), { state: "waiting" });
      assert.deepEqual((await q.settings()).pendingSave?.changes, { push: false, checks: { unit: { rerun: true } } });
      assert.equal(await q.cancelPendingSave(), true);
      assert.equal(await q.cancelPendingSave(), false);
      release();
      await until(async () => (await k.entry(entry.id)).state === "landed", "a landed");
      const tip = (await k.entry(entry.id)).landed!.sha;
      await q.idle();
      assert.equal(k.repo.head(), tip, "no settings commit after the landing");
      assert.equal(JSON.parse(sh(k.repo.root, "show", "master:.sova/project.json")).merge.push, true);
    } finally {
      release();
      await k.done();
    }
  });
});

describe("a project the queue doesn't serve yet", () => {
  test("its settings are read from Git and this computer's files; no queue record is written", async () => {
    const repo = makeRepo();
    try {
      repo.commitOn(repo.root, { ".sova/project.json": '{\n  "version": 1\n}\n', ...KIT }, "no merge section");
      const base = join(repo.state, "merge-queue");
      const s = await bareSettings(repo.root, {
        base,
        git: realGit,
        setupOf: async () => ({ target: "master", head: repo.head(), checks: "unset" }),
        definitionAt: realDefinition.definitionAt,
        projectIdOf: () => "prj_bare",
        modelCheck: { defaults: () => ({ model: "a/b" }), denial: () => null },
        hosts: { suggest: async () => ({ how: "github-pr", why: "origin is on GitHub" }), adapterFor: () => { throw new Error("not asked"); } },
      });
      assert.ok(s);
      assert.equal(s!.checks.mode, "unset");
      assert.deepEqual(s!.checks.list, []);
      assert.equal(s!.review.canTurnOn, true, "the kit is on the target");
      assert.deepEqual(s!.how?.suggested, { how: "github-pr", why: "origin is on GitHub" });
      assert.equal(s!.review.model.picked, null);
      // The served rule's promise: answering made no queue and wrote no record.
      assert.equal(existsSync(join(base, projectKey(repo.root))), false);
      assert.deepEqual(existsSync(base) ? readdirSync(base) : [], []);
    } finally {
      repo.done();
    }
  });
});
