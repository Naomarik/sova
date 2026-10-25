// Run: pnpm test -- server/commands-catalog.test.ts
// The catalogue against the real app, in-process (§app.commands/catalogue): every entry's route is
// registered, every entry's meshNeed is what the peer listener's classifier gives that route, and a
// request built from an entry gets exactly the answer the web app's own request gets, refusals
// included. A throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { buildRequest, COMMANDS, findCommand, type CommandEntry } from "../shared/commands-catalog";

const agentDir = mkdtempSync(join(tmpdir(), "sova-commands-unit-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-commands-test--");
const liveDir = join(agentDir, "sessions", "live");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(liveDir, { recursive: true });

const { testApp } = await import("./mesh/app-test-fixtures");
const app = await testApp();
const { classifyRequest } = await import("./mesh/access");
const { addWebSession } = await import("./web-sessions");
const { canonicalPath } = await import("./paths");

after(() => rmSync(agentDir, { recursive: true, force: true }));

/** A route pattern as Hono registers it → a regex over concrete paths. */
const patternRe = (p: string) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/:[^/]+/g, "[^/]+")}$`);
/** An entry's path with its `:name` segments filled, as a caller sends it. */
const concrete = (c: CommandEntry) => c.route.path.replace(/:[^/]+/g, "x");

describe("routes", () => {
  test("every entry's route is registered for its method, never only by a catch-all", () => {
    const routes = app.routes.filter((r) => r.method !== "ALL" && !r.path.includes("*"));
    const missing = COMMANDS.filter((c) => !routes.some((r) => r.method === c.route.method && patternRe(r.path).test(concrete(c))));
    assert.deepEqual(missing.map((c) => `${c.id}: ${c.route.method} ${c.route.path}`), []);
    // The check can fail: a route no one registered is missing.
    assert.equal(routes.some((r) => r.method === "POST" && patternRe(r.path).test("/api/sessions/no-such-route")), false);
  });

  test("every entry's meshNeed is what classifyRequest gives its route", () => {
    const wrong = COMMANDS.filter((c) => classifyRequest(c.route.method, concrete(c)).need !== c.meshNeed).map((c) => `${c.id}: ${c.meshNeed} ≠ ${classifyRequest(c.route.method, concrete(c)).need}`);
    assert.deepEqual(wrong, []);
    // No entry falls to the classifier's default (needs `full` for want of a rule).
    for (const c of COMMANDS) assert.notEqual(classifyRequest(c.route.method, concrete(c)).rule, "default", c.id);
  });
});

// ---- the answers are the route's own -------------------------------------------------------------

const otherPid = process.ppid; // alive for the whole file: stands in for a TUI's process
function session(id: string): string {
  const path = join(sessionsDir, `2026-10-17T00-00-00-000Z_${id}.jsonl`);
  const lines = [
    JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-17T00:00:00.000Z", cwd: "/tmp" }),
    JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-10-17T00:00:01.000Z", message: { role: "user", content: "hi" } }),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);
  return canonicalPath(path);
}

async function send(method: string, url: string, body?: unknown): Promise<[number, unknown]> {
  const res = await app.request(url, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  return [res.status, await res.json()];
}
const viaEntry = (id: string, values: Record<string, unknown>) => {
  const r = buildRequest(findCommand(id)!, values);
  return send(r.method, r.url, r.body);
};

describe("answers", () => {
  test("archive on a session open in a TUI: the route's own refusal, word for word", async () => {
    const path = session("live-1");
    addWebSession("live-1");
    writeFileSync(join(liveDir, "p-cmd.json"), JSON.stringify({ session: { pid: otherPid, sessionFile: path, mode: "tui" }, presence: { status: "idle" } }));
    try {
      const direct = await send("POST", "/api/sessions/archive", { path, archived: true });
      const entry = await viaEntry("session.archive", { session: path });
      assert.deepEqual(entry, direct);
      assert.deepEqual(entry, [409, { error: "This session is open in a TUI, so it stays on top while live. Nothing was archived." }]);
      const configure = await viaEntry("session.configure", { session: path, thinking: "low" });
      assert.deepEqual(configure, [409, { error: `It is open in a terminal (pid ${otherPid}), so this server must not write to it.` }]);
    } finally {
      rmSync(join(liveDir, "p-cmd.json"));
    }
  });

  test("title set and reset: the same answer the web app gets", async () => {
    const path = session("title-1");
    const [s1, set] = await viaEntry("session.title.set", { session: path, title: "Named by a command" });
    assert.equal(s1, 200);
    assert.equal((set as { title: string }).title, "Named by a command");
    const [s2, reset] = await viaEntry("session.title.reset", { session: path });
    assert.equal(s2, 200);
    assert.equal((reset as { title: string }).title, "hi");
    assert.deepEqual(await viaEntry("session.title.set", { session: path, title: "" }), await send("POST", "/api/sessions/title", { path, title: "" }));
    assert.deepEqual(await viaEntry("session.title.set", { session: join(sessionsDir, "missing.jsonl"), title: "x" }), [404, { error: "Session file not found" }]);
  });

  test("a bad value is the route's 400, never the catalogue's", async () => {
    assert.deepEqual(await viaEntry("session.tags.set", { session: "x", tags: ["a b c d e f g h i j k l m n o p q r s t u v w x y z".repeat(4)] }), await send("POST", "/api/sessions/tags", { id: "x", user: ["a b c d e f g h i j k l m n o p q r s t u v w x y z".repeat(4)] }));
    assert.deepEqual(await viaEntry("session.get", { session: "no-such-id" }), [404, { error: "No session with that id" }]);
  });
});
