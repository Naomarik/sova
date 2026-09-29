// Run: npx tsx --test server/claude-accounts.test.ts (or pnpm test). Writes only under a mkdtemp
// dir; the `claude` it runs is scripts/fake-claude.mjs, which never contacts Anthropic.
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync as readdir, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { ClaudeAccountsService } from "./claude-accounts";
import { normalizeEntry } from "./transcript";
import type { ClaudeAccountsInfo, ClaudeLoginFlowState } from "../shared/protocol";

const FAKE = fileURLToPath(new URL("../scripts/fake-claude.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "sova-claude-accounts-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
const shim = join(root, "claude");
writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`);
chmodSync(shim, 0o755);

let n = 0;
function service() {
  const base = join(root, `case-${++n}`);
  const agentDir = join(base, "agent");
  const claudeDir = join(base, "claude");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(claudeDir, "projects"), { recursive: true });
  const env = { PATH: process.env.PATH, HOME: base, PI_CODING_AGENT_DIR: agentDir, CLAUDE_CONFIG_DIR: claudeDir, ANTHROPIC_API_KEY: "must-not-reach-the-login" } as NodeJS.ProcessEnv;
  return { svc: new ClaudeAccountsService({ agentDir, env, executable: shim, timeouts: { url: 5000, finish: 5000, logout: 5000 } }), agentDir, claudeDir };
}
const info = (r: { body: unknown }) => r.body as ClaudeAccountsInfo;
const flow = (r: { body: unknown }) => r.body as ClaudeLoginFlowState;

describe("Settings → Accounts service", () => {
  test("lists only default with no registry", () => {
    const { svc } = service();
    const i = svc.info();
    assert.deepEqual(i.device, { id: "local", label: "This device" });
    assert.deepEqual(i.logins.map((l) => l.id), ["default"]);
    assert.equal(i.flow, null);
  });

  test("adds a login through `claude auth login`: URL, code, identity; never a token", async () => {
    const { svc, agentDir, claudeDir } = service();
    const started = flow(await svc.startFlow());
    assert.equal(started.state, "waiting");
    assert.match((started as { url: string }).url, /^https:\/\/claude\.example\.invalid\//);
    assert.equal(flow(await svc.submitCode({ code: "no-hash" })).state, "waiting", "an invalid code keeps the flow waiting");
    assert.match((svc.info().flow as { error?: string }).error ?? "", /did not accept/);
    const done = flow(await svc.submitCode({ code: "ok-work#state" }));
    assert.equal(done.state, "done");
    const login = (done as Extract<ClaudeLoginFlowState, { state: "done" }>).login;
    assert.match(login.id, /^l-[0-9a-f]{8}$/);
    assert.equal(login.identity?.email, "work@example.com");
    assert.equal(login.identity?.accountUuid, "acct-work");
    assert.equal(login.signedIn, true);
    assert.equal((done as { sharedAccount: boolean }).sharedAccount, false);
    const i = svc.info();
    assert.deepEqual(i.logins.map((l) => l.id), ["default", login.id], "appended to this device's order");
    assert.ok(!JSON.stringify(i).includes("fake\""), "no credential field reaches the wire");
    const dir = join(agentDir, "claude-accounts", login.id);
    assert.equal(lstatSync(dir).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(dir, "projects")).isSymbolicLink(), true);
    assert.ok(!existsSync(join(claudeDir, ".credentials.json")), "default's directory is untouched");
    const registry = JSON.parse(readFileSync(join(agentDir, "claude-accounts.json"), "utf8"));
    assert.equal(registry.logins[0].device, "local");
    assert.ok(!JSON.stringify(registry).includes("accessToken"));
  });

  test("a second login of the same account is kept and flagged as sharing it; one flow at a time", async () => {
    const { svc } = service();
    await svc.startFlow();
    await svc.submitCode({ code: "ok-team#s" });
    await svc.startFlow();
    assert.equal((await svc.startFlow()).status, 409, "one flow at a time");
    const second = flow(await svc.submitCode({ code: "ok-team+2#s" }));
    assert.equal(second.state, "done");
    assert.equal((second as { sharedAccount: boolean }).sharedAccount, true);
    assert.equal(svc.info().logins.length, 3);
  });

  test("a refused sign-in or a cancel adds nothing and leaves no directory", async () => {
    const { svc, agentDir } = service();
    await svc.startFlow();
    const failed = flow(await svc.submitCode({ code: "bad#s" }));
    assert.equal(failed.state, "failed");
    assert.match((failed as { error: string }).error, /status code 400/);
    await svc.startFlow();
    svc.cancelFlow();
    assert.deepEqual(svc.info().logins.map((l) => l.id), ["default"]);
    assert.ok(!existsSync(join(agentDir, "claude-accounts")) || readdir(join(agentDir, "claude-accounts")).length === 0);
  });

  test("order, enable, label, clear and remove", async () => {
    const { svc, agentDir } = service();
    await svc.startFlow();
    const a = (flow(await svc.submitCode({ code: "ok-a#s" })) as { login: { id: string } }).login.id;
    await svc.startFlow();
    const b = (flow(await svc.submitCode({ code: "ok-b#s" })) as { login: { id: string } }).login.id;
    assert.equal(svc.setOrder({ order: [b, "default"] }).status, 400, "the order lists every login of this device");
    assert.deepEqual(info(svc.setOrder({ order: [b, a, "default"] })).logins.map((l) => l.id), [b, a, "default"]);
    const patched = info(svc.patch(a, { enabled: false, label: "Work" }));
    assert.deepEqual(patched.logins.find((l) => l.id === a)?.enabled, false);
    assert.equal(patched.logins.find((l) => l.id === a)?.label, "Work");
    assert.equal(info(svc.patch("default", { enabled: false })).logins.find((l) => l.id === "default")?.enabled, false);
    assert.equal(svc.patch("default", { label: "x" }).status, 400);
    writeFileSync(join(agentDir, "claude-accounts-state.json"), JSON.stringify({ version: 1, logins: { [b]: { kind: "limit", at: Date.now(), until: Date.now() + 60_000 } } }));
    assert.equal(svc.info().logins.find((l) => l.id === b)?.standing.state, "limited");
    assert.equal(info(svc.clear(b)).logins.find((l) => l.id === b)?.standing.state, "ready");
    const removed = await svc.remove(b);
    assert.equal(removed.status, 200);
    assert.deepEqual(info(removed).logins.map((l) => l.id), [a, "default"]);
    assert.ok(!existsSync(join(agentDir, "claude-accounts", b)), "its directory is deleted");
    assert.equal((await svc.remove("default")).status, 400);
    assert.equal((await svc.remove("l-deadbeef")).status, 404);
  });

  test("a malformed registry is reported and never overwritten", async () => {
    const { svc, agentDir } = service();
    writeFileSync(join(agentDir, "claude-accounts.json"), "{nope");
    const i = svc.info();
    assert.match(i.error ?? "", /not JSON/);
    assert.deepEqual(i.logins.map((l) => l.id), ["default"]);
    assert.equal((await svc.startFlow()).status, 409);
    assert.equal(svc.patch("default", { enabled: false }).status, 409);
    assert.equal(readFileSync(join(agentDir, "claude-accounts.json"), "utf8"), "{nope");
  });
});

describe("claude-login entries in the transcript", () => {
  test("a switch is one info row with its notice; the plain record renders nothing", () => {
    const text = "Claude: switched a@example.com → b@example.com (5h limit, resets 15:00)";
    const [row, ...rest] = normalizeEntry({ type: "custom", id: "e1", customType: "claude-login", data: { v: 1, login: "l-0000000b", from: "l-0000000a", reason: "limit", text } } as any);
    assert.equal(rest.length, 0);
    assert.equal(row?.kind, "info");
    assert.equal(row?.text, text);
    assert.deepEqual(normalizeEntry({ type: "custom", id: "e2", customType: "claude-login", data: { v: 1, login: "l-0000000a" } } as any), []);
  });
});
