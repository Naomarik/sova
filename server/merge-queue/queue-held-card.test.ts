import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import type { SettingsBy } from "../../shared/project-settings";
import { makeKit, sh, until, untilAborted } from "./testing/queue-kit";
import { linkPiConfigExtensions } from "../testing/agent-dir";

// A card that commits files never cuts into a run (§app.merge-queue/master-moved, §app.project-overseer/settings): on
// a real queue and real git, Apply holds, nothing voids, the queue doesn't pause, and the held click settles visibly,
// once, for exactly what it saw. Only the run is stood in for.

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-held-card-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.SOVA_AUTH = "off";
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
linkPiConfigExtensions(agentDir);

await import("../testing/in-process-chats");
const po = await import("../project-overseer");
const settings = await import("../project-settings");
const { registerProjectSettingsRoutes } = await import("../project-settings-routes");
const { registerProjectIn } = await import("../projects/spaces");
const { readPoSettings, projectOverseerPaths } = await import("../project-overseer-store");
const { disposeAllChats } = await import("../chat-manager");
const { setQueueCardPort } = await import("./card-port");

after(async () => {
  setQueueCardPort(null);
  await disposeAllChats();
});

const PROFILE = { id: "reviewer", label: "Reviewer", remove: ["shell"] };
const app = () => {
  const a = new Hono();
  registerProjectSettingsRoutes(a);
  return a;
};
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => app().request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }, { incoming: {} });

/** A project on a real queue, with a branch's run held at a gate until `release`. */
async function checking(outcome: Record<string, unknown> = {}, files: Record<string, string> = { "b.txt": "b\n" }) {
  const k = makeKit();
  const q = await k.q();
  const { project } = await registerProjectIn("standalone", k.repo.root, { name: `p${Math.random()}`, origin: "folder" });
  await po.ensureProjectOverseer(project.id);
  setQueueCardPort({ settings: () => q.settings(), save: (c) => q.saveSettings(c as never) as never, models: async () => {}, modelDenial: async () => null, heldByRelease: async () => q.heldByRelease(), whenQuiet: (_id, branch, fn) => q.runWhenQuiet(branch, fn) });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  k.run.set(async (input) => {
    await Promise.race([gate, untilAborted(input)]);
    return outcome;
  });
  k.repo.branch("feat/a", files);
  const before = k.repo.head();
  const { entry } = await q.add({ branch: "feat/a", by: "land-button" });
  await until(() => k.run.inputs.length === 1, "the run started");
  const pid = project.id;
  return { k, q, pid, before, entry, release };
}

const propose = async (pid: string, edits: unknown[], by: SettingsBy = { kind: "project-overseer", via: "tool" }) =>
  (await settings.proposeSettings(pid, { why: "Needed.", edits }, { attended: false, by })).card!;
const apply = (pid: string, c: { id: string; fingerprint: string }, headers = {}) => post(`/api/projects/${pid}/settings/apply`, { card: c.id, fingerprint: c.fingerprint }, headers);
const profileEdit = { setting: "profile", id: "reviewer", profile: PROFILE };

describe("a card that commits files, while a branch checks", () => {
  for (const by of [{ kind: "project-overseer", via: "tool" }, { kind: "create", via: "tool", chat: "c1" }] as const)
    test(`${by.kind}: Apply holds, nothing voids, the queue doesn't pause, then it lands once`, async () => {
      const t = await checking();
      try {
        const c = await propose(t.pid, [profileEdit], by);
        const r = await apply(t.pid, c);
        assert.equal(r.status, 200, await r.clone().text());
        const held = (await settings.settingsCard(t.pid, c.id))!;
        assert.deepEqual([held.state, held.saveWaits], ["waiting", true]);
        assert.equal(t.k.repo.head(), t.before, "the target didn't move under the run");
        assert.equal((await apply(t.pid, c)).status, 409, "a second press holds nothing more");
        t.release();
        await until(async () => (await settings.settingsCard(t.pid, c.id))!.state === "applied", "the card applied");
        const e = await t.k.entry(t.entry.id);
        assert.equal(e.state, "landed", `${e.state}`);
        assert.equal(t.q.store.readRun(t.k.run.inputs[0]!.runId)!.verdict, "passed", "the run wasn't voided");
        assert.equal(t.q.isPaused(), false);
        assert.ok(sh(t.k.repo.root, "show", `${t.k.repo.target}:.sova/profiles/reviewer.json`).includes("Reviewer"));
      } finally {
        t.release();
        t.k.done();
      }
    });

  test("a run that fails while the card waits: the card still applies, and the queue doesn't pause", async () => {
    const t = await checking({ verdict: "failed", reason: "red" });
    try {
      const c = await propose(t.pid, [profileEdit]);
      await apply(t.pid, c);
      t.release();
      await until(async () => (await settings.settingsCard(t.pid, c.id))!.state === "applied", "the card applied");
      assert.notEqual((await t.k.entry(t.entry.id)).state, "landed");
      assert.equal(t.q.isPaused(), false);
    } finally {
      t.release();
      t.k.done();
    }
  });

  test("a file changed while held: it fails saying so, and nothing goes over it", async () => {
    // The branch that's checking brings the same file.
    const t = await checking({}, { ".sova/offers.json": '{"version":1,"offers":{}}\n' });
    try {
      const c = await propose(t.pid, [{ setting: "offers", file: { version: 1, offers: {} } }]);
      await apply(t.pid, c);
      t.release();
      const failed = await until(async () => {
        const v = await settings.settingsCard(t.pid, c.id);
        return v?.saveFailed ? v : null;
      }, "the card failed");
      assert.equal(failed.state, "waiting");
      assert.match(failed.saveFailed!, /\.sova\/offers\.json changed.*Nothing was saved/);
      assert.equal(t.q.isPaused(), false);
    } finally {
      t.release();
      t.k.done();
    }
  });

  test("grants that differ at landing fail it, wider or narrower: an earlier click carries neither", async () => {
    const t = await checking();
    try {
      const c = await propose(t.pid, [profileEdit, { setting: "overseer", patch: { holdMin: 0 } }]);
      assert.equal(c.grants.length, 1);
      await apply(t.pid, c);
      // The hold reaches 0 another way, so the card no longer grants what the click saw.
      const { writePoSettings } = await import("../project-overseer-store");
      const paths = projectOverseerPaths(t.pid);
      writePoSettings(paths, { ...readPoSettings(paths), holdMin: 0 });
      t.release();
      const failed = await until(async () => {
        const v = await settings.settingsCard(t.pid, c.id);
        return v?.saveFailed ? v : null;
      }, "the card failed");
      assert.match(failed.saveFailed!, /no longer grants what it showed.*Nothing was saved/);
    } finally {
      t.release();
      t.k.done();
    }
  });

  test("Land on the folder's edits waits too, and lands only what the click saw", async () => {
    for (const edited of [false, true]) {
      const t = await checking();
      try {
        const file = join(t.k.repo.root, ".sova", "profiles", "local.json");
        mkdirSync(join(t.k.repo.root, ".sova", "profiles"), { recursive: true });
        writeFileSync(file, JSON.stringify({ id: "local", label: "Local", remove: ["shell"] }));
        const view = (await settings.localCard(t.pid))!;
        const r = await apply(t.pid, view);
        assert.equal(r.status, 200, await r.clone().text());
        assert.equal((await settings.localCard(t.pid))!.saveWaits, true);
        assert.equal(t.k.repo.head(), t.before);
        if (edited) writeFileSync(file, JSON.stringify({ id: "local", label: "Changed", remove: ["shell"] }));
        t.release();
        if (edited) {
          await until(async () => (await settings.localCard(t.pid))?.saveFailed, "it failed");
          assert.match((await settings.localCard(t.pid))!.saveFailed!, /changed since you pressed Land.*Nothing was saved/);
          await settings.withdrawCard(t.pid, "local", { operator: true, cancelSave: true });
          assert.ok(readFileSync(file, "utf8").includes("Changed"), "Cancel Save keeps the edits");
          assert.equal((await settings.localCard(t.pid))!.saveWaits, undefined);
        } else await until(async () => (await settings.localCard(t.pid)) === null, "it landed");
        assert.equal(t.q.isPaused(), false);
      } finally {
        t.release();
        t.k.done();
      }
    }
  });
});

describe("a release holding the queue", () => {
  test("a file card waits for it, says so, and lands when it ends", async () => {
    const t = await checking();
    try {
      t.release();
      await until(async () => (await t.k.entry(t.entry.id)).state === "landed", "the branch landed");
      const hold = t.q as unknown as { q: { release?: { id: string; tag: string } } };
      hold.q.release = { id: "rl_1", tag: "v1.2.0" };
      const c = await propose(t.pid, [profileEdit]);
      const head = t.k.repo.head();
      const r = await apply(t.pid, c);
      assert.equal(r.status, 200, await r.clone().text());
      const held = (await settings.settingsCard(t.pid, c.id))!;
      assert.equal(held.state, "waiting");
      assert.equal(held.saveWords, "Saves once release v1.2.0 is published or abandoned.");
      assert.equal(t.k.repo.head(), head, "the target stays on the release commit");
      delete hold.q.release;
      assert.equal((await settings.settingsCard(t.pid, c.id))!.state, "applied", "the hold is over: it lands");
      assert.notEqual(t.k.repo.head(), head);
    } finally {
      setQueueCardPort(null);
      t.k.done();
    }
  });
});

describe("the click a held Apply stands on", () => {
  /** A queue that reads busy until `quiet.value` says otherwise: a restart is a new read of what's on disk. */
  const stub = async () => {
    const k = makeKit();
    const { project } = await registerProjectIn("standalone", k.repo.root, { name: `p${Math.random()}`, origin: "folder" });
    await po.ensureProjectOverseer(project.id);
    const quiet: { value: boolean | null } = { value: false };
    setQueueCardPort({
      settings: async () => null,
      save: async () => ({ state: "waiting" }),
      models: async () => {},
      modelDenial: async () => null,
      async whenQuiet(_id, _b, fn) {
        if (quiet.value === true) await fn();
        return quiet.value;
      },
    });
    return { k, pid: project.id, quiet };
  };

  test("a caller that isn't the page holds nothing, and a fresh read can't stand in for the click", async () => {
    const t = await stub();
    const c = await propose(t.pid, [profileEdit]);
    for (const headers of [{ "x-sova-token": "x" }, { "x-sova-caller": "k" }]) assert.equal((await apply(t.pid, c, headers)).status, 403);
    assert.equal((await settings.settingsCard(t.pid, c.id))!.saveWaits, undefined, "no Apply is held");
    t.quiet.value = true;
    assert.equal((await settings.settingsInfo(t.pid)).cards.find((x) => x.id === c.id)!.state, "waiting", "a quiet queue applies nothing no click held");
    await settings.withdrawCard(t.pid, c.id, { operator: true });
    t.k.done();
  });

  test("Cancel Save spends it: nothing applies afterwards, and the chat can't cancel the person's click", async () => {
    const t = await stub();
    const c = await propose(t.pid, [profileEdit], { kind: "create", via: "tool", chat: "c1" });
    await apply(t.pid, c);
    await assert.rejects(settings.withdrawCard(t.pid, c.id, { operator: false, chat: "c1" }), /Cancel Save/);
    await settings.withdrawCard(t.pid, c.id, { operator: true });
    t.quiet.value = true;
    await settings.settingsInfo(t.pid);
    assert.equal((await settings.settingsCard(t.pid, c.id))!.state, "dismissed");
    assert.equal((await apply(t.pid, c)).status, 409, "never replayable");
    t.k.done();
  });

  test("a restart resumes it: applied once, or failed with why when nothing serves the project", async () => {
    const t = await stub();
    const a = await propose(t.pid, [profileEdit]);
    await apply(t.pid, a);
    t.quiet.value = true; // The queue came back quiet: all of the hold is on disk.
    assert.equal((await settings.settingsInfo(t.pid)).recent.find((x) => x.id === a.id)?.state, "applied");
    t.quiet.value = false;
    const b = await propose(t.pid, [{ setting: "offers", file: { version: 1, offers: {} } }]);
    await apply(t.pid, b);
    t.quiet.value = null; // The queue no longer serves it.
    const v = (await settings.settingsInfo(t.pid)).cards.find((x) => x.id === b.id)!;
    assert.deepEqual([v.state, v.saveWaits], ["waiting", true]);
    assert.match(v.saveFailed!, /no longer serves.*Nothing was saved/);
    t.k.done();
  });
});
