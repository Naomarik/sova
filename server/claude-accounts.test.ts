// Run: npx tsx --test server/claude-accounts.test.ts (or pnpm test). Writes only under a mkdtemp
// dir; the `claude` it would run is scripts/fake-claude.mjs, which never contacts Anthropic.
// The login flows, which drive the fake `claude` as a child process, are in claude-accounts.integration.test.ts.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { ClaudeAccountsService } from "./claude-accounts";
import { normalizeEntry } from "./transcript";
import { rowFor } from "./wire-rows";
import type { ClaudeAccountsInfo } from "../shared/protocol";

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

describe("Settings → Accounts service", () => {
  test("lists only default with no registry", () => {
    const { svc } = service();
    const i = svc.info();
    assert.deepEqual(i.device, { id: "local", label: "This device" });
    assert.deepEqual(i.logins.map((l) => l.id), ["default"]);
    assert.equal(i.flow, null);
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
  test("a switch is one info row with its notice, marked loginNote on both wires; the plain record renders nothing", () => {
    const text = "Claude: switched a@example.com → b@example.com (5h limit, resets 15:00)";
    const [row, ...rest] = normalizeEntry({ type: "custom", id: "e1", customType: "claude-login", data: { v: 1, login: "l-0000000b", from: "l-0000000a", reason: "limit", text } } as any);
    assert.equal(rest.length, 0);
    assert.equal(row?.kind, "info");
    assert.equal(row?.text, text);
    assert.equal(row?.loginNote, true, "the server marks the switch note (§app.claude-logins/switch-login)");
    const w2 = rowFor(row!, 2);
    assert.equal(w2.meta, undefined);
    assert.ok(w2.facts);
    assert.equal(w2.loginNote, true, "the mark survives wire 2, where facts replace meta");
    assert.deepEqual(normalizeEntry({ type: "custom", id: "e2", customType: "claude-login", data: { v: 1, login: "l-0000000a" } } as any), []);
  });
});
