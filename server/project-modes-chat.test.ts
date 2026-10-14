// Run: bun test server/project-modes-chat.test.ts (or pnpm test)
// A project's own minor modes through the mode route (§chat.mode-menu/project-modes), against a REAL hosted
// runtime whose only extension is this repo's mode extension, in a throwaway agent dir and a throwaway
// checkout with two modes (one plain, one with a tool) and one broken folder. No model request is made:
// every switch runs the extension's own /mode handler.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import type { ChatModeResult, ProjectModeApprovalNeeded } from "../shared/protocol";

const here = dirname(fileURLToPath(import.meta.url));
const dir = realpathSync(mkdtempSync(join(tmpdir(), "sova-project-modes-")));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const repo = realpathSync(mkdtempSync(join(tmpdir(), "sova-project-modes-repo-")));
process.on("exit", () => rmSync(repo, { recursive: true, force: true }));
mkdirSync(join(repo, ".git"));
mkdirSync(join(repo, "sub"));
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
mode("broken", "---\ndefault: on\n---\nNo.\n");

writeFileSync(join(dir, "settings.json"), JSON.stringify({ extensions: [resolve(here, "../pi-config/extensions/mode")] }));
writeFileSync(join(dir, "mode.json"), JSON.stringify({ version: 1, mode: "normal", strict: false, minorModes: [] }));
process.env.PI_CODING_AGENT_DIR = dir;
delete process.env.SOVA_CHAT_STATE_ROOT;
await import("./testing/in-process-chats");
const { buildApp } = await import("./app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { ensureOverseer } = await import("./overseer");
const { OVERSEER_SENDER_HEADER, senderSecret } = await import("./overseer-sender");
const { approvalsFile, approvalsOf } = await import("./project-mode-approvals");
after(async () => {
  await disposeAllChats();
});

const json = { "content-type": "application/json" };
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(`/api/mode?path=${encodeURIComponent(path)}`, { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify(body) });
const get = async (path: string) => (await (await app.request(`/api/mode?path=${encodeURIComponent(path)}`)).json()) as ChatModeResult;

async function newChat(): Promise<string> {
  const res = await app.request("/api/sessions", { method: "POST", headers: json, body: JSON.stringify({ cwd: join(repo, "sub") }) });
  assert.equal(res.status, 201, await res.clone().text());
  const { path } = (await res.json()) as { path: string };
  await acquireChat(path);
  return path;
}

test("a chat lists its checkout's modes, broken one included, all off", async () => {
  const path = await newChat();
  const r = await get(path);
  assert.deepEqual(r.project, { root: repo, name: repo.split("/").at(-1) });
  assert.equal("projectModes" in r, false, "nothing on: absent");
  assert.deepEqual(r.projectMinors?.map((m) => [m.id, !!m.problem, !!m.needsApproval]), [["plain", false, false], ["rel", false, true], ["broken", true, false]]);
  assert.deepEqual(r.projectMinors?.find((m) => m.id === "rel")?.tools, [{ name: "status", description: "Shows the status", command: ["./status.sh"] }]);
});

test("a chat in a folder with no project modes gets no project fields, in GET and in a POST reply", async () => {
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "sova-project-modes-none-")));
  process.on("exit", () => rmSync(plain, { recursive: true, force: true }));
  const res = await app.request("/api/sessions", { method: "POST", headers: json, body: JSON.stringify({ cwd: plain }) });
  const { path } = (await res.json()) as { path: string };
  await acquireChat(path);
  const keys = (o: object) => Object.keys(o).filter((k) => k.startsWith("project"));
  assert.deepEqual(keys(await get(path)), []);
  const r = await post(path, { minorModes: ["spec"] });
  assert.equal(r.status, 200);
  assert.deepEqual(keys((await r.json()) as object), []);
});

test("on and off; tools need the exact approval; broken and unknown refuse; nothing reaches the default", async () => {
  const path = await newChat();
  let res = await post(path, { projectModes: ["plain"] });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(((await res.json()) as ChatModeResult).projectModes, ["plain"]);

  res = await post(path, { projectModes: ["plain", "rel"] });
  assert.equal(res.status, 409);
  const ask = (await res.json()) as ProjectModeApprovalNeeded;
  assert.deepEqual(Object.keys(ask).sort(), ["error", "needsApproval"]);
  const hash = ask.needsApproval[0]!.toolsHash!;
  assert.deepEqual((await get(path)).projectModes, ["plain"], "nothing switched");

  res = await post(path, { projectModes: ["plain", "rel"], approve: [{ id: "rel", hash: "0".repeat(64) }] });
  assert.equal(res.status, 409, "a hash the user didn't see approves nothing");
  res = await post(path, { projectModes: ["plain", "rel"], approve: [{ id: "rel", hash }] });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(((await res.json()) as ChatModeResult).projectModes, ["plain", "rel"]);
  assert.deepEqual(approvalsOf(repo, "rel").map((a) => [a.hash, a.by]), [[hash, "user"]]);
  assert.ok(approvalsFile().startsWith(dir), "the store is in the state root, outside the repo");

  assert.equal((await post(path, { projectModes: ["plain", "rel", "broken"] })).status, 409);
  assert.equal((await post(path, { projectModes: ["nope"] })).status, 409);

  res = await post(path, { saveDefault: true });
  assert.equal(res.status, 200, await res.clone().text());
  assert.ok(!readFileSync(join(dir, "mode.json"), "utf8").includes("plain"), "save as default stores no project mode");
  assert.equal((await app.request("/api/mode", { method: "POST", headers: json, body: JSON.stringify({ projectModes: ["plain"] }) })).status, 400);

  res = await post(path, { projectModes: [] });
  assert.equal(res.status, 200);
  assert.equal("projectModes" in ((await res.json()) as ChatModeResult), false, "all off: absent");
});

test("an edit shows as changed; a deleted mode stays on as removed until turned off", async () => {
  const path = await newChat();
  assert.equal((await post(path, { projectModes: ["plain"] })).status, 200);
  writeFileSync(join(modes, "plain", "MODE.md"), "---\ndescription: Plain words, edited\n---\nSay hello first.\n");
  let row = (await get(path)).projectMinors?.find((m) => m.id === "plain");
  assert.equal(row?.changed, true);
  assert.equal(row?.description, "Plain words", "the menu shows the copy the chat runs");
  rmSync(join(modes, "plain"), { recursive: true });
  const r = await get(path);
  row = r.projectMinors?.find((m) => m.id === "plain");
  assert.deepEqual(r.projectModes, ["plain"]);
  assert.equal(row?.removed, true);
  const res = await post(path, { projectModes: [] });
  assert.equal(res.status, 200, "off is always allowed");
  assert.equal("projectModes" in ((await res.json()) as ChatModeResult), false, "all off: absent");
  mode("plain", "---\ndescription: Plain words\n---\nSay hello first.\n");
});

test("the Overseer's own turn-on counts as approval; a body can't claim to be it", async () => {
  await ensureOverseer();
  mode("rel2", '---\ndescription: More checks\ntools: [{"name": "go", "description": "Goes", "command": ["./go.sh"]}]\n---\nGo.\n', { "go.sh": "#!/bin/sh\necho go\n" });
  const path = await newChat();
  assert.equal((await post(path, { projectModes: ["rel2"], approvedBy: "overseer" })).status, 409);
  assert.equal((await post(path, { projectModes: ["rel2"] }, { [OVERSEER_SENDER_HEADER]: "not-the-secret" })).status, 409);
  const res = await post(path, { projectModes: ["rel2"] }, { [OVERSEER_SENDER_HEADER]: senderSecret() });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(((await res.json()) as ChatModeResult).projectModes, ["rel2"]);
  assert.deepEqual(approvalsOf(repo, "rel2").map((a) => a.by), ["overseer"]);
  assert.ok(existsSync(approvalsFile()));
});
