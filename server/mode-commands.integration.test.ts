// Run: pnpm test:int -- server/mode-commands.integration.test.ts
// A project mode's commands and hooks with real programs (§chat.mode-menu/project-mode-commands,
// §chat.mode-menu/project-mode-hooks):
//   1. the runner itself (server/mode-commands.ts) on real sh programs: a hook's real environment, its stdin, and a
//      chat closing on a running hook;
//   2. end to end on a throwaway server (server/testing/hermetic-server.ts: the stand-in model, a sentinel HOME),
//      driven only through scripts/sova.mjs as a script would: a mode approved and turned on, `sova run
//      mode.<id>.<name>`, `sova list --session`, a reply whose end runs the hook (and starts no other turn), and
//      an edited file refusing both.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { readProjectMode } from "../pi-config/extensions/mode/project-discovery.ts";
import type { ProjectModeSnapshot } from "../shared/project-modes";
import { HOOK_ENV_ALLOW, ModeActions, type ModeActionsHost } from "./mode-commands";
import { startHermeticServer } from "./testing/hermetic-server";

const ROOT = resolve(import.meta.dirname, "..");
const base = realpathSync(mkdtempSync(join(tmpdir(), "sova-mode-commands-int-")));
after(() => rmSync(base, { recursive: true, force: true }));

const MODE_MD = `---
description: Release checks
commands: [{"name": "release_check", "description": "Says the checks passed", "run": ["sh", "./check.sh"]}]
hooks: [{"on": "turn.ended", "run": ["sh", "./notify.sh"]}]
---
Check the release.
`;
const CHECK = 'cat; echo " checks passed in $SOVA_MODE_ID"\n';
const NOTIFY = 'cat > hook-ran.json; env > hook-env.txt; echo run >> hook-runs.txt\n';

/** A checkout (the folder itself: no .git above it) with the mode `rel`. */
function checkout(root: string, notify = NOTIFY): ProjectModeSnapshot {
  const dir = join(root, ".sova", "minor-modes", "rel");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "MODE.md"), MODE_MD);
  writeFileSync(join(dir, "check.sh"), CHECK);
  writeFileSync(join(dir, "notify.sh"), notify);
  const copy = readProjectMode(join(root, ".sova", "minor-modes"), "rel");
  assert.ok(!("kind" in copy), JSON.stringify(copy));
  return copy;
}

const until = async (cond: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

const host = (root: string, copy: ProjectModeSnapshot): ModeActionsHost => ({
  sessionId: () => "sess-int",
  cwd: () => root,
  projectOn: () => [{ id: "rel", sha: copy.sha }],
  copies: () => new Map([[copy.sha, copy]]),
  sandboxOn: () => false,
  notHere: () => null,
  approved: () => true,
  approvedByUser: () => true,
});

test("a real hook gets the event on stdin and an env with no Sova credential, whatever its chat had", async () => {
  const root = join(base, "env");
  mkdirSync(root);
  const copy = checkout(root);
  const parent: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["SOVA_CHAT_SOCK", "SOVA_CHAT_PATH", "SOVA_CHAT_ID", "SOVA_CHAT_UNIT", "SOVA_CHAT_BUILD", "SOVA_CHAT_STATE_ROOT", "SOVA_CHAT_LIVE_ROOT", "SOVA_CHAT_COPIES_ROOT", "SOVA_CALLER_KEY", "SOVA_URL", "SOVA_PORT", "SOVA_TOKEN", "SOVA_AGENT_DIR", "PI_CODING_AGENT_DIR"])
    parent[k] = `/secret/${k}`;
  const logs: string[] = [];
  const actions = new ModeActions(host(root, copy), { env: parent, log: (l) => logs.push(l) });
  actions.turnStarted();
  actions.turnSettled();
  await until(() => existsSync(join(root, "hook-runs.txt")), 10_000, "the hook ran");
  const keys = readFileSync(join(root, "hook-env.txt"), "utf8")
    .split("\n")
    .map((l) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(l)?.[1])
    .filter((k): k is string => !!k);
  // What sh sets itself (PWD, SHLVL, _, OLDPWD) is the shell's own.
  const allowed = new Set<string>([...HOOK_ENV_ALLOW, "SOVA_MODE_ID", "SOVA_MODE_DIR", "SOVA_PROJECT_ROOT", "SOVA_HOOK_EVENT", "PWD", "SHLVL", "_", "OLDPWD"]);
  assert.deepEqual(keys.filter((k) => !allowed.has(k)), [], "only the allowlist and the mode's own variables");
  assert.deepEqual(keys.filter((k) => k.startsWith("PI_")), []);
  assert.deepEqual(keys.filter((k) => k.startsWith("SOVA_")).sort(), ["SOVA_HOOK_EVENT", "SOVA_MODE_DIR", "SOVA_MODE_ID", "SOVA_PROJECT_ROOT"]);
  const event = JSON.parse(readFileSync(join(root, "hook-ran.json"), "utf8"));
  assert.deepEqual(Object.keys(event).sort(), ["at", "event", "mode", "sessionId"]);
  assert.equal(event.event, "turn.ended");
  assert.deepEqual(logs, []);
});

test("a real command runs with the chat's own env, as an approved tool does", async () => {
  const root = join(base, "cmd");
  mkdirSync(root);
  const copy = checkout(root);
  const actions = new ModeActions(host(root, copy), { env: { ...process.env, SOVA_CHAT_ID: "the-chat" } });
  const got = await actions.runCommand("rel", "release_check", { a: 1 });
  assert.ok(got.ok, JSON.stringify(got));
  assert.equal(got.result.stdout, '{"a":1} checks passed in rel\n');
});

test("closing the chat kills a running hook's whole process group", async () => {
  const root = join(base, "kill");
  mkdirSync(root);
  const copy = checkout(root, "echo $$ > hook-pid.txt; sleep 30 & wait\n");
  const logs: string[] = [];
  const actions = new ModeActions(host(root, copy), { log: (l) => logs.push(l) });
  actions.turnStarted();
  actions.turnSettled();
  await until(() => existsSync(join(root, "hook-pid.txt")) && readFileSync(join(root, "hook-pid.txt"), "utf8").trim() !== "", 10_000, "the hook started");
  const pid = Number(readFileSync(join(root, "hook-pid.txt"), "utf8").trim());
  actions.dispose();
  await until(() => logs.some((l) => /stopped: the chat closed/.test(l)), 10_000, "the hook stopped");
  assert.throws(() => process.kill(pid, 0), "its process is gone");
});

test("end to end: approve, turn on, then through sova run mode.rel.release_check, and a reply runs the hook once", { timeout: 120_000 }, async () => {
  const server = await startHermeticServer();
  try {
    // The chats load this tree's mode extension (the hermetic agent dir has none of its own).
    const settingsFile = join(server.agentDir, "settings.json");
    const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    writeFileSync(settingsFile, JSON.stringify({ ...settings, extensions: [join(ROOT, "pi-config", "extensions", "mode")] }, null, 2));
    const work = realpathSync(server.work);
    const copy = checkout(work);
    // The operator approved this version in the mode menu: that is not a command, so it is written as the menu writes it.
    writeFileSync(join(server.agentDir, "sova", "project-mode-approvals.json"), JSON.stringify({ version: 1, approvals: { [work]: { rel: [{ hash: copy.toolsHash, by: "user", at: new Date().toISOString() }] } } }));
    const env = { PATH: process.env.PATH ?? "", HOME: server.home, LANG: "C.UTF-8", SOVA_URL: server.base, SOVA_TOKEN: server.token, PI_CODING_AGENT_DIR: server.agentDir, TMPDIR: process.env.TMPDIR ?? "" };
    const sova = (...args: string[]) => {
      const r = spawnSync("node", [join(ROOT, "scripts", "sova.mjs"), ...args], { env, encoding: "utf8", timeout: 60_000 });
      let json: unknown;
      try {
        json = JSON.parse(r.stdout);
      } catch {
        json = undefined;
      }
      return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: json as Record<string, unknown> };
    };
    const created = sova("run", "session.create", "--cwd", work);
    assert.equal(created.code, 0, created.stderr);
    const path = created.json.path as string;
    // Turned on as the mode menu does (POST /api/mode?path=, the route the menu uses; not a catalogue command).
    const onRes = await fetch(`${server.base}/api/mode?path=${encodeURIComponent(path)}`, { method: "POST", headers: { "content-type": "application/json", "x-sova-token": server.token }, body: JSON.stringify({ projectModes: ["rel"] }) });
    assert.equal(onRes.status, 200, await onRes.clone().text());
    assert.deepEqual(((await onRes.json()) as { projectModes?: string[] }).projectModes, ["rel"]);

    const ran = sova("run", "mode.rel.release_check", "--session", path);
    assert.equal(ran.code, 0, ran.stderr + ran.stdout);
    assert.equal(ran.json.stdout, "{} checks passed in rel\n");
    assert.equal(ran.json.id, "mode.rel.release_check");
    const listed = sova("list", "--session", path);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /^mode\.rel\.release_check\s+changes\s+rel: release_check$/m);

    const sent = sova("run", "session.send", "--session", path, "--text", "Read package.json and tell me the package name.");
    assert.equal(sent.code, 0, sent.stderr);
    await until(() => existsSync(join(work, "hook-runs.txt")), 60_000, "the turn.ended hook ran");
    const event = JSON.parse(readFileSync(join(work, "hook-ran.json"), "utf8"));
    assert.equal(event.event, "turn.ended");
    assert.equal(event.mode, "rel");
    assert.doesNotMatch(readFileSync(join(work, "hook-env.txt"), "utf8"), /SOVA_CALLER_KEY|SOVA_CHAT_|SOVA_TOKEN|SOVA_URL|PI_CODING_AGENT_DIR/);
    // The hook started nothing: still one user message and one reply, and it ran once.
    await new Promise((r) => setTimeout(r, 1500));
    const read = sova("run", "session.read", "--session", path);
    const items = (read.json.items as { kind: string }[]).map((i) => i.kind);
    assert.equal(items.filter((k) => k === "user").length, 1);
    assert.equal(readFileSync(join(work, "hook-runs.txt"), "utf8"), "run\n");

    // Any file of the folder edited: the command is refused with the sentence (exit 2), and runs nothing.
    writeFileSync(join(copy.dir, "check.sh"), 'echo "edited"\n');
    const refused = sova("run", "mode.rel.release_check", "--session", path);
    assert.equal(refused.code, 2, refused.stdout);
    assert.match(String(refused.json.error), /changed since it was approved/);
  } finally {
    await server.stop();
  }
});
