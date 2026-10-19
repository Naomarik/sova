// Run: pnpm test -- shared/commands-catalog.test.ts
// The catalogue's own rules (§app.commands/catalogue), pure: ids append-only against the committed
// list, no entry at a door the operator keeps closed, the verb family made from the contract's
// lists, and the request each entry builds. Routes registered and mesh reach against the real app:
// server/commands-catalog.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildRequest, COMMANDS, findCommand } from "./commands-catalog";
import { DEPLOY_READ_VERBS, DEPLOY_VERBS, READ_VERBS, VERBS } from "./project-contract";

const shipped = (JSON.parse(readFileSync(new URL("./commands-ids.json", import.meta.url), "utf8")) as { ids: string[] }).ids;

test("ids are append-only: every id ever shipped is still an entry, and every entry's id is listed", () => {
  const now = COMMANDS.map((c) => c.id);
  assert.deepEqual(shipped.filter((id) => !now.includes(id)), [], "an id was removed or renamed: ids are append-only (shared/commands-ids.json)");
  assert.deepEqual(now.filter((id) => !shipped.includes(id)), [], "a new entry: add its id at the end of shared/commands-ids.json");
  assert.equal(new Set(shipped).size, shipped.length, "an id listed twice");
});

test("ids are unique, dotted lowercase, and never under ext.", () => {
  const ids = COMMANDS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.match(id, /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/, id);
    assert.ok(!id.startsWith("ext."), `${id}: ext.* belongs to extensions`);
  }
});

test("no entry points at the peer, auth, share-page or extension-proxy routes", () => {
  const closed = /^\/(?:api\/peer|api\/auth|h|i|s|ext|peer)(?:\/|$)/;
  for (const c of COMMANDS) assert.doesNotMatch(c.route.path, closed, `${c.id}: ${c.route.path}`);
  // The same rule refuses each closed door (the check above can fail).
  for (const p of ["/api/peer/hello", "/api/auth/token", "/h/x", "/i/x", "/s/x", "/ext/a/api/x", "/peer/b/api/x"]) assert.match(p, closed);
});

test("one project.verb entry per contract verb and deploy verb, reads marked looks", () => {
  const verbs = COMMANDS.filter((c) => c.id.startsWith("project.verb.")).map((c) => c.id.slice("project.verb.".length));
  assert.deepEqual(verbs, [...VERBS, ...DEPLOY_VERBS]);
  for (const v of verbs) {
    const c = findCommand(`project.verb.${v}`)!;
    const reads = (READ_VERBS as readonly string[]).includes(v) || (DEPLOY_READ_VERBS as readonly string[]).includes(v);
    assert.equal(c.effect, reads ? "looks" : "changes", v);
    assert.equal(c.route.path, `/api/project-services/${v}`);
  }
});

test("an entry's session param agrees with its sessionKey", () => {
  for (const c of COMMANDS) {
    const s = Object.entries(c.params).filter(([, p]) => p.type === "session");
    if (c.sessionKey === null) assert.equal(s.length, 0, c.id);
    else {
      assert.equal(s.length, 1, c.id);
      assert.equal(s[0]![1].key, c.sessionKey, c.id);
    }
  }
});

test("an entry builds its route's own request: body, query, path and fixed keys", () => {
  assert.deepEqual(buildRequest(findCommand("session.title.reset")!, { session: "/s/a.jsonl" }), { method: "POST", url: "/api/sessions/title", body: { path: "/s/a.jsonl", title: null } });
  assert.deepEqual(buildRequest(findCommand("session.archive")!, { session: "/s/a.jsonl" }), { method: "POST", url: "/api/sessions/archive", body: { path: "/s/a.jsonl", archived: true } });
  assert.deepEqual(buildRequest(findCommand("session.unarchive")!, { session: "/s/a.jsonl" }).body, { path: "/s/a.jsonl", archived: false });
  assert.deepEqual(buildRequest(findCommand("session.tags.set")!, { session: "abc", tags: ["x", "y"] }).body, { id: "abc", user: ["x", "y"] });
  assert.deepEqual(buildRequest(findCommand("session.mode.set")!, { session: "/s/a b.jsonl", "minor-modes": ["spec"] }), { method: "POST", url: "/api/mode?path=%2Fs%2Fa+b.jsonl", body: { minorModes: ["spec"] } });
  assert.deepEqual(buildRequest(findCommand("session.get")!, { session: "abc" }), { method: "GET", url: "/api/sessions/summary?id=abc" });
  assert.deepEqual(buildRequest(findCommand("project.services.view")!, { pid: "p 1" }), { method: "GET", url: "/api/projects/p%201/services" });
  assert.deepEqual(buildRequest(findCommand("overseer.todo.remove")!, { id: "t1" }), { method: "DELETE", url: "/api/overseer/todo?id=t1" });
  assert.deepEqual(buildRequest(findCommand("project.verb.up")!, { "keep-data": true }).body, { keepData: true });
  assert.deepEqual(buildRequest(findCommand("project.verb.deploy.status")!, {}).body, { project: "." });
  assert.throws(() => buildRequest(findCommand("session.title.set")!, { session: "/s/a.jsonl" }), /--title is required/);
  assert.throws(() => buildRequest(findCommand("project.services.view")!, {}), /--pid is required/);
});
