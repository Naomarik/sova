import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { until } from "../../scripts/e2e-release/fixtures";
import { startReleaseServer, type ModelAction, type ModelLogEntry, type ReleaseServer } from "../../scripts/e2e-release/server-kit";
import { playbookTurnText } from "../../shared/playbooks";

/**
 * Which chats are offered project_verbs (§app.project-services/tool-offered), driven for real: a hermetic Sova, chats
 * in their own processes, a scripted model that reports the tools each request declared.
 */

let k: ReleaseServer;
before(async () => {
  k = await startReleaseServer();
});
after(async () => {
  assert.deepEqual((await k?.stop()) ?? [], [], "the sentinel home is untouched");
});

let n = 0;
const folder = (): string => {
  const dir = join(k.hs.scratch, `offered-${++n}`);
  mkdirSync(dir, { recursive: true });
  const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", dir, ...args], { stdio: "ignore" });
  g("init", "-q", "-b", "master");
  g("commit", "-qm", "base", "--allow-empty");
  return dir;
};
const define = (dir: string) => {
  mkdirSync(join(dir, ".sova"), { recursive: true });
  writeFileSync(join(dir, ".sova", "project.json"), "{}\n");
};
const WRITE_DEFINITION: ModelAction = { tool: "bash", args: { command: "mkdir -p .sova && echo '{}' > .sova/project.json" } };

const open = async (cwd: string): Promise<string> => {
  const s = (await k.http("POST", "/api/sessions", { cwd })).json as { path?: string };
  assert.ok(s.path, JSON.stringify(s));
  return s.path;
};
/** Sends a message whose marker its actions are scripted on; answers each request of that reply, in order. */
const say = async (path: string, marker: string, actions: ModelAction[], text = `${marker} please`): Promise<ModelLogEntry[]> => {
  await k.model.script(marker, [...actions, { text: `${marker} done` }]);
  const sent = await k.http("POST", "/api/sessions/prompt", { path, text });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  await until(`${marker} to finish`, async () => (await k.model.log()).some((e) => e.match === marker && e.action?.text === `${marker} done`), 120_000, 100);
  return (await k.model.log()).filter((e) => e.match === marker);
};

let withSetup: string[] = [];

test("a chat in a folder with a definition has the tool from its first request", async () => {
  const dir = folder();
  define(dir);
  const [first] = await say(await open(dir), "[with-setup]", []);
  assert.ok(first!.tools.includes("project_verbs"), first!.tools.join());
  withSetup = first!.tools;
});

test("a chat in a folder with nothing never sees it; the step after it writes a definition has it, in the same place", async () => {
  const path = await open(folder());
  const [first, second] = await say(path, "[writes]", [WRITE_DEFINITION]);
  assert.deepEqual(first!.tools, withSetup.filter((t) => t !== "project_verbs"), "the same tools, one fewer");
  // The declaration goes out as an addition, after the rest (pi's system messages); the prompt's order is pinned in contract.test.ts.
  assert.deepEqual(second!.tools, [...first!.tools, "project_verbs"], "the next request of the same reply has it");
  assert.deepEqual([...second!.tools].sort(), [...withSetup].sort(), "the same tools as a chat that had it from its start");
  const [later] = await say(path, "[writes-next]", []);
  assert.deepEqual(later!.tools, second!.tools, "and it stays");
});

test("setup that lands while a chat is open reaches it at its next message, and removing it doesn't take the tool back", async () => {
  const dir = folder();
  const path = await open(dir);
  const [before] = await say(path, "[lands-1]", []);
  assert.ok(!before!.tools.includes("project_verbs"), before!.tools.join());
  define(dir);
  const [arrived] = await say(path, "[lands-2]", []);
  assert.deepEqual(arrived!.tools, [...before!.tools, "project_verbs"]);
  rmSync(join(dir, ".sova"), { recursive: true });
  const [kept] = await say(path, "[lands-3]", []);
  assert.deepEqual(kept!.tools, arrived!.tools);
});

test("a setup playbook started by hand has the tool in its first request; another playbook doesn't", async () => {
  const pb = (name: string, front: string) => {
    const dir = join(k.hs.scratch, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "PLAYBOOK.md"), `---\ntitle: ${name}\n${front}---\n# Body\n`);
    return { title: name, dir, body: "# Body\n" };
  };
  const [setup] = await say(await open(folder()), "[setup-pb]", [], playbookTurnText(pb("setup-pb", "proposes: pipeline\n"), "[setup-pb]"));
  assert.deepEqual(setup!.tools, withSetup);
  const [other] = await say(await open(folder()), "[other-pb]", [], playbookTurnText(pb("other-pb", ""), "[other-pb]"));
  assert.ok(!other!.tools.includes("project_verbs"), other!.tools.join());
});
