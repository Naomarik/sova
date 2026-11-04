// Run: pnpm test -- server/mcp/mcp.test.ts. The rules of MCP servers that need no process: reading an
// entry, what a value may name, the version approved, trust, secrets, a row's state and a chat's list.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

const root = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mcp-unit-")));
const agent = join(root, "agent");
const saved = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agent;

const { normalizeEntry, putComputerEntry, readMcpFile, readComputerList, reservedName } = await import("./config");
const { fillValues, namedValues, unpinned } = await import("./values");
const { versionOf } = await import("./fingerprint");
const { approve, approvedVersions, forgetApprovals, isApproved, MCP_VERSIONS_KEPT } = await import("./trust");
const { mcpSecretsDir, readSecret, removeServerSecrets, saveSecret, secretValues, withoutSecrets } = await import("./saved-values");
const { changeRow, saveCheck, saveFailedCheck } = await import("./store");
const { readyToRun, refusalOf, secretNames } = await import("./resolve");
const { rowOfEntry, rowState } = await import("./rows");
const { chatListOf, setupOf, workerListOf } = await import("./list");
const { parseRowId, rowId } = await import("./ids");

const computer = { kind: "computer" } as const;
const record = (...tools: string[]) => ({ protocolVersion: "1", serverInfo: { name: "s", version: "1" }, tools: tools.map((name) => ({ name, description: `d ${name}`, inputSchema: { type: "object" } })) });
const list = (dir: string, servers: unknown) => writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
const ready = (owner: typeof computer | { kind: "project"; projectId: string; checkout: string }, name: string, raw: unknown, tools = ["t"]) => {
  const e = normalizeEntry(name, raw, owner.kind === "computer" ? "computer" : "project");
  const base = owner.kind === "computer" ? agent : owner.checkout;
  approve(owner, name, versionOf(e, base));
  saveCheck(owner, name, versionOf(e, base), record(...tools));
  return e;
};
let n = 0;
const checkout = () => {
  const dir = join(root, `checkout-${++n}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

before(() => mkdirSync(agent, { recursive: true }));
beforeEach(() => {
  rmSync(join(agent, "mcp.json"), { force: true });
  rmSync(join(agent, "sova"), { recursive: true, force: true });
});
after(() => {
  if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = saved;
  rmSync(root, { recursive: true, force: true });
});

describe("reading an entry", () => {
  test("a project's .mcp.json in the shape other tools write; a broken file says why and gives none", () => {
    const dir = checkout();
    list(dir, { a: { command: "x", args: ["1"], env: { K: "v" } }, b: { type: "http", url: "https://e/mcp", headers: { H: "v" } } });
    const f = readMcpFile(join(dir, ".mcp.json"), "project");
    assert.deepEqual(f.entries.map((e) => [e.name, e.kind]), [["a", "command"], ["b", "address"]]);
    writeFileSync(join(dir, ".mcp.json"), "{nope");
    const broken = readMcpFile(join(dir, ".mcp.json"), "project");
    assert.equal(broken.file, "broken");
    assert.deepEqual(broken.entries, []);
    assert.equal(readMcpFile(join(dir, "none.json"), "project").file, "missing");
  });

  test("a repository can't pick where a credential goes: auth in a project's file is refused, and kept in a computer's", () => {
    const raw = { url: "https://e", auth: { provider: "x" } };
    assert.deepEqual(refusalOf(normalizeEntry("s", raw, "project")), { why: "unusable", names: ["auth"] });
    assert.equal(refusalOf(normalizeEntry("s", raw, "computer")), undefined);
  });

  test("an unusable entry names the field; a value naming no secret stays bad-value", () => {
    assert.deepEqual(refusalOf(normalizeEntry("s", { type: "sse", url: "https://e" }, "project")), { why: "unusable", names: ["type: sse"] });
    assert.deepEqual(refusalOf(normalizeEntry("s", {}, "project")), { why: "unusable", names: ["no command or url"] });
    assert.deepEqual(refusalOf(normalizeEntry("s", { command: "c", env: { K: "${X:-y}" } }, "project")), { why: "bad-value", names: ["X:-y"] });
  });

  test("sova is reserved in any case, in a file too, and only that name", () => {
    for (const name of ["sova", "SOVA", "SoVa"]) {
      assert.equal(reservedName(name), true);
      assert.deepEqual(refusalOf(normalizeEntry(name, { command: "x" }, "project")), { why: "reserved" });
    }
    assert.equal(reservedName("sova-x"), false);
  });

  test("a save keeps what else the file holds, and a hand-written server beside it", () => {
    writeFileSync(join(agent, "mcp.json"), JSON.stringify({ autoEnableCodemode: false, mcpServers: { hand: { command: "h" } } }));
    putComputerEntry(normalizeEntry("mine", { command: "m", args: ["a"] }, "computer"));
    const doc = JSON.parse(readFileSync(join(agent, "mcp.json"), "utf8"));
    assert.equal(doc.autoEnableCodemode, false);
    assert.deepEqual(Object.keys(doc.mcpServers), ["hand", "mine"]);
    assert.deepEqual(doc.mcpServers.mine, { command: "m", args: ["a"] });
    assert.equal(readComputerList().entries.length, 2);
  });
});

describe("what a value may name", () => {
  test("${NAME} is the one form; anything else in it is no name, and $(cmd) and !cmd stay literal", () => {
    const e = normalizeEntry("s", { command: "c", args: ["${A}", "$(x)", "!touch y"], env: { B: "pre-${B}", C: "${X:-y}" } }, "project");
    assert.deepEqual(namedValues(e), { names: ["A", "B"], bad: ["X:-y"] });
    const { entry, missing } = fillValues(e, (n) => (n === "A" ? "1" : undefined));
    assert.deepEqual(entry.args, ["1", "$(x)", "!touch y"]);
    assert.deepEqual(missing, ["B", "X:-y"]);
  });

  test("in a project's file every name is a secret of that row, even one the environment holds", () => {
    const owner = { kind: "project", projectId: "p", checkout: checkout() } as const;
    const e = normalizeEntry("s", { command: "c", env: { T: "${HOME}" } }, "project");
    assert.deepEqual(secretNames(owner, e, { HOME: "/h" }), ["HOME"]);
    assert.deepEqual(secretNames(computer, e, { HOME: "/h" }), [], "a computer entry may name an environment variable");
  });

  test("a project's value never takes Sova's environment: the server can't start, and says which", () => {
    const dir = checkout();
    const owner = { kind: "project", projectId: "p", checkout: dir } as const;
    list(dir, { s: { command: "c", env: { T: "${SOVA_TOKEN}" } } });
    approve(owner, "s", versionOf(normalizeEntry("s", { command: "c", env: { T: "${SOVA_TOKEN}" } }, "project"), dir));
    const r = readyToRun(owner, "s", { SOVA_TOKEN: "leak" });
    assert.deepEqual(r, { ok: false, how: "failed", reason: "SOVA_TOKEN isn't saved yet" });
    saveSecret(owner, "s", "SOVA_TOKEN", "mine");
    const after = readyToRun(owner, "s", { SOVA_TOKEN: "leak" });
    assert.ok(after.ok && after.entry.env?.T === "mine");
  });

  test("a package runner with no pinned version is unpinned; a pinned one isn't", () => {
    const u = (command: string, ...args: string[]) => unpinned(normalizeEntry("s", { command, args }, "computer"));
    assert.equal(u("npx", "-y", "@scope/pkg"), true);
    assert.equal(u("npx", "-y", "@scope/pkg@1.2.3"), false);
    assert.equal(u("npx", "-y", "pkg@latest"), true);
    assert.equal(u("uvx", "tool==1.0"), false);
    assert.equal(u("pnpm", "dlx", "pkg"), true);
    assert.equal(u("node", "server.js"), false);
  });
});

describe("the version approved", () => {
  test("any change to the entry, or to a file in a ./ path's folder, is a new version; another folder's isn't", () => {
    const dir = checkout();
    mkdirSync(join(dir, "tool", "lib"), { recursive: true });
    mkdirSync(join(dir, "other"));
    writeFileSync(join(dir, "tool", "run.js"), "1");
    writeFileSync(join(dir, "tool", "lib", "helper.js"), "1");
    writeFileSync(join(dir, "other", "x"), "1");
    const e = normalizeEntry("s", { command: "node", args: ["./tool/run.js"] }, "project");
    const v0 = versionOf(e, dir);
    assert.equal(versionOf(e, dir), v0, "the same on a second read");
    assert.notEqual(versionOf({ ...e, args: ["./tool/run.js", "--x"] }, dir), v0);
    writeFileSync(join(dir, "other", "x"), "2");
    assert.equal(versionOf(e, dir), v0);
    writeFileSync(join(dir, "tool", "lib", "helper.js"), "2");
    assert.notEqual(versionOf(e, dir), v0, "a helper beside the script is covered");
  });

  test("the newest 8 versions stay approved, each checkout's its own", () => {
    const a = { kind: "project", projectId: "p", checkout: "/a" } as const;
    const b = { kind: "project", projectId: "p", checkout: "/b" } as const;
    for (let i = 0; i < MCP_VERSIONS_KEPT + 2; i++) approve(a, "s", `v${i}`);
    assert.equal(approvedVersions(a, "s").length, MCP_VERSIONS_KEPT);
    assert.equal(isApproved(a, "s", "v9"), true);
    assert.equal(isApproved(a, "s", "v5"), true);
    assert.equal(isApproved(a, "s", "v1"), false);
    assert.equal(isApproved(b, "s", "v9"), false, "a worktree's identical copy is approved separately");
    assert.equal(isApproved(computer, "s", "v9"), false);
    forgetApprovals(a, "s");
    assert.equal(isApproved(a, "s", "v9"), false);
  });

  test("a start checks the approval again: an entry changed since starts nothing", () => {
    const e = ready(computer, "s", { command: "c" });
    putComputerEntry(e);
    assert.equal(readyToRun(computer, "s").ok, true);
    putComputerEntry({ ...e, args: ["--evil"] });
    assert.deepEqual(readyToRun(computer, "s"), { ok: false, how: "changed", reason: "it changed and is waiting for your approval" });
  });
});

describe("secrets", () => {
  test("files only the owner reads; a row's secret isn't another's; every checkout of a project shares it", () => {
    const one = { kind: "project", projectId: "p", checkout: "/one" } as const;
    const two = { kind: "project", projectId: "p", checkout: "/two" } as const;
    saveSecret(one, "s", "K", "v-1");
    assert.equal(statSync(mcpSecretsDir()).mode & 0o777, 0o700);
    for (const f of readdirSync(mcpSecretsDir())) assert.equal(statSync(join(mcpSecretsDir(), f)).mode & 0o777, 0o600);
    assert.equal(readSecret(two, "s", "K"), "v-1");
    assert.equal(readSecret({ kind: "project", projectId: "other", checkout: "/one" }, "s", "K"), undefined);
    assert.equal(readSecret(computer, "s", "K"), undefined);
    assert.equal(readSecret(one, "other", "K"), undefined);
    removeServerSecrets(one, "s");
    assert.equal(readSecret(one, "s", "K"), undefined);
  });

  test("a row carries a secret's name and presence and never its value, in its error lines neither", () => {
    const e = ready(computer, "s", { command: "c", env: { K: "${K}" } });
    putComputerEntry(e);
    saveSecret(computer, "s", "K", "hunter2-value");
    saveFailedCheck(computer, "s", versionOf(e, agent), ["auth failed for hunter2-value"]);
    const row = rowOfEntry(computer, e);
    assert.deepEqual(row.secrets, [{ name: "K", saved: true }]);
    assert.ok(!JSON.stringify(row).includes("hunter2-value"), "the value left through a row");
    assert.equal(withoutSecrets("x hunter2-value y", secretValues(computer, "s")), "x [secret] y");
  });
});

describe("a row's state", () => {
  test("the first that applies, in the table's order", () => {
    const row = (over: object) => ({ settings: { newChats: true, offTools: [] }, versions: [{ version: "v", record: record("t"), at: 1 }], ...over }) as never;
    assert.equal(rowState(false, row({}), "v"), "waiting");
    assert.equal(rowState(true, row({ settings: { newChats: false, offTools: [] } }), "v"), "off");
    assert.equal(rowState(true, row({ last: { at: 1, ok: false, version: "v", errors: [], needsSignIn: true } }), "v"), "needs-sign-in");
    assert.equal(rowState(true, row({ last: { at: 1, ok: false, version: "v", errors: [] } }), "v"), "failed");
    assert.equal(rowState(true, row({ last: { at: 1, ok: true, version: "v", errors: [] } }), "v"), "connected");
    assert.equal(rowState(true, row({ versions: [] }), "v"), "no-check");
    assert.equal(rowState(true, row({ last: { at: 1, ok: false, version: "old", errors: [] } }), "v"), "connected", "another version's failure isn't this one's");
  });

  test("a failed Check keeps the record that version had; a changed entry has none until its Check", () => {
    const e = ready(computer, "s", { command: "c" }, ["keep"]);
    const v = versionOf(e, agent);
    saveFailedCheck(computer, "s", v, ["boom"]);
    assert.deepEqual(rowOfEntry(computer, e).tools.map((t) => t.name), ["keep"]);
    assert.equal(rowOfEntry(computer, e).state, "failed");
    const changed = { ...e, args: ["--new"] };
    const row = rowOfEntry(computer, changed);
    assert.equal(row.toolCount, 0);
    assert.equal(row.state, "waiting");
    assert.equal(row.changed, true);
  });

  test("a row id is opaque and reads back; a stranger's isn't one", () => {
    const ref = { owner: { kind: "project", projectId: "p", checkout: "/c" } as const, name: "s" };
    assert.deepEqual(parseRowId(rowId(ref)), ref);
    assert.match(rowId(ref), /^[A-Za-z0-9_-]+$/);
    for (const bad of ["", "abc", Buffer.from('["x"]').toString("base64url")]) assert.equal(parseRowId(bad), null);
  });
});

describe("a chat's list", () => {
  const noProject = () => ({ project: null, checkout: checkout() });

  test("only approved servers with a record; a waiting one and an unchecked one say why", () => {
    const a = ready(computer, "good", { command: "c" });
    putComputerEntry(a);
    putComputerEntry(normalizeEntry("waiting", { command: "w" }, "computer"));
    const unchecked = normalizeEntry("unchecked", { command: "u" }, "computer");
    putComputerEntry(unchecked);
    approve(computer, "unchecked", versionOf(unchecked, agent));
    const folder = noProject();
    assert.deepEqual(chatListOf(folder, {}, false).servers.map((s) => s.name), ["good"]);
    const rows = setupOf(folder, {}, false)!.rows;
    assert.deepEqual(rows.map((r) => [r.name, r.on, r.off]), [["good", true, undefined], ["waiting", false, "waiting"], ["unchecked", false, "no-check"]]);
  });

  test("the tools switched off are left out, and the card's cost counts what's on", () => {
    const e = ready(computer, "s", { command: "c" }, ["a", "b"]);
    putComputerEntry(e);
    const folder = noProject();
    const all = setupOf(folder, {}, false)!.rows[0]!.tokens!;
    changeRow(computer, "s", (r) => void (r.settings.offTools = ["b"]));
    assert.deepEqual(chatListOf(folder, {}, false).servers[0]!.record.tools.map((t) => t.name), ["a"]);
    assert.ok(setupOf(folder, {}, false)!.rows[0]!.tokens! < all);
  });

  test("New Chats sets where a server starts, and a chat's own flip wins either way", () => {
    putComputerEntry(ready(computer, "a", { command: "a" }));
    putComputerEntry(ready(computer, "b", { command: "b" }));
    changeRow(computer, "b", (r) => void (r.settings.newChats = false));
    const folder = noProject();
    assert.deepEqual(chatListOf(folder, {}, false).servers.map((s) => s.name), ["a"]);
    assert.deepEqual(chatListOf(folder, { offMcp: ["a"], onMcp: ["b"] }, false).servers.map((s) => s.name), ["b"]);
  });

  test("the project's server wins its name in its folder, even waiting; elsewhere the computer's works", () => {
    putComputerEntry(ready(computer, "same", { command: "computer" }));
    const dir = checkout();
    list(dir, { same: { command: "project" } });
    const inside = { project: { id: "p", name: "P", root: dir }, checkout: dir };
    assert.deepEqual(chatListOf(inside, {}, false).servers, [], "the computer's doesn't stand in");
    const rows = setupOf(inside, {}, false)!.rows;
    assert.deepEqual(rows.map((r) => [r.name, r.source, r.off]), [["same", "project", "waiting"]]);
    assert.equal(chatListOf({ project: null, checkout: checkout() }, {}, false).servers[0]!.owner.kind, "computer");
  });

  test("a folder that is no project runs nothing of its .mcp.json, and the card says so", () => {
    const dir = checkout();
    list(dir, { x: { command: "x" } });
    const folder = { project: null, checkout: dir };
    assert.deepEqual(chatListOf(folder, {}, false).servers, []);
    assert.equal(setupOf(folder, {}, false)!.notProject, true);
  });

  test("no servers and no file: no group", () => assert.equal(setupOf(noProject(), {}, false), undefined));

  test("address servers don't reach a chat yet, and say so", () => {
    putComputerEntry(ready(computer, "site", { url: "https://e/mcp" }));
    const folder = noProject();
    assert.deepEqual(chatListOf(folder, {}, false).servers, []);
    assert.equal(setupOf(folder, {}, false)!.rows[0]!.off, "address-in-chat");
  });

  test("a worker's list is capped to the chat's own, its tools as trimmed there; a stranger's name is refused", () => {
    putComputerEntry(ready(computer, "a", { command: "a" }, ["x", "y"]));
    putComputerEntry(ready(computer, "b", { command: "b" }));
    changeRow(computer, "a", (r) => void (r.settings.offTools = ["y"]));
    const own = chatListOf(noProject(), { offMcp: ["b"] }, false);
    const given = workerListOf(own, ["a"], "Chat");
    assert.ok("list" in given);
    assert.deepEqual(given.list.servers[0]!.record.tools.map((t) => t.name), ["x"]);
    assert.deepEqual(workerListOf(own, ["b"], "Chat"), { refused: "Chat's servers are a, so a worker can't have b." });
    assert.deepEqual(workerListOf({ v: 1, servers: [] }, ["b"], "Chat"), { refused: "Chat's servers are none, so a worker can't have b." });
  });
});
