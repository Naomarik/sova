// Run: pnpm test -- server/wire-gate.test.ts. The host holding a session refuses a writing request on
// another number (§mesh.compatibility/refusal), on the real app's routes, the mesh off.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Hono } from "hono";
import { COMMANDS } from "../shared/commands-catalog";
import { COMPOSER_HEADER, WIRE_AREAS, WIRE_VERSION_CODE } from "../shared/wire-areas";

const dir = mkdtempSync(join(tmpdir(), "sova-wire-gate-"));
process.env.PI_CODING_AGENT_DIR = dir;

let app: Hono;
let routes: readonly string[];
before(async () => {
  const { testApp } = await import("./mesh/app-test-fixtures");
  app = await testApp();
  routes = (await import("./wire-gate")).WRITING_ROUTES;
});
after(() => rmSync(dir, { recursive: true, force: true }));

const post = (path: string, stated?: string, body: unknown = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", ...(stated === undefined ? {} : { [COMPOSER_HEADER]: stated }) }, body: JSON.stringify(body) });
const ahead = String(WIRE_AREAS.composer + 1);

describe("the writing gate", () => {
  test("every writing route refuses another number with the sentence and does nothing", async () => {
    for (const route of routes) {
      const res = await post(route, ahead);
      assert.equal(res.status, 409, route);
      assert.deepEqual(await res.json(), { error: "This host needs an update before it can take sends from this page.", code: WIRE_VERSION_CODE }, route);
    }
  });

  test("a spelling that reaches the route reaches the gate", async () => {
    assert.equal((await post("/api/sessions?x=1", ahead)).status, 409);
  });

  test("its own number and, at the first version, no number get through to the route", async () => {
    for (const route of routes) {
      for (const stated of [String(WIRE_AREAS.composer), undefined]) {
        const body = (await (await post(route, stated)).clone().json().catch(() => null)) as { code?: string } | null;
        assert.notEqual(body?.code, WIRE_VERSION_CODE, `${route} refused ${stated}`);
      }
    }
  });

  test("POST /api/chat/frames refuses too, and what it carried goes back as the draft", async () => {
    const path = join(dir, "sessions", "--x--", "s1.jsonl");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ type: "session", id: "s1", timestamp: new Date(0).toISOString(), cwd: dir })}\n`);
    const res = await post(`/api/chat/frames?path=${encodeURIComponent(path)}`, ahead, { frames: [{ type: "prompt", text: "keep me", clientId: "c1" }] });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code: string }).code, WIRE_VERSION_CODE);
    const { draftForClient } = await import("./drafts");
    assert.match(JSON.stringify(draftForClient("s1")), /keep me/);
  });

  test("a read route never asks", async () => {
    const res = await app.request("/api/sessions", { headers: { [COMPOSER_HEADER]: ahead } });
    assert.equal(res.status, 200);
  });

  test("the catalogue's writing commands land on a gated route", () => {
    const gated = (path: string) => routes.includes(path) || path === "/api/chat/frames";
    const writing = COMMANDS.filter((c) => c.route.method === "POST" && /^\/api\/(?:chat\/action|sessions\/(?:prompt|configure))$/.test(c.route.path.split("?")[0]!));
    assert.ok(writing.length > 0);
    for (const c of writing) assert.ok(gated(c.route.path.split("?")[0]!), c.id);
  });
});
