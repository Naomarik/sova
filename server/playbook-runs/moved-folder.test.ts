import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * A playbook run started before Sova's own playbooks moved to system-playbooks/ (migrations/manifest.json:
 * system-playbooks-old-paths): its record keeps `<install>/playbooks/<id>`, now gone. The chat's playbook block may name
 * either folder; the run is still the one the chat conducts, and its bundle (what playbook_read and a compaction's
 * re-prime read) is at the new place.
 */
const base = realpathSync(mkdtempSync(join(tmpdir(), "sova-moved-run-")));
process.env.PI_CODING_AGENT_DIR = join(base, "agent");
after(() => rmSync(base, { recursive: true, force: true }));

const { createRun, changeRun } = await import("./store");
const { playbookHost } = await import("../playbook-host");

const install = join(base, "install");
const OLD = join(install, "playbooks", "project-verbs");
const NEW = join(install, "system-playbooks", "project-verbs");
mkdirSync(NEW, { recursive: true });
writeFileSync(join(NEW, "PLAYBOOK.md"), "---\ntitle: Project verbs\n---\n# Project verbs\n");

const runIn = (chat: string, dir: string) => {
  const r = createRun({ playbook: { source: "sova", id: "project-verbs", dir, entry: "PLAYBOOK.md", title: "Project verbs" }, cwd: base, initial: { choices: {}, origins: {} } });
  changeRun(r.id, (x) => {
    x.state = "started";
    x.started = { at: new Date().toISOString(), revision: 1, chat: { id: chat, path: join(base, `${chat}.jsonl`) }, newChat: false, folder: join(base, "run") };
  });
  return r;
};

test("a run recorded with the old folder is found from a block naming either folder, and reads at the new one", async () => {
  runIn("s-old", OLD);
  for (const named of [OLD, NEW]) {
    const bundle = await playbookHost.bundleFor("s-old", { id: "project-verbs", dir: named });
    assert.deepEqual(bundle, { id: "project-verbs", dir: NEW, entry: "PLAYBOOK.md" }, `the block names ${named}`);
  }
  // A folder of another playbook still names another run: the mapping never merges two playbooks.
  assert.equal(await playbookHost.bundleFor("s-old", { id: "project-verbs", dir: join(install, "playbooks", "brandmaker") }), null);
});

test("a run recorded with the new folder is found from a block naming the old one", async () => {
  runIn("s-new", NEW);
  assert.equal((await playbookHost.bundleFor("s-new", { id: "project-verbs", dir: OLD }))?.dir, NEW);
});
