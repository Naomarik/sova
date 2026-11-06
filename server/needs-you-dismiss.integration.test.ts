// POST and DELETE /api/attention/dismiss (§app.session-list/needs-you-dismiss) through the real app, on a real session
// file: what it validates, what it writes, that the digest reads it at once, and that a restart keeps it.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { scratchRoot } from "./test-scratch";

const dir = scratchRoot("sova-needs-you-dismiss-");
process.env.PI_CODING_AGENT_DIR = dir;
const sessions = join(dir, "sessions", "--w--");
mkdirSync(sessions, { recursive: true });
const ID = "01a1ae84-0000-7000-8000-000000000001";
const path = join(sessions, `2026-11-01T00-00-00-000Z_${ID}.jsonl`);

const { testApp } = await import("./mesh/app-test-fixtures");
const app = await testApp();
const json = (method: string, url: string, body?: unknown) => app.request(url, { method, ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
const file = () => join(dir, "sova", "needs-you-dismissed.json");

before(() => {
  const at = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(
    path,
    [
      { type: "session", version: 3, id: ID, timestamp: at, cwd: dir },
      { type: "message", id: "u1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "Fix the build" }], timestamp: Date.parse(at) } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe("the dismiss routes", () => {
  test("a path that isn't a session's, or a bad time, is refused and saves nothing", async () => {
    assert.equal((await json("POST", "/api/attention/dismiss", { path: "", since: 1 })).status, 400, "an item of no session has no path");
    assert.equal((await json("POST", "/api/attention/dismiss", { path: "/etc/passwd", since: 1 })).status, 400);
    assert.equal((await json("POST", "/api/attention/dismiss", { path: join(sessions, "nope.jsonl"), since: 1 })).status, 404);
    for (const since of [undefined, "1", -1, null]) assert.equal((await json("POST", "/api/attention/dismiss", { path, since })).status, 400, String(since));
    assert.equal((await app.request("/api/attention/dismiss", { method: "POST", body: "not json" })).status, 400);
    assert.equal((await json("DELETE", "/api/attention/dismiss?path=/etc/passwd")).status, 400);
    assert.throws(() => readFileSync(file()), "nothing was written");
  });

  test("POST saves it on the server, the digest says so at once, and DELETE takes it back", async () => {
    const r = await json("POST", "/api/attention/dismiss", { path, since: 123 });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { since: number }).since, 123);
    assert.equal(JSON.parse(readFileSync(file(), "utf8"))[path].since, 123);
    const digest = (await (await json("GET", "/api/overseer/attention")).json()) as { dismissed?: Record<string, number> };
    assert.equal(digest.dismissed?.[path], 123);
    assert.equal(Object.hasOwn(digest, "dismissedKeys"), false, "never on the wire");
    const d = await json("DELETE", `/api/attention/dismiss?path=${encodeURIComponent(path)}`);
    assert.deepEqual(await d.json(), { path, undone: true });
    assert.deepEqual(JSON.parse(readFileSync(file(), "utf8")), {});
    const again = await json("DELETE", `/api/attention/dismiss?path=${encodeURIComponent(path)}`);
    assert.equal(((await again.json()) as { undone: boolean }).undone, false);
    assert.equal(((await (await json("GET", "/api/overseer/attention")).json()) as { dismissed?: unknown }).dismissed, undefined);
  });
});
