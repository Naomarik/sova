// Run: pnpm test -- server/mcp/guards.test.ts. What keeps a server's secrets on this computer: the sandbox's defaults,
// the Overseer's redactor, the mesh's sync lists, a chat's setup group in a remote or profiled chat.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";

const root = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mcp-guards-")));
const agent = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agent;
mkdirSync(join(agent, "sessions"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const REPO = resolve(import.meta.dirname, "..", "..");
const { saveSecret } = await import("./saved-values");
const { Redactor, secretSources } = await import("../overseer-redact");
const { settingsDocs } = await import("../sync/docs");
const { targetsRoot } = await import("../targets");
const { chatListFor, setupFor } = await import("./chat");
const { putComputerEntry, normalizeEntry } = await import("./config");

describe("the sandbox's defaults", () => {
  test("every shipped policy hides the secrets and the sign-ins", () => {
    for (const os of ["linux", "darwin"]) {
      const { hidden } = JSON.parse(readFileSync(join(REPO, "pi-config", "sandbox-policy", os, "policy.json"), "utf8"));
      assert.ok(hidden.includes("$AGENT_DIR/mcp-auth.json"), os);
      assert.ok(hidden.includes("$AGENT_DIR/sova/secrets/mcp"), os);
    }
  });

  test("each backend's own list hides them too", () => {
    for (const file of ["linux-bwrap.ts", "darwin-seatbelt.ts"]) {
      const text = readFileSync(join(REPO, "pi-config", "extensions", "sandbox", "backends", file), "utf8");
      assert.ok(text.includes('join(a, "mcp-auth.json")'), file);
      assert.ok(text.includes('join(a, "sova", "secrets", "mcp")'), file);
    }
  });
});

describe("what the Overseer reads", () => {
  test("a saved secret and a sign-in's token are taken out", () => {
    saveSecret({ kind: "computer" }, "s", "KEY", "value-of-a-saved-secret");
    writeFileSync(join(agent, "mcp-auth.json"), JSON.stringify({ "mcp__s|http://x/": { tokens: { access_token: "an-access-token-value" } } }));
    const r = new Redactor(secretSources(join(root, "no-home"), agent), {}).refresh();
    const out = r.redact("a value-of-a-saved-secret b an-access-token-value c");
    assert.ok(!out.includes("value-of-a-saved-secret"), out);
    assert.ok(!out.includes("an-access-token-value"), out);
  });
});

describe("the mesh", () => {
  test("no synced document is a server's list, approval or record", () => {
    const docs = settingsDocs("/a", "/a/sova");
    assert.ok(docs.length > 0);
    assert.deepEqual(docs.filter((d) => /mcp/i.test(JSON.stringify(d))).map((d) => d.key), []);
  });
});

describe("a chat with no servers", () => {
  const file = (cwd: string, entries: unknown[] = []) => {
    const path = join(agent, "sessions", `chat-${Math.random().toString(36).slice(2)}.jsonl`);
    writeFileSync(path, [{ type: "session", version: 3, id: "s", timestamp: "2026-11-04T00:00:00.000Z", cwd }, ...entries].map((l) => JSON.stringify(l)).join("\n") + "\n");
    return path;
  };
  const ask = { sandboxOn: false, offMcp: [], onMcp: [] };

  test("a remote chat gets none, and its card says why, naming the target", async () => {
    putComputerEntry(normalizeEntry("s", { command: "c" }, "computer"));
    const cwd = join(targetsRoot(), "box", "work");
    assert.equal(await chatListFor({ ...ask, path: file(cwd), cwd }), null);
    assert.deepEqual(await setupFor({ path: file(cwd), cwd: "/work", remote: "box", off: null }), { line: { why: "remote", target: "box" }, rows: [] });
  });

  test("a profile without MCP Servers: the group is one line, naming it", async () => {
    putComputerEntry(normalizeEntry("s", { command: "c" }, "computer"));
    const cwd = join(root, "folder");
    mkdirSync(cwd, { recursive: true });
    const profile = { type: "custom", customType: "sova-profile", id: "e0000001", parentId: null, timestamp: "2026-11-04T00:00:01.000Z", data: { v: 1, profile: { id: "p", label: "Locked Down", remove: ["mcp"], grant: [] } } };
    assert.deepEqual(await setupFor({ path: file(cwd, [profile]), cwd, off: null }), { line: { why: "profile", profile: "Locked Down" }, rows: [] });
  });

  test("a pick on a chat that hasn't been written yet counts: the held chat's profile, saved or Custom", async () => {
    putComputerEntry(normalizeEntry("s", { command: "c" }, "computer"));
    const cwd = join(root, "folder3");
    mkdirSync(cwd, { recursive: true });
    const path = file(cwd);
    assert.notEqual((await setupFor({ path, cwd, off: null }))?.rows.length, 0, "nothing on file: the servers show");
    for (const label of ["Custom", "Locked Down"])
      assert.deepEqual(await setupFor({ path, cwd, off: null }, () => ({ label, remove: ["workers", "mcp"] })), { line: { why: "profile", profile: label }, rows: [] });
    assert.notEqual((await setupFor({ path, cwd, off: null }, () => ({ label: "Open", remove: ["web"] })))?.rows.length, 0, "a profile that keeps them");
  });

  test("a chat that has begun shows its own list, whatever the switches say now", async () => {
    putComputerEntry(normalizeEntry("s", { command: "c" }, "computer"));
    const cwd = join(root, "folder2");
    mkdirSync(cwd, { recursive: true });
    const kept = { type: "custom", customType: "sova-mcp-list", id: "e0000001", parentId: null, timestamp: "2026-11-04T00:00:01.000Z", data: { v: 1, servers: [{ id: "x", name: "s", version: "v", owner: { kind: "computer" }, kind: "command", record: { tools: [] } }] } };
    const setup = await setupFor({ path: file(cwd, [kept]), cwd, off: null });
    assert.equal(setup?.rows[0]?.on, true, "it's waiting now, and this chat lists it");
  });
});
