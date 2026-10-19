// Run: pnpm test -- server/commands-routes.test.ts
// GET /api/commands in-process (§app.served-commands/route): the catalogue, then exactly the commands
// each installed extension's offers name, built whole; nothing from an entry the server drops; the
// server's version. Its door: the peer classifier gives it `full`, the inventory
// classes exactly that method and path as the catalogue, and the share edge never lets it through.
// Plus `sova watch`'s stream lines (shared/commands-watch.ts) and list's shape check (scripts/sova.mjs).
// A throwaway PI_CODING_AGENT_DIR and manifest; ~/.pi is never read or written. The real listeners
// and the command line's process: server/commands-served.integration.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { COMMANDS } from "../shared/commands-catalog";
import { extCommandsOf } from "../shared/commands-ext";
import { fromStreamFrame, parseCursor } from "../shared/commands-watch";
import { ROUTE_CLASSES, inventoryRoutes } from "./commands-inventory/scan";
// @ts-expect-error: a plain .mjs script, no declarations
import { allEntries, isServedList } from "../scripts/sova.mjs";

const agentDir = mkdtempSync(join(tmpdir(), "sova-commands-routes-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const manifest = join(agentDir, "extensions.json");
process.env.SOVA_EXTENSIONS_FILE = manifest;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const { testApp } = await import("./mesh/app-test-fixtures");
const app = await testApp();
const { classifyRequest } = await import("./mesh/access");
const { shareMayReach } = await import("./share/edge");

// An `api` nothing answers on (that no backend is asked at all: the integration test's recorder).
const DEAD_API = "http://127.0.0.1:9";
const ext = (id: string, commands: unknown, more: Record<string, unknown> = {}) => ({ id, dist: "/x", api: DEAD_API, commands, ...more });
const cmd = (name: string, label: string, params?: unknown) => ({ name, label, summary: `${label}, from a test`, ...(params ? { params } : {}) });

/** Five installed extensions with commands, plus what the server must leave out. */
const DOC = {
  version: 1,
  extensions: [
    ext("notes", [cmd("snap", "Take Snapshot", { n: { type: "integer", required: true } }), cmd("Bad Name", "Not valid"), cmd("tidy", "Tidy Up")]),
    ext("board", [cmd("pin", "Pin It", { text: { type: "string" } })]),
    ext("clock", [cmd("lap", "Lap"), cmd("lap", "Second Lap With A Taken Name")]),
    ext("mail", [cmd("send", "Send Mail", { to: { type: "array" } })]),
    ext("plain", "not a list"),
    ext("radio", [cmd("tune", "Tune", { freq: { type: "number" } })]),
    // Dropped by the server: a relative dist, an api off this machine, a second "notes".
    ext("broken", [cmd("never", "Never Listed")], { dist: "relative/dist" }),
    ext("away", [cmd("never", "Never Listed")], { api: "http://192.0.2.1:80" }),
    ext("notes", [cmd("shadow", "A Second Notes")]),
  ],
};
writeFileSync(manifest, JSON.stringify(DOC));

const get = async () => {
  const res = await app.request("/api/commands");
  return { status: res.status, body: (await res.json()) as { version: number; server: { version: string | null; head: string | null }; commands: Array<{ id: string }> } };
};

describe("GET /api/commands", () => {
  test("the catalogue, then each installed extension's offered commands, whole and in manifest order", async () => {
    const { status, body } = await get();
    assert.equal(status, 200);
    assert.equal(body.version, 1);
    const kept = { version: 1, extensions: DOC.extensions.filter((e) => !["broken", "away"].includes(e.id)) };
    // The same rule the command line's copy uses, on the entries the server installs.
    assert.deepEqual(body.commands, JSON.parse(JSON.stringify([...COMMANDS, ...extCommandsOf(kept)])));
    assert.deepEqual(
      body.commands.filter((c) => c.id.startsWith("ext.")).map((c) => c.id),
      ["ext.notes.snap", "ext.notes.tidy", "ext.board.pin", "ext.clock.lap", "ext.mail.send", "ext.radio.tune"],
    );
    assert.ok(isServedList(body), "the command line takes it as a served list");
  });

  test("an entry the server drops lists nothing, though the command line's own copy would list it", async () => {
    const { body } = await get();
    const ids = body.commands.map((c) => c.id);
    for (const id of ["ext.broken.never", "ext.away.never", "ext.notes.shadow"]) assert.ok(!ids.includes(id), id);
    // The copy reads the file alone: it can't know dist and api are bad, which is why the served list wins.
    const copy = (allEntries({ SOVA_EXTENSIONS_FILE: manifest }) as Array<{ id: string }>).map((c) => c.id);
    assert.ok(copy.includes("ext.broken.never") && copy.includes("ext.away.never"));
  });

  test("an edit to the manifest is in the next answer", async () => {
    writeFileSync(manifest, JSON.stringify({ version: 1, extensions: [ext("solo", [cmd("go", "Go")])] }));
    try {
      const { body } = await get();
      assert.deepEqual(body.commands.slice(COMMANDS.length).map((c) => c.id), ["ext.solo.go"]);
    } finally {
      writeFileSync(manifest, JSON.stringify(DOC));
    }
  });

  test("the server's version: package.json's, and the commit GET /api/health names", async () => {
    const { body } = await get();
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    assert.equal(body.server.version, pkg.version);
    const health = (await (await app.request("/api/health")).json()) as { head: string | null };
    assert.equal(body.server.head, health.head);
  });
});

describe("its door", () => {
  test("the peer listener's classifier gives it full, by its own rule", () => {
    assert.deepEqual(classifyRequest("GET", "/api/commands"), { need: "full", rule: "full:commands" });
  });

  test("the inventory classes exactly GET /api/commands as the catalogue, and nothing near it", () => {
    const routes = ["GET /api/commands", "POST /api/commands", "GET /api/commands/run", "POST /api/commands/x/run", "GET /api/commandsx", "GET /api/command"].map((k) => {
      const [method, path] = k.split(" ");
      return { method: method!, path: path! };
    });
    const { rows, problems } = inventoryRoutes(routes, [], () => "full");
    assert.deepEqual(problems, []);
    assert.deepEqual(
      Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, r.is])),
      { "GET /api/commands": "catalogue", "POST /api/commands": "pending", "GET /api/commands/run": "pending", "POST /api/commands/x/run": "pending", "GET /api/commandsx": "pending", "GET /api/command": "pending" },
    );
    assert.equal(ROUTE_CLASSES.filter((c) => c.matches("GET", "/api/commands")).length, 1);
  });

  test("the share listener's edge never lets it through", () => {
    assert.equal(shareMayReach("GET", "/api/commands"), false);
  });
});

describe("sova watch's lines from the stream", () => {
  const at = 1_700_000_000_000;
  const of = (f: Record<string, unknown>) => fromStreamFrame({ type: "event", seq: 7, at, id: "s1", path: "/p/s1.jsonl", ...f }, "abcdefgh12345678");

  test("each event name prints as the diff's line, plus source and cursor; at is the server's", () => {
    const base = { id: "s1", path: "/p/s1.jsonl", cursor: "abcdefgh12345678:7", at };
    assert.deepEqual(of({ name: "session.created", source: "observed", title: "T" }), { event: "created", ...base, title: "T", source: "observed" });
    assert.deepEqual(of({ name: "session.removed", source: "observed" }), { event: "removed", ...base, source: "observed" });
    assert.deepEqual(of({ name: "session.renamed", source: "observed", from: "A", title: "B" }), { event: "renamed", ...base, from: "A", title: "B", source: "observed" });
    assert.deepEqual(of({ name: "session.tagged", source: "observed", tags: { user: ["x"] } }), { event: "tagged", ...base, tags: { user: ["x"] }, source: "observed" });
    assert.deepEqual(of({ name: "session.archived", source: "observed", archived: true }), { event: "archived", ...base, archived: true, source: "observed" });
    assert.deepEqual(of({ name: "turn.started", source: "hosted" }), { event: "turn.started", ...base, source: "hosted" });
    assert.deepEqual(of({ name: "turn.ended", source: "observed" }), { event: "turn.ended", ...base, source: "observed" });
  });

  test("gaps print with their range; hello, errors and attention print nothing", () => {
    assert.deepEqual(fromStreamFrame({ type: "gap", reason: "overflow", from: 3, to: 9 }, "abcdefgh12345678"), { event: "gap", reason: "overflow", from: 3, to: 9 });
    assert.deepEqual(fromStreamFrame({ type: "gap", reason: "restarted" }, "abcdefgh12345678"), { event: "gap", reason: "restarted" });
    for (const f of [{ type: "hello", stream: "abcdefgh12345678", seq: 0, oldest: 1 }, { type: "error", message: "x" }, { type: "event", seq: 2, at, name: "attention.changed" }, { type: "event", seq: 3, at, name: "some.newer.name", id: "a", path: "b" }, null, "text"])
      assert.equal(fromStreamFrame(f, "abcdefgh12345678"), null, JSON.stringify(f));
  });

  test("--since takes exactly <stream>:<seq>", () => {
    assert.deepEqual(parseCursor("abcdefgh12345678:42"), { stream: "abcdefgh12345678", since: 42 });
    assert.deepEqual(parseCursor("abcdefgh:0"), { stream: "abcdefgh", since: 0 });
    for (const bad of ["abcdefgh12345678", ":4", "abcdefgh12345678:-1", "abcdefgh12345678:01", "ABCDEFGH:1", "short:1", "abcdefgh12345678:1:2", "abcdefgh12345678:99999999999999999"]) assert.equal(parseCursor(bad), null, bad);
  });

  test("list trusts only an answer shaped as the served list", () => {
    assert.equal(isServedList({ version: 1, commands: JSON.parse(JSON.stringify(COMMANDS)) }), true);
    for (const bad of [null, [], { version: 2, commands: COMMANDS }, { version: 1, commands: [] }, { version: 1, commands: [{ id: "x" }] }, { error: "Not found" }])
      assert.equal(isServedList(bad), false, JSON.stringify(bad));
  });
});
