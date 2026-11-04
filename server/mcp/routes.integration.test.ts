// Run: node scripts/run-tests.mjs --integration server/mcp/routes.integration.test.ts. The MCP routes against the real
// app: real Check child processes, a real stub server, a stub OAuth service. Only the page writes.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { McpServerRow, McpServers, McpSignIn } from "../../shared/mcp";
import { startOAuthServer } from "./testing/oauth-stub.fixture";
import { startAddressStub } from "../harness/pi/testing/mcp-http-stub.fixture";

const root = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mcp-routes-")));
const agent = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agent;
process.env.SOVA_CANARY = "canary-7f";
mkdirSync(join(agent, "sessions", "live"), { recursive: true });

const { testApp } = await import("../mesh/app-test-fixtures");
const app = await testApp();
const { readSecret, saveSecret, mcpSecretsDir } = await import("./saved-values");
const { currentEntry } = await import("./resolve");
const computer = { kind: "computer" } as const;
const { computerListPath } = await import("./config");

after(() => rmSync(root, { recursive: true, force: true }));

const STUB = join(import.meta.dirname, "..", "harness", "pi", "testing", "mcp-stub.fixture.mjs");
const node = process.execPath.includes("bun") ? "node" : process.execPath;
const { pageHeaders } = await import("../testing/page");
// The operator's own page shows itself with the install's cookie (server/page-only.ts).
const page = { "content-type": "application/json", host: "127.0.0.1:4800", ...pageHeaders() };
const ask = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await app.request(path, { method, headers: { ...page, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as never };
};
const addStub = async (name: string, log = join(root, `${name}.log`), flags = "") =>
  (await ask("POST", "/api/mcp/servers", { way: "command", name, command: `${node} ${STUB} --name ${name} --log ${log} --tools one,two ${flags}` })).json as McpServerRow;
const lines = (log: string): { event: string; [k: string]: unknown }[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const handWrite = (servers: unknown) => {
  const doc = existsSync(computerListPath()) ? JSON.parse(readFileSync(computerListPath(), "utf8")) : { mcpServers: {} };
  writeFileSync(computerListPath(), JSON.stringify({ mcpServers: { ...doc.mcpServers, ...(servers as object) } }));
};
const row = async (name: string) => ((await ask("GET", "/api/mcp/servers")).json as McpServers).servers.find((s) => s.name === name)!;

describe("adding a server", () => {
  test("Add and Check saves it, approves it and records what a Check found, in the clean environment", async () => {
    const log = join(root, "added.log");
    const r = await addStub("added", log);
    assert.equal(r.state, "connected", JSON.stringify(r.errors));
    assert.deepEqual(r.tools.map((t) => t.name), ["one", "two"]);
    assert.ok(r.tools.every((t) => t.tokens > 0 && t.on));
    assert.equal(r.toolCount, 2);
    const start = lines(log).find((l) => l.event === "start")!;
    assert.equal(start.canary, null, "Sova's environment reached the Check");
    assert.deepEqual((start.envKeys as string[]).filter((k) => /^(SOVA|PI_|BUN_)/.test(k)), []);
    assert.ok(lines(log).some((l) => l.event === "stdin-closed"), "the Check stopped it");
    assert.ok(lines(log).some((l) => l.event === "rpc" && l.method === "tools/list"));
  });

  test("a failed Check is still 200: Failed, with the server's own lines", async () => {
    const r = (await ask("POST", "/api/mcp/servers", { way: "command", name: "dead", command: `${node} -e "console.error('boom: no key');process.exit(1)"` })).json as McpServerRow;
    assert.equal(r.state, "failed");
    assert.match(r.errors.map((e) => e.line).join("\n"), /boom: no key/);
  });

  test("sova is refused in any case, with the deck's sentence, and writes nothing", async () => {
    for (const name of ["sova", "SOVA"]) {
      const { status, json } = await ask("POST", "/api/mcp/servers", { way: "command", name, command: "x" });
      assert.equal(status, 400);
      assert.deepEqual(json, { error: "The name sova is Sova's own. Pick another.", code: "reserved" });
    }
    assert.equal(await row("sova"), undefined);
  });

  test("a name already taken is refused", async () => {
    await addStub("twice");
    const { status, json } = await ask("POST", "/api/mcp/servers", { way: "command", name: "twice", command: "x" });
    assert.equal(status, 409);
    assert.equal((json as { code: string }).code, "exists");
  });

  test("a pasted entry from another tool, alone or under mcpServers", async () => {
    const entry = { command: node, args: [STUB, "--name", "p"] };
    const one = (await ask("POST", "/api/mcp/servers", { way: "paste", name: "pasted", text: JSON.stringify(entry) })).json as McpServerRow;
    const two = (await ask("POST", "/api/mcp/servers", { way: "paste", name: "pasted2", text: JSON.stringify({ mcpServers: { other: entry } }) })).json as McpServerRow;
    assert.equal(one.state, "connected");
    assert.equal(two.state, "connected");
    const bad = await ask("POST", "/api/mcp/servers", { way: "paste", name: "x", text: "{nope" });
    assert.equal(bad.status, 400);
  });

  test("a paste of several servers needs a Name that's one of them; refused, it adds nothing", async () => {
    const one = { command: node, args: [STUB, "--name", "first"] };
    const two = { command: node, args: [STUB, "--name", "second"] };
    const text = JSON.stringify({ mcpServers: { alpha: one, beta: two } });
    const { status, json } = await ask("POST", "/api/mcp/servers", { way: "paste", name: "gamma", text });
    assert.equal(status, 400);
    assert.deepEqual(json, { error: "This paste has alpha, beta, and none is named gamma. Use one of those names.", code: "invalid" });
    assert.equal(await row("gamma"), undefined);
    const picked = (await ask("POST", "/api/mcp/servers", { way: "paste", name: "beta", text })).json as McpServerRow;
    assert.match(picked.entry.runs ?? "", /--name second/, "a Name that matches takes that one");
  });

  test("the Address secret is a Bearer header; the row holds its name, never its value", async () => {
    const r = (await ask("POST", "/api/mcp/servers", { way: "address", name: "addr", address: "http://127.0.0.1:9/mcp", secret: "hunter2-secret" })).json as McpServerRow;
    assert.deepEqual(r.secrets, [{ name: "API_KEY", saved: true }]);
    assert.equal(r.signsIn, false, "it has its own Authorization");
    assert.ok(!JSON.stringify(r).includes("hunter2-secret"));
    assert.ok(!readFileSync(computerListPath(), "utf8").includes("hunter2-secret"), "the value is in the list");
    assert.equal(statSync(mcpSecretsDir()).mode & 0o777, 0o700);
  });

  test("the Command secret reaches the server under its own name, and only it", async () => {
    const log = join(root, "secret.log");
    const r = (await ask("POST", "/api/mcp/servers", { way: "command", name: "keyed", secret: "s3cret", secretName: "MY_KEY", command: `${node} ${STUB} --name keyed --log ${log}` })).json as McpServerRow;
    assert.equal(r.state, "connected");
    assert.deepEqual(r.secrets, [{ name: "MY_KEY", saved: true }]);
    assert.ok((lines(log)[0]!.envKeys as string[]).includes("MY_KEY"));
  });
});

describe("approving", () => {
  test("a hand-written entry waits and runs nothing: not a Check, not a sign-in", async () => {
    const log = join(root, "hand.log");
    handWrite({ hand: { command: node, args: [STUB, "--name", "hand", "--log", log] } });
    const r = await row("hand");
    assert.equal(r.state, "waiting");
    assert.equal(r.entry.runs, `${node} ${STUB} --name hand --log ${log}`);
    assert.equal(((await ask("POST", `/api/mcp/rows/${r.id}/check`)).json as McpServerRow).state, "waiting");
    assert.equal((await ask("POST", `/api/mcp/rows/${r.id}/sign-in`)).status, 409);
    assert.equal(existsSync(log), false, "a server not approved ran");
  });

  test("approve carries what the page showed: a changed entry is refused with the deck's sentence and its new row", async () => {
    const log = join(root, "stale.log");
    handWrite({ stale: { command: node, args: [STUB, "--name", "stale", "--log", log] } });
    const shown = await row("stale");
    handWrite({ stale: { command: node, args: [STUB, "--name", "stale", "--log", log, "--extra"] } });
    const { status, json } = await ask("POST", `/api/mcp/rows/${shown.id}/approve`, { version: shown.entry.version });
    const answer = json as { error: string; code: string; row: McpServerRow };
    assert.equal(status, 409);
    assert.equal(answer.error, "This server changed since you looked. Check what it runs, then approve it again.");
    assert.equal(answer.code, "changed");
    assert.notEqual(answer.row.entry.version, shown.entry.version);
    assert.equal(existsSync(log), false);
    const ok = (await ask("POST", `/api/mcp/rows/${shown.id}/approve`, { version: answer.row.entry.version })).json as McpServerRow;
    assert.equal(ok.state, "connected", "approving runs a Check");
    assert.deepEqual(ok.tools.map((t) => t.name), ["echo", "appeared_after_check"]);
  });

  test("an approved server that changes asks again; going back to the approved version needs no new approval", async () => {
    await addStub("flip");
    const doc = JSON.parse(readFileSync(computerListPath(), "utf8"));
    const was = doc.mcpServers.flip;
    handWrite({ flip: { ...was, args: [...was.args, "--extra"] } });
    const changed = await row("flip");
    assert.equal(changed.state, "waiting");
    assert.equal(changed.changed, true);
    handWrite({ flip: was });
    assert.equal((await row("flip")).state, "connected");
  });

  test("a reserved entry in the list is offered no approval", async () => {
    handWrite({ Sova: { command: "x" } });
    const r = await row("Sova");
    assert.deepEqual(r.refused, { why: "reserved" });
    const { status, json } = await ask("POST", `/api/mcp/rows/${r.id}/approve`, { version: r.entry.version });
    assert.equal(status, 409);
    assert.equal((json as { code: string }).code, "reserved");
  });
});

describe("only the page changes a server", () => {
  const callers: [string, Record<string, string>][] = [
    ["a script holding the token", { "x-sova-token": "t" }],
    ["a chat", { "x-sova-caller": "c" }],
    ["a call that doesn't show the page", { cookie: "" }],
  ];
  const APPROVE = "Only you can approve a server, on the page.";
  const SIGN_IN = "Only you can sign in to a server, on the page.";
  const CHANGE = "Only you can change a server, on the page.";
  const writes = (id: string): [string, string, string, unknown?][] => [
    [APPROVE, "POST", "/api/mcp/servers", { way: "command", name: "x", command: "x" }],
    [APPROVE, "PUT", `/api/mcp/rows/${id}`, { command: "x" }],
    [APPROVE, "POST", `/api/mcp/rows/${id}/approve`, { version: "v" }],
    [CHANGE, "DELETE", `/api/mcp/rows/${id}`],
    [CHANGE, "PATCH", `/api/mcp/rows/${id}`, { newChats: false }],
    [CHANGE, "POST", `/api/mcp/rows/${id}/check`],
    [CHANGE, "PUT", `/api/mcp/rows/${id}/secrets/K`, { value: "v" }],
    [CHANGE, "DELETE", `/api/mcp/rows/${id}/secrets/K`],
    [SIGN_IN, "POST", `/api/mcp/rows/${id}/sign-in`],
    [SIGN_IN, "GET", `/api/mcp/rows/${id}/sign-in`],
    [SIGN_IN, "POST", `/api/mcp/rows/${id}/sign-in/address`, { address: "x" }],
    [SIGN_IN, "DELETE", `/api/mcp/rows/${id}/sign-in`],
  ];

  test("every write is refused to everyone else, with code page-only", async () => {
    const r = await addStub("guarded");
    for (const [who, headers] of callers)
      for (const [sentence, method, path, body] of writes(r.id)) {
        const { status, json } = await ask(method, path, body, headers);
        assert.equal(status, 403, `${who}: ${method} ${path}`);
        assert.deepEqual(json, { error: sentence, code: "page-only" }, `${who}: ${method} ${path}`);
      }
    assert.equal((await row("guarded")).state, "connected");
  });

  test("reads are open, and a read names no secret's value", async () => {
    const r = await addStub("readable");
    const { status, json } = await ask("GET", `/api/mcp/rows/${r.id}`, undefined, { "x-sova-caller": "c" });
    assert.equal(status, 200);
    assert.equal((json as McpServerRow).name, "readable");
    assert.equal((await ask("GET", "/api/mcp/rows/not-an-id")).status, 404);
  });

  test("an id that points at a checkout no project has reads nothing", async () => {
    const dir = join(root, "stranger");
    mkdirSync(dir);
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { x: { command: "x" } } }));
    const id = Buffer.from(JSON.stringify(["p", "prj_none", dir, "x"])).toString("base64url");
    assert.equal((await ask("GET", `/api/mcp/rows/${id}`)).status, 404);
  });
});

describe("a row's switches, secrets, Edit and Remove", () => {
  test("New Chats and a tool's switch save at once; a tool's survives an Edit", async () => {
    const r = await addStub("switches");
    assert.equal(((await ask("PATCH", `/api/mcp/rows/${r.id}`, { newChats: false })).json as McpServerRow).state, "off");
    await ask("PATCH", `/api/mcp/rows/${r.id}`, { newChats: true });
    const off = (await ask("PATCH", `/api/mcp/rows/${r.id}`, { tool: "two", on: false })).json as McpServerRow;
    assert.deepEqual(off.tools.map((t) => [t.name, t.on]), [["one", true], ["two", false]]);
    const edited = (await ask("PUT", `/api/mcp/rows/${r.id}`, { command: `${node} ${STUB} --name switches --tools one,two,three` })).json as McpServerRow;
    assert.deepEqual(edited.tools.map((t) => [t.name, t.on]), [["one", true], ["two", false], ["three", true]], "kept by name; a new tool is on");
  });

  test("an unchanged Edit keeps everything it doesn't touch: every env key, cwd and a spaced argument", async () => {
    const entry = { command: node, args: [STUB, "--name", "two words", "--tools", "one"], env: { FOO: "bar", TOKEN: "${MY_KEY}" }, cwd: root, timeout: 30 };
    const r = (await ask("POST", "/api/mcp/servers", { way: "paste", name: "kept", text: JSON.stringify(entry) })).json as McpServerRow;
    const before = currentEntry(computer, "kept");
    assert.ok(r.edit?.command?.includes('"two words"'), r.edit?.command);
    const { status, json } = await ask("PUT", `/api/mcp/rows/${r.id}`, r.edit);
    assert.equal(status, 200, JSON.stringify(json));
    assert.deepEqual(currentEntry(computer, "kept"), before);
    assert.deepEqual(JSON.parse(readFileSync(computerListPath(), "utf8")).mcpServers.kept, entry);
  });

  test("an Edit changes only what it names: the command, or the secret its entry already names", async () => {
    const entry = { command: node, args: [STUB, "--name", "a"], env: { FOO: "bar", TOKEN: "${MY_KEY}" } };
    const r = (await ask("POST", "/api/mcp/servers", { way: "paste", name: "changed", text: JSON.stringify(entry) })).json as McpServerRow;
    await ask("PUT", `/api/mcp/rows/${r.id}`, { command: `${node} ${STUB} --name b`, secretName: r.edit?.secretName, secret: "new-value" });
    const after = currentEntry(computer, "changed")!;
    assert.deepEqual(after.args, [STUB, "--name", "b"]);
    assert.deepEqual(after.env, entry.env, "${MY_KEY} stays, and FOO");
    assert.equal(readSecret(computer, "changed", "MY_KEY"), "new-value");
    assert.equal(readSecret(computer, "changed", "TOKEN"), undefined);
  });

  test("an address Edit keeps its oauth and its headers", async () => {
    const entry = { url: "http://127.0.0.1:9/mcp", headers: { "X-Api": "${HDR_KEY}" }, oauth: { clientId: "c", scope: "s" } };
    const r = (await ask("POST", "/api/mcp/servers", { way: "paste", name: "addr-edit", text: JSON.stringify(entry) })).json as McpServerRow;
    await ask("PUT", `/api/mcp/rows/${r.id}`, { address: "http://127.0.0.1:10/mcp", secret: "hdr-value" });
    const after = currentEntry(computer, "addr-edit")!;
    assert.equal(after.url, "http://127.0.0.1:10/mcp");
    assert.deepEqual(after.oauth, entry.oauth);
    assert.deepEqual(after.headers, entry.headers);
    assert.equal(readSecret(computer, "addr-edit", "HDR_KEY"), "hdr-value");
  });

  test("a sign-in stays with its address: an Edit that moves one forgets the old address's, and Remove the new one's", async () => {
    const [before, after, other] = ["http://127.0.0.1:9/mcp", "http://127.0.0.1:10/mcp", "http://127.0.0.1:11/mcp"];
    const r = (await ask("POST", "/api/mcp/servers", { way: "address", name: "moves", address: before })).json as McpServerRow;
    const signIn = (token: string, url: string) => ({ serverUrl: url, tokens: { access_token: token, token_type: "Bearer" } });
    const file = join(agent, "mcp-auth.json");
    writeFileSync(file, JSON.stringify({ [`mcp__moves|${before}`]: signIn("token-old-address", before), "mcp__stays|http://127.0.0.1:11/mcp": signIn("token-other-server", other) }), { mode: 0o600 });
    await ask("PUT", `/api/mcp/rows/${r.id}`, { address: after });
    const moved = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    moved[`mcp__moves|${after}`] = signIn("token-new-address", after);
    assert.ok(!readFileSync(file, "utf8").includes("token-old-address"), "the Edit left the old address's sign-in");
    writeFileSync(file, JSON.stringify(moved), { mode: 0o600 });
    await ask("DELETE", `/api/mcp/rows/${r.id}`);
    const left = readFileSync(file, "utf8");
    assert.ok(!left.includes("token-old-address") && !left.includes("token-new-address"), left);
    assert.ok(left.includes("token-other-server"), "another server's sign-in stays");
  });

  test("Remove takes its approval, record, secrets and sign-in with it, and a re-add starts clean", async () => {
    const r = await addStub("gone");
    await ask("PUT", `/api/mcp/rows/${r.id}/secrets/K`, { value: "v" });
    const { servers } = (await ask("DELETE", `/api/mcp/rows/${r.id}`)).json as McpServers;
    assert.ok(!servers.some((s) => s.name === "gone"));
    assert.equal((await ask("GET", `/api/mcp/rows/${r.id}`)).status, 404);
    handWrite({ gone: JSON.parse("{\"command\":\"x\"}") });
    const back = await row("gone");
    assert.equal(back.state, "waiting");
    assert.equal(back.changed, undefined, "no approval of it is left");
    assert.equal(back.toolCount, 0);
  });

  test("a named secret with nothing saved leaves it unable to start, and its row says which", async () => {
    const log = join(root, "unsaved.log");
    handWrite({ unsaved: { command: node, args: [STUB, "--name", "u", "--log", log], env: { K: "${MISSING_KEY}" } } });
    const r = await row("unsaved");
    assert.deepEqual(r.secrets, [{ name: "MISSING_KEY", saved: false }]);
    const after = (await ask("POST", `/api/mcp/rows/${r.id}/approve`, { version: r.entry.version })).json as McpServerRow;
    assert.equal(after.state, "failed");
    assert.match(after.errors[0]!.line, /MISSING_KEY isn't saved yet/);
    assert.equal(existsSync(log), false);
    saveSecret({ kind: "computer" }, "unsaved", "MISSING_KEY", "now");
    assert.equal(((await ask("POST", `/api/mcp/rows/${r.id}/check`)).json as McpServerRow).state, "connected");
  });
});

describe("saving a secret", () => {
  test("on an approved row a Check follows, and the answer is the row after it", async () => {
    const log = join(root, "needs-key.log");
    handWrite({ needsKey: { command: node, args: [STUB, "--name", "k", "--log", log], env: { K: "${LATE_KEY}" } } });
    const r = await row("needsKey");
    const failed = (await ask("POST", `/api/mcp/rows/${r.id}/approve`, { version: r.entry.version })).json as McpServerRow;
    assert.equal(failed.state, "failed");
    const saved = (await ask("PUT", `/api/mcp/rows/${r.id}/secrets/LATE_KEY`, { value: "the-key" })).json as McpServerRow;
    assert.equal(saved.state, "connected", JSON.stringify(saved.errors));
    assert.deepEqual(saved.errors, [], "the unsaved line is gone with the Check");
    assert.deepEqual(saved.secrets, [{ name: "LATE_KEY", saved: true }]);
    assert.equal(lines(log).filter((l) => l.event === "start").length, 1);
    await ask("PUT", `/api/mcp/rows/${r.id}/secrets/LATE_KEY`, { value: "replaced" });
    assert.equal(lines(log).filter((l) => l.event === "start").length, 2, "replacing one checks again");
  });

  test("on a Waiting row it runs nothing", async () => {
    const log = join(root, "waits.log");
    handWrite({ waits: { command: node, args: [STUB, "--name", "w", "--log", log], env: { K: "${WAIT_KEY}" } } });
    const r = await row("waits");
    const saved = (await ask("PUT", `/api/mcp/rows/${r.id}/secrets/WAIT_KEY`, { value: "v" })).json as McpServerRow;
    assert.equal(saved.state, "waiting");
    assert.equal(saved.lastCheck, undefined);
    assert.equal(existsSync(log), false, "a server not approved ran");
  });
});

describe("an address server", () => {
  test("a plain address offers no Sign In: not reachable, nor connected with no sign-in, nor holding its own key", async () => {
    const unreachable = (await ask("POST", "/api/mcp/servers", { way: "address", name: "plain-down", address: "http://127.0.0.1:9/mcp" })).json as McpServerRow;
    assert.equal(unreachable.state, "failed");
    assert.equal(unreachable.signsIn, false);
    const stub = await startAddressStub();
    const open_ = (await ask("POST", "/api/mcp/servers", { way: "address", name: "plain-up", address: stub.url })).json as McpServerRow;
    stub.stop();
    assert.equal(open_.state, "connected", JSON.stringify(open_.errors));
    assert.equal(open_.signsIn, false);
    const keyed = (await ask("POST", "/api/mcp/servers", { way: "address", name: "plain-key", address: "http://127.0.0.1:9/mcp", secret: "k" })).json as McpServerRow;
    assert.equal(keyed.signsIn, false);
  });

  test("Check reads Needs Sign-in; Sign In finishes on its callback, a Check follows; a !value stays literal", async () => {
    const oauth = await startOAuthServer();
    const pwn = join(root, "pwn-header");
    const added = (await ask("POST", "/api/mcp/servers", { way: "address", name: "oa", address: oauth.url })).json as McpServerRow;
    assert.equal(added.state, "needs-sign-in", JSON.stringify(added.errors));
    assert.equal(added.signsIn, true);
    const started = (await ask("POST", `/api/mcp/rows/${added.id}/sign-in`)).json as McpSignIn;
    assert.equal(started.state, "waiting", JSON.stringify(started));
    await fetch((started as { url: string }).url, { redirect: "follow" });
    let now: McpSignIn = started;
    for (let i = 0; i < 2000 && now.state !== "done" && now.state !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      now = (await ask("GET", `/api/mcp/rows/${added.id}/sign-in`)).json as McpSignIn;
    }
    assert.equal(now.state, "done", JSON.stringify(now));
    const r = (now as { row: McpServerRow }).row;
    assert.equal((await row("oa")).state, "connected");
    assert.equal((await row("oa")).signsIn, true, "signed in, it still offers Sign In");
    assert.ok(r);
    assert.deepEqual((await row("oa")).tools.map((t) => t.name).sort(), ["search", "whoami"]);
    assert.equal(statSync(join(agent, "mcp-auth.json")).mode & 0o777, 0o600);

    handWrite({ lit: { url: oauth.url, headers: { Authorization: "Bearer x", "X-Probe": `!touch ${pwn}` } } });
    const lit = await row("lit");
    await ask("POST", `/api/mcp/rows/${lit.id}/approve`, { version: lit.entry.version });
    assert.equal(existsSync(pwn), false, "a !command in a header ran in a Check");

    await ask("DELETE", `/api/mcp/rows/${added.id}`);
    assert.ok(!readFileSync(join(agent, "mcp-auth.json"), "utf8").includes("mcp__oa|"), "its sign-in went with it");
    oauth.stop();
  });
});
