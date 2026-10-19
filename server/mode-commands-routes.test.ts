// Run: pnpm test -- server/mode-commands-routes.test.ts
// A project mode's commands and hooks through Sova's routes (§chat.mode-menu/project-mode-commands,
// §chat.mode-menu/project-mode-hooks), against a REAL hosted runtime whose only extension is this repo's mode
// extension, in a throwaway agent dir and checkout. No program runs here (the unit tier starts none):
// server/mode-commands.integration.test.ts runs them. What this file holds: the menu's new keys (absent for
// today's modes), who may approve hooks, the command route's refusals, and the route's mesh need.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import type { ChatModeResult, ProjectMinorInfo, ProjectModeApprovalNeeded } from "../shared/protocol";

const here = dirname(fileURLToPath(import.meta.url));
const dir = realpathSync(mkdtempSync(join(tmpdir(), "sova-mode-commands-routes-")));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const repo = realpathSync(mkdtempSync(join(tmpdir(), "sova-mode-commands-repo-")));
process.on("exit", () => rmSync(repo, { recursive: true, force: true }));
mkdirSync(join(repo, ".git"));
const modes = join(repo, ".sova/minor-modes");
const mode = (id: string, text: string, files: Record<string, string> = {}) => {
  mkdirSync(join(modes, id), { recursive: true });
  writeFileSync(join(modes, id, "MODE.md"), text);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(modes, id, name), body);
    chmodSync(join(modes, id, name), 0o755);
  }
};
mode("plain", "---\ndescription: Plain words\n---\nSay hello first.\n");
mode("rel", '---\ndescription: Release checks\ntools: [{"name": "status", "description": "Shows the status", "command": ["./status.sh"]}]\n---\nCheck the release.\n', { "status.sh": "#!/bin/sh\necho ok\n" });
mode(
  "hk",
  '---\ndescription: With hooks\ncommands: [{"name": "check", "description": "Runs the check", "run": ["./check.sh"]}]\nhooks: [{"on": "turn.ended", "run": ["./notify.sh"]}]\n---\nReport.\n',
  { "check.sh": "#!/bin/sh\necho ok\n", "notify.sh": "#!/bin/sh\n" },
);
mode("cmd", '---\ndescription: Commands only\ncommands: [{"name": "check", "description": "Runs the check", "run": ["./check.sh"]}]\n---\nCheck.\n', { "check.sh": "#!/bin/sh\necho ok\n" });

writeFileSync(join(dir, "settings.json"), JSON.stringify({ extensions: [resolve(here, "../pi-config/extensions/mode")] }));
writeFileSync(join(dir, "mode.json"), JSON.stringify({ version: 1, mode: "normal", strict: false, minorModes: [] }));
mkdirSync(join(dir, "sova"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = dir;
delete process.env.SOVA_CHAT_STATE_ROOT;
await import("./testing/in-process-chats");
const { buildApp } = await import("./app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { ensureOverseer } = await import("./overseer");
const { OVERSEER_SENDER_HEADER, senderSecret } = await import("./overseer-sender");
const { approvalsOf } = await import("./project-mode-approvals");
const { accessFile, allows, classifyRequest, resetAccessCache } = await import("./mesh/access");
after(async () => {
  await disposeAllChats();
});

const json = { "content-type": "application/json" };
const post = (path: string, body: unknown, headers: Record<string, string> = {}, env?: Record<string, unknown>) =>
  app.request(`/api/mode?path=${encodeURIComponent(path)}`, { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify(body) }, env);
const command = (path: string, body: unknown) => app.request(`/api/mode/command?path=${encodeURIComponent(path)}`, { method: "POST", headers: json, body: typeof body === "string" ? body : JSON.stringify(body) });
const get = async (path: string) => (await (await app.request(`/api/mode?path=${encodeURIComponent(path)}`)).json()) as ChatModeResult;
const row = (r: ChatModeResult, id: string) => r.projectMinors!.find((m) => m.id === id)!;

async function newChat(): Promise<string> {
  const res = await app.request("/api/sessions", { method: "POST", headers: json, body: JSON.stringify({ cwd: repo }) });
  assert.equal(res.status, 201, await res.clone().text());
  const { path } = (await res.json()) as { path: string };
  await acquireChat(path);
  return path;
}

const NEW_KEYS = ["commands", "hooks", "hooksNeedApproval", "hookNote"] as const;

test("a mode without commands or hooks has none of the new keys, off and on (its frame is what it was)", async () => {
  const path = await newChat();
  const off = await get(path);
  for (const id of ["plain", "rel"]) for (const k of NEW_KEYS) assert.equal(k in row(off, id), false, `${id}.${k}`);
  const rel = row(off, "rel");
  const on = (await (await post(path, { projectModes: ["plain", "rel"], approve: [{ id: "rel", hash: rel.toolsHash }] })).json()) as ChatModeResult;
  assert.deepEqual(on.projectModes, ["plain", "rel"]);
  for (const id of ["plain", "rel"]) for (const k of NEW_KEYS) assert.equal(k in row(on, id), false, `${id}.${k} once on`);
});

test("a mode with commands and hooks asks for approval and shows what it runs", async () => {
  const path = await newChat();
  const hk = row(await get(path), "hk");
  assert.equal(hk.needsApproval, true);
  assert.match(hk.toolsHash ?? "", /^[0-9a-f]{64}$/);
  assert.deepEqual(hk.commands, [{ name: "check", description: "Runs the check", command: ["./check.sh"] }]);
  assert.deepEqual(hk.hooks, [{ on: "turn.ended", command: ["./notify.sh"] }]);
  assert.equal("hooksNeedApproval" in hk, false, "nothing approved yet: the ordinary approval covers hooks");
  const refused = await post(path, { projectModes: ["hk"] });
  assert.equal(refused.status, 409);
  const body = (await refused.json()) as ProjectModeApprovalNeeded;
  assert.deepEqual(body.needsApproval.map((m: ProjectMinorInfo) => [m.id, m.hooks?.length]), [["hk", 1]]);
  // Your approval at turn-on is your own: the hooks are approved with it.
  const on = (await (await post(path, { projectModes: ["hk"], approve: [{ id: "hk", hash: hk.toolsHash }] })).json()) as ChatModeResult;
  assert.equal("hooksNeedApproval" in row(on, "hk"), false);
  assert.deepEqual(approvalsOf(repo, "hk").map((r) => r.by), ["user"]);
});

test("an Overseer turn-on approves the tools and commands, never the hooks: they wait for Approve Hooks", async () => {
  const path = await newChat();
  await ensureOverseer();
  const cmd = await post(path, { projectModes: ["cmd"] }, { [OVERSEER_SENDER_HEADER]: senderSecret() });
  assert.equal(cmd.status, 200, await cmd.clone().text());
  assert.equal("hooksNeedApproval" in row((await cmd.json()) as ChatModeResult, "cmd"), false, "no hooks, nothing waits");
  // A fresh mode for this test, so the approval store starts empty for it.
  mode("hk2", '---\ndescription: With hooks\nhooks: [{"on": "turn.ended", "run": ["./notify.sh"]}]\n---\nReport.\n', { "notify.sh": "#!/bin/sh\n" });
  const on = await post(path, { projectModes: ["cmd", "hk2"] }, { [OVERSEER_SENDER_HEADER]: senderSecret() });
  assert.equal(on.status, 200, await on.clone().text());
  const hk2 = row((await on.json()) as ChatModeResult, "hk2");
  assert.equal(hk2.hooksNeedApproval, true);
  assert.deepEqual(approvalsOf(repo, "hk2").map((r) => r.by), ["overseer"]);

  // Who may not approve hooks: the Overseer, a peer, a relay through a peer, a chat with its caller key.
  const ask = { approveHooks: [{ id: "hk2", hash: hk2.toolsHash }] };
  const notYou: [string, Response | Promise<Response>][] = [
    ["overseer", post(path, ask, { [OVERSEER_SENDER_HEADER]: senderSecret() })],
    ["relayed", post(path, ask, { "X-Sova-Relayed": "1" })],
    ["caller key", post(path, ask, { "x-sova-caller": "a-chat-key" })],
    ["operator token header", post(path, ask, { "x-sova-token": "the-operator-token" })],
    ["peer", post(path, ask, {}, { meshPeer: { nodeId: "nPeer" } })],
  ];
  for (const [who, p] of notYou) {
    const r = await p;
    assert.equal(r.status, 403, who);
    assert.match(((await r.json()) as { error: string }).error, /hooks/, who);
  }
  assert.deepEqual(approvalsOf(repo, "hk2").map((r) => r.by), ["overseer"], "nothing recorded");

  // A stale hash is refused like a stale approval; the right one records yours.
  const stale = await post(path, { approveHooks: [{ id: "hk2", hash: "0".repeat(64) }] });
  assert.equal(stale.status, 409);
  assert.ok(((await stale.json()) as ProjectModeApprovalNeeded).needsApproval.some((m) => m.id === "hk2"));
  const ok = await post(path, ask);
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal("hooksNeedApproval" in row((await ok.json()) as ChatModeResult, "hk2"), false);
  assert.deepEqual(approvalsOf(repo, "hk2").map((r) => r.by), ["user"]);
  // And the Overseer turning it on again never takes it back.
  await post(path, { projectModes: ["cmd"] }, { [OVERSEER_SENDER_HEADER]: senderSecret() });
  await post(path, { projectModes: ["cmd", "hk2"] }, { [OVERSEER_SENDER_HEADER]: senderSecret() });
  assert.deepEqual(approvalsOf(repo, "hk2").map((r) => r.by), ["user"]);
});

test("an approval at turn-on from anyone but your own page is a caller's: tools and commands run, hooks wait", async () => {
  const path = await newChat();
  const callers: [string, Record<string, string>, Record<string, unknown> | undefined][] = [
    ["a chat's caller key", { "x-sova-caller": "a-chat-key" }, undefined],
    ["a terminal with the operator token", { "x-sova-token": "the-operator-token" }, undefined],
    ["an extension's key", { "x-sova-token": "sova-ext-key" }, undefined],
    ["a sessions mesh peer", {}, { meshPeer: { nodeId: "nPeer" } }],
    ["a relay through a peer", { "X-Sova-Relayed": "1" }, undefined],
  ];
  for (const [i, [who, headers, env]] of callers.entries()) {
    const id = `hkc${i}`;
    mode(id, '---\ndescription: With hooks\ntools: [{"name": "status", "description": "S", "command": ["./notify.sh"]}]\nhooks: [{"on": "turn.ended", "run": ["./notify.sh"]}]\n---\nReport.\n', { "notify.sh": "#!/bin/sh\n" });
    const hash = row(await get(path), id).toolsHash;
    const on = await post(path, { projectModes: [id], approve: [{ id, hash }] }, headers, env);
    assert.equal(on.status, 200, `${who}: ${await on.clone().text()}`);
    const info = row((await on.json()) as ChatModeResult, id);
    assert.equal(info.hooksNeedApproval, true, `${who}: its hooks wait for you`);
    assert.equal("needsApproval" in info, false, `${who}: its tools and commands are approved, as today`);
    assert.deepEqual(approvalsOf(repo, id).map((r) => r.by), ["caller"], who);
    await post(path, { projectModes: [] });
  }
});

test("a switch that doesn't say who approved records a caller's approval, never yours (fail closed)", async () => {
  const path = await newChat();
  mode("hkd", '---\ndescription: With hooks\nhooks: [{"on": "turn.ended", "run": ["./notify.sh"]}]\n---\nReport.\n', { "notify.sh": "#!/bin/sh\n" });
  const hash = row(await get(path), "hkd").toolsHash!;
  const chat = await acquireChat(path);
  await chat.switchMode({ projectModes: ["hkd"], approve: [{ id: "hkd", hash }] });
  assert.deepEqual(approvalsOf(repo, "hkd").map((r) => r.by), ["caller"]);
  assert.equal(row(await get(path), "hkd").hooksNeedApproval, true);
});

test("approveHooks: a mode with no hooks, a body with more, or no path is refused", async () => {
  const path = await newChat();
  const cmdHash = row(await get(path), "cmd").toolsHash;
  assert.equal((await post(path, { approveHooks: [{ id: "cmd", hash: cmdHash }] })).status, 409);
  assert.equal((await post(path, { approveHooks: [{ id: "hk", hash: cmdHash }], projectModes: [] })).status, 400);
  assert.equal((await post(path, { approveHooks: [] })).status, 400);
  assert.equal((await post(path, { approveHooks: [{ id: "hk", hash: "nothex" }] })).status, 400);
  const noPath = await app.request("/api/mode", { method: "POST", headers: json, body: JSON.stringify({ approveHooks: [{ id: "hk", hash: cmdHash }] }) });
  assert.equal(noPath.status, 400);
});

test("POST /api/mode/command refuses a bad body, a mode that is off and a command it doesn't have", async () => {
  const path = await newChat();
  for (const bad of ["{not json", { mode: "Bad Id", name: "check" }, { mode: "cmd" }, { mode: "cmd", name: "check", args: [1] }, { mode: "cmd", name: "check", extra: 1 }, { mode: "cmd", name: "x".repeat(33) }])
    assert.equal((await command(path, bad)).status, 400, JSON.stringify(bad));
  const off = await command(path, { mode: "cmd", name: "check" });
  assert.equal(off.status, 409);
  assert.match(((await off.json()) as { error: string }).error, /mode.cmd.check wasn't run: project mode cmd is off in this chat/);
  const hash = row(await get(path), "cmd").toolsHash;
  assert.equal((await post(path, { projectModes: ["cmd"], approve: [{ id: "cmd", hash }] })).status, 200);
  const none = await command(path, { mode: "cmd", name: "nope" });
  assert.equal(none.status, 404);
  const missing = await app.request(`/api/mode/command?path=${encodeURIComponent(join(dir, "sessions", "nope.jsonl"))}`, { method: "POST", headers: json, body: JSON.stringify({ mode: "cmd", name: "check" }) });
  assert.ok([400, 404].includes(missing.status));
  // The mode's listing names its commands as ids a script runs.
  assert.deepEqual(row(await get(path), "cmd").commands?.map((c) => c.name), ["check"]);
});

test("a mesh peer needs `full` for POST /api/mode/command, whatever method; /api/mode stays `sessions`", () => {
  for (const method of ["POST", "GET", "DELETE", "PUT"]) assert.deepEqual(classifyRequest(method, "/api/mode/command"), { need: "full", rule: "full:mode-command" }, method);
  assert.equal(classifyRequest("POST", "/api/mode").need, "sessions");
  assert.equal(classifyRequest("GET", "/api/mode").need, "sessions");
  writeFileSync(accessFile(), JSON.stringify({ version: 1, peers: { nSessions: { preset: "sessions" } } }));
  resetAccessCache();
  try {
    assert.equal(allows("nSessions", classifyRequest("POST", "/api/mode").need), true);
    assert.equal(allows("nSessions", classifyRequest("POST", "/api/mode/command").need), false, "a sessions peer is refused");
  } finally {
    rmSync(accessFile(), { force: true });
    resetAccessCache();
  }
});
