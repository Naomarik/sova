// Run: pnpm test -- server/mesh/remote-commands.test.ts
// A catalogue command run on a peer (§mesh.peers/remote-commands), in-process: this host's app built
// with nothing started, the peer listener's own gate (PeerGate, with the runtime's peerByNode and
// allows) fed in-process connections, and a stub identity. `POST /api/commands/<id>` needs what the
// entry's own route needs, is gated again on the request it builds, runs as the calling peer, and is
// on neither the main nor the share listener. A throwaway PI_CODING_AGENT_DIR; ~/.pi is never touched.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { COMMANDS } from "../../shared/commands-catalog";
import { grantCaps, MESH_CAPS, MESH_PRESETS, type MeshGrant } from "../../shared/mesh-access";
import { testApp } from "./app-test-fixtures";
import { inProcessPeerGate } from "./peer-gate-test-fixtures";
import { fakeWire } from "./peer-wire-test-fixtures";

const tmp = mkdtempSync(join(tmpdir(), "sova-remote-commands-unit-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
const sessionsDir = join(tmp, "agent", "sessions", "--tmp-remote-commands--");
mkdirSync(join(tmp, "agent", "sessions", "live"), { recursive: true });
mkdirSync(sessionsDir, { recursive: true });

const { setIdentity } = await import("./localapi");
setIdentity({
  status: async () => ({
    backendState: "Running",
    self: { nodeId: "nA", name: "a.lab", hostName: "a", os: "linux", online: true, tags: [], login: "me", addresses: ["127.0.0.1"] },
    peers: [],
  }),
  whois: async () => null,
});

const wire = fakeWire();
const app = await testApp();
const { peerByNode, stopMesh } = await import("./index");
const { allows, classifyRequest, commandNeed, peerCommandId, pinCommandNeedForTest } = await import("./access");
const { canonicalPath } = await import("../paths");
const { runPeerCommand, NO_COMMAND } = await import("../commands-routes");
const { shareMayReach } = await import("../share/edge");
const { routeOfEntry } = await import("../commands-inventory/scan");
(await import("./links-transfer")).setTarAvailableForTest(true);

const peer = inProcessPeerGate(
  { fetch: app.fetch, upgrade: (_req, socket) => socket.destroy(), allows: (p, need) => allows(p.nodeId, need) },
  () => peerByNode("nB"),
);
const call = peer.call;

const FAKE = "http://127.0.0.1:47031";
wire.serve(FAKE, () => new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } }));

after(() => {
  stopMesh();
  wire.restore();
  rmSync(tmp, { recursive: true, force: true });
});

const put = async (path: string, body: unknown) => (await app.request(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).status;
const grant = async (g: MeshGrant) => assert.equal(await put("/api/mesh/access", { peer: "b", grant: g }), 200);

/** A session file under the throwaway sessions dir, and its path as the routes know it. */
function session(id: string): string {
  const path = join(sessionsDir, `2026-10-17T00-00-00-000Z_${id}.jsonl`);
  const lines = [
    JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-17T00:00:00.000Z", cwd: "/tmp" }),
    JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-10-17T00:00:01.000Z", message: { role: "user", content: "hi" } }),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);
  const canonical = canonicalPath(path);
  idOf.set(canonical, id);
  return canonical;
}
const idOf = new Map<string, string>();
const titleOf = async (path: string): Promise<string> => {
  const res = await app.request(`/api/sessions/summary?id=${encodeURIComponent(idOf.get(path)!)}`);
  assert.equal(res.status, 200);
  return ((await res.json()) as { title: string }).title;
};
const door = (id: string, values: unknown) => call("POST", `/api/commands/${id}`, JSON.stringify(values));
const parsed = (body: string) => JSON.parse(body) as { error?: string; title?: string };
const concrete = (p: string) => p.replace(/:[^/]+/g, "x");

before(async () => {
  assert.equal(await put("/api/mesh/peers", { peers: [{ id: "b", label: "B", nodeId: "nB", name: "127.0.0.1", url: FAKE }] }), 200);
});

describe("what a remote run needs", () => {
  test("a `sessions` peer renames a session but can't run a project verb; `full` reaches the verb's own route", async () => {
    await grant({ preset: "sessions" });
    const path = session("rename-me");
    const ok = await door("session.title.set", { session: path, title: "Renamed far away" });
    assert.equal(ok.status, 200, ok.body);
    assert.equal(parsed(ok.body).title, "Renamed far away");
    assert.equal(await titleOf(path), "Renamed far away");

    const verb = await door("project.verb.status", { project: "no-such-project" });
    assert.deepEqual([verb.status, verb.marker], [403, "denied"]);
    // The verb's own route, straight through the gate, is refused the same way.
    const direct = await call("POST", "/api/project-services/status", JSON.stringify({ project: "no-such-project" }));
    assert.deepEqual([direct.status, direct.marker], [403, "denied"]);

    await grant({ preset: "full" });
    const fullDoor = await door("project.verb.status", { project: "no-such-project" });
    const fullDirect = await call("POST", "/api/project-services/status", JSON.stringify({ project: "no-such-project" }));
    assert.notEqual(fullDoor.marker, "denied");
    const noTime = (body: string) => ({ ...parsed(body), at: undefined });
    assert.deepEqual([fullDoor.status, noTime(fullDoor.body)], [fullDirect.status, noTime(fullDirect.body)]);
  });

  test("an unknown id, an extension's own command included, needs `full`, then has no such command", async () => {
    for (const id of ["no.such.command", "ext.someext.run", "__proto__", "constructor"]) {
      assert.deepEqual(classifyRequest("POST", `/api/commands/${id}`), { need: "full", rule: "command:unknown" }, id);
      await grant({ preset: "sessions" });
      const denied = await door(id, {});
      assert.deepEqual([denied.status, denied.marker], [403, "denied"], id);
      await grant({ preset: "full" });
      const none = await door(id, {});
      assert.equal(none.status, 404, id);
      assert.ok(parsed(none.body).error?.startsWith(NO_COMMAND), none.body);
    }
    // Anything else under /api/commands keeps `full`.
    assert.equal(classifyRequest("GET", "/api/commands/session.title.set").need, "full");
    assert.equal(classifyRequest("GET", "/api/commands").need, "full");
    assert.equal(classifyRequest("POST", "/api/commands/session.title.set/x").need, "full");
  });

  test("parity over every catalogue entry: the door needs exactly its route's need, so no grant reaches more through it", () => {
    const grants: MeshGrant[] = [
      ...MESH_PRESETS.map((preset) => ({ preset })),
      ...MESH_CAPS.map((cap) => ({ preset: "none" as const, caps: { [cap]: true } })),
      ...MESH_CAPS.map((cap) => ({ preset: "full" as const, caps: { [cap]: false } })),
    ];
    const wrong: string[] = [];
    for (const e of COMMANDS) {
      const own = classifyRequest(e.route.method, concrete(e.route.path)).need;
      const via = classifyRequest("POST", `/api/commands/${e.id}`);
      if (via.need !== own || via.rule !== `command:${e.id}` || commandNeed(e.id) !== e.meshNeed) wrong.push(`${e.id}: ${via.need} ≠ ${own}`);
      for (const g of grants) {
        const caps = grantCaps(g);
        const has = (need: string) => (need === "full" ? MESH_CAPS.every((c) => caps[c]) : need === "hello" ? caps.presence : caps[need as keyof typeof caps]);
        if (has(via.need) && !has(own)) wrong.push(`${e.id}: ${JSON.stringify(g)} reaches the door but not the route`);
      }
    }
    assert.deepEqual(wrong, []);
    assert.ok(COMMANDS.length > 100);
  });

  test("on the gate, for every entry: a grant that refuses the entry's route refuses the door, before anything runs", async () => {
    for (const preset of ["presence", "sessions"] as const) {
      await grant({ preset });
      const mismatched: string[] = [];
      for (const e of COMMANDS) {
        const need = commandNeed(e.id);
        if (allows("nB", need)) continue; // granted: it would run (the effect tests above)
        const viaDoor = await door(e.id, {});
        const direct = await call(e.route.method, concrete(e.route.path), e.route.method === "GET" || e.route.method === "DELETE" ? undefined : "{}");
        if (viaDoor.status !== direct.status || viaDoor.marker !== direct.marker || viaDoor.marker !== "denied") mismatched.push(`${preset} ${e.id}: door ${viaDoor.status}/${viaDoor.marker} route ${direct.status}/${direct.marker}`);
      }
      assert.deepEqual(mismatched, []);
    }
  });

  test("the need is the S1 inventory's pinned need for the entry's route", () => {
    const baseline = JSON.parse(readFileSync(resolve(import.meta.dirname, "../commands-inventory/baseline.json"), "utf8")) as { routes: Record<string, { need: string }> };
    const routes = app.routes.filter((r) => r.method !== "ALL");
    const wrong: string[] = [];
    for (const e of COMMANDS) {
      const k = routeOfEntry(e, routes);
      const row = k ? baseline.routes[k] : undefined;
      if (!row || row.need !== commandNeed(e.id)) wrong.push(`${e.id}: ${k} pinned ${row?.need} ≠ ${commandNeed(e.id)}`);
    }
    assert.deepEqual(wrong, []);
  });
});

describe("the run flags", () => {
  test("no catalogue param is named as one of sova run's own flags, so none is shadowed", () => {
    const flags = ["host", "url", "session", "json"];
    const clash = COMMANDS.flatMap((e) => Object.keys(e.params).filter((k) => flags.includes(k) && !(k === "session" && e.params[k]!.type === "session")).map((k) => `${e.id}: --${k}`));
    assert.deepEqual(clash, []);
  });
});

describe("the door gates the request it builds", () => {
  test("a pin lower than the built request's need is caught by the second check: 403 denied, nothing ran", async () => {
    await grant({ preset: "presence" });
    const path = session("pinned-low");
    pinCommandNeedForTest("session.title.set", "presence");
    try {
      const res = await door("session.title.set", { session: path, title: "Should not land" });
      assert.deepEqual([res.status, res.marker, parsed(res.body).error], [403, "denied", "not shared with this host"]);
    } finally {
      pinCommandNeedForTest(null);
    }
    assert.notEqual(await titleOf(path), "Should not land");
  });

  test("a param that would take the request off the entry's own route is refused", async () => {
    await grant({ preset: "full" });
    for (const pid of ["..", "../..", "../../sessions", "../../../api/settings"]) {
      const res = await door("project.archive", { pid });
      // Off its route (400), or onto a path no peer reaches (the gate's 404): never another route's answer.
      assert.ok(
        (res.status === 400 && /off the command's own route/.test(parsed(res.body).error ?? "")) || (res.status === 404 && parsed(res.body).error === "Not found"),
        `${pid}: ${res.status} ${res.body}`,
      );
    }
    // An encoded slash stays one segment (encodeURIComponent): it lands on the route, whose own answer it gets.
    const enc = await door("project.get", { pid: "a/b" });
    assert.notEqual(enc.status, 200);
    // A request a peer never reaches is the gate's 404, through the door as directly.
    const unreachable = await runPeerCommand(new Request("http://peer/api/commands/session.title.set", { method: "POST", body: JSON.stringify({ session: "/s/x.jsonl", title: "t" }) }), "session.title.set", { id: "b" }, {}, { fetch: () => new Response("{}"), mayReach: () => false });
    assert.deepEqual([unreachable.status, await unreachable.json()], [404, { error: "Not found" }]);
  });

  test("params: one JSON object of the entry's own params, at most 1 MB", async () => {
    await grant({ preset: "full" });
    const path = session("params");
    for (const body of ["[]", "7", "null", "\"x\"", "{", JSON.stringify({ session: path, title: "x", extra: 1 }), "{\"__proto__\":{\"title\":\"x\"},\"session\":\"/x.jsonl\"}"]) {
      const res = await call("POST", "/api/commands/session.title.set", body);
      assert.equal(res.status, 400, `${body}: ${res.body}`);
    }
    const big = await call("POST", "/api/commands/session.title.set", JSON.stringify({ session: path, title: "x".repeat(1024 * 1024) }));
    assert.equal(big.status, 413);
    // A streamed body with no content-length is held to the same limit while it is read.
    let ran = false;
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ < 20) c.enqueue(chunk);
        else c.close();
      },
    });
    const streamed = await runPeerCommand(new Request("http://peer/api/commands/session.title.set", { method: "POST", body: stream, duplex: "half" } as RequestInit), "session.title.set", { id: "b" }, {}, {
      fetch: () => ((ran = true), new Response("{}")),
      mayReach: () => true,
    });
    assert.deepEqual([streamed.status, ran], [413, false]);
    const missing = await door("session.title.set", { session: path });
    assert.equal(missing.status, 400);
    assert.notEqual(await titleOf(path), "x");
  });

  test("the run is the peer's: the same answer as the entry's route straight through the gate, operator-only routes included", async () => {
    await grant({ preset: "full" });
    // POST /api/projects refuses anything but this host's own browser (localRequest).
    const viaDoor = await door("project.create", { root: "/tmp" });
    const direct = await call("POST", "/api/projects", JSON.stringify({ root: "/tmp" }));
    assert.deepEqual([viaDoor.status, parsed(viaDoor.body)], [403, { error: "Projects are added on their own host." }]);
    assert.deepEqual([viaDoor.status, parsed(viaDoor.body)], [direct.status, parsed(direct.body)]);
    const path = session("same-answer");
    const a = await door("session.title.set", { session: path, title: "" });
    const b = await call("POST", "/api/sessions/title", JSON.stringify({ path, title: "" }));
    assert.deepEqual([a.status, parsed(a.body)], [b.status, parsed(b.body)]);
  });

  test("the inner request: its body's own headers, the command named, the relay's marks kept", async () => {
    let seen: Request | null = null;
    let seenEnv: Record<string, unknown> = {};
    const fetch = (req: Request, env: Record<string, unknown>) => {
      seen = req;
      seenEnv = env;
      return new Response("{}", { status: 200 });
    };
    const outer = new Request("http://peer/api/commands/session.title.set", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "content-encoding": "gzip",
        expect: "100-continue",
        "x-sova-command": "something.else",
        "x-sova-relayed": "1",
        "x-forwarded-host": "peer",
      },
      body: JSON.stringify({ session: "/s/x.jsonl", title: "t" }),
    });
    const who = { id: "b" };
    const res = await runPeerCommand(outer, "session.title.set", who, { incoming: 1 }, { fetch, mayReach: () => true, allows: () => true });
    assert.equal(res.status, 200);
    const inner = seen as unknown as Request;
    assert.equal(new URL(inner.url).pathname, "/api/sessions/title");
    assert.equal(inner.method, "POST");
    assert.equal(inner.headers.get("content-type"), "application/json");
    assert.equal(inner.headers.get("x-sova-command"), "session.title.set");
    for (const h of ["content-encoding", "expect", "transfer-encoding", "connection"]) assert.equal(inner.headers.get(h), null, h);
    const len = inner.headers.get("content-length");
    const text = await inner.text();
    assert.ok(len === null || Number(len) === Buffer.byteLength(text), `content-length ${len} for ${text.length} bytes`);
    assert.deepEqual(JSON.parse(text), { path: "/s/x.jsonl", title: "t" });
    assert.equal(inner.headers.get("x-sova-relayed"), "1");
    assert.equal(inner.headers.get("x-forwarded-host"), "peer");
    assert.equal(seenEnv.meshPeer, who);
    assert.equal(seenEnv.incoming, 1);
    // A GET entry carries no body and no content-type.
    await runPeerCommand(new Request("http://peer/api/commands/project.get", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pid: "p1" }) }), "project.get", who, {}, { fetch, mayReach: () => true });
    const get = seen as unknown as Request;
    assert.equal(get.method, "GET");
    assert.equal(get.headers.get("content-type"), null);
  });

  test("the id is read once, as the classifier reads it, whatever the spelling", async () => {
    await grant({ preset: "sessions" });
    let n = 0;
    for (const spelling of ["/api/%63ommands/session.title.set", "/API/commands/SESSION.TITLE.SET", "/api//commands/session.title.set", "/api/commands/session.title.set/", "/api/commands/session%2etitle.set"]) {
      const path = session(`spelling-${n++}`);
      const id = peerCommandId("POST", spelling);
      const c = classifyRequest("POST", spelling);
      assert.equal(id !== null, c.rule.startsWith("command:"), spelling);
      const res = await call("POST", spelling, JSON.stringify({ session: path, title: "Spelled" }));
      if (id === "session.title.set") {
        assert.equal(res.status, 200, `${spelling}: ${res.body}`);
        assert.equal(await titleOf(path), "Spelled");
      } else {
        // Needs `full` (this peer has sessions), or is no path a peer reaches at all: refused before any route.
        assert.equal(c.need, "full", spelling);
        assert.ok((res.status === 403 && res.marker === "denied") || res.status === 404, `${spelling}: ${res.status}`);
        assert.notEqual(await titleOf(path), "Spelled");
      }
    }
  });
});

describe("only the peer listener has it", () => {
  test("the main listener's app has no such route, and the share listener's edge never lets it through", async () => {
    const path = session("main-listener");
    const res = await app.request("/api/commands/session.title.set", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session: path, title: "Main" }) });
    assert.equal(res.status, 404);
    assert.notEqual(await titleOf(path), "Main");
    assert.equal(app.routes.some((r) => r.path.startsWith("/api/commands/")), false);
    for (const id of ["session.title.set", "project.verb.status", "no.such"]) assert.equal(shareMayReach("POST", `/api/commands/${id}`), false, id);
  });
});
