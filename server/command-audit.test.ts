// Run: pnpm test -- server/command-audit.test.ts
// The record of who ran what (§app.command-audit/record, §app.command-audit/list), the class itself:
// a note never waits for the disk, batches land in one append, the file rotates into two older ones,
// a backlog past its bound drops the oldest and says how many, and the list reads newest first.
// Plus the route's mesh class: `/api/audit` needs exactly what the classifier's default gave it, and
// no other route's need moved (§mesh.peers/grants).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";
import { CommandAudit, commandName, registerAuditRoutes, type AuditRow } from "./command-audit";
import { classifyRequest } from "./mesh/access";

const tmp = mkdtempSync(join(tmpdir(), "sova-command-audit-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const dirOf = () => join(tmp, `a${++n}`);
const row = (i: number, extra: Partial<AuditRow> = {}): AuditRow => ({ at: new Date(1_700_000_000_000 + i).toISOString(), caller: "no-key", method: "GET", route: `/api/r${i}`, status: 200, ...extra });
const lines = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("a note never writes on its caller's turn; the batch lands in one append within the flush time", async () => {
  const dir = dirOf();
  const audit = new CommandAudit({ dir: () => dir, flushMs: 20 });
  audit.note(row(1));
  audit.note(row(2));
  assert.equal(existsSync(dir), false, "nothing written yet");
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(lines(audit.file()).map((r) => r.route), ["/api/r1", "/api/r2"]);
});

test("the file rotates into .1 and .2 and no more; the list reads across them, newest first", async () => {
  const dir = dirOf();
  const audit = new CommandAudit({ dir: () => dir, fileMax: 400, flushMs: 60_000 });
  for (let i = 0; i < 40; i++) {
    audit.note(row(i));
    await audit.flush();
  }
  assert.deepEqual(readdirSync(dir).sort(), ["commands.1.jsonl", "commands.2.jsonl", "commands.jsonl"]);
  for (const f of readdirSync(dir)) assert.ok(readFileSync(join(dir, f)).length <= 400, f);
  const { rows } = await audit.list({ limit: 1000 });
  assert.equal(rows[0]!.route, "/api/r39");
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1]!.at > rows[i]!.at, "newest first");
  assert.ok(rows.length < 40, "the oldest went with the third file");
});

test("a backlog past its bound drops the oldest, and the record and the list say how many", async () => {
  const dir = dirOf();
  const audit = new CommandAudit({ dir: () => dir, queueMax: 5, batchRows: 1_000, flushMs: 60_000 });
  for (let i = 0; i < 8; i++) audit.note(row(i));
  const listed = await audit.list({ limit: 100 });
  assert.equal(listed.dropped, 3);
  assert.deepEqual(listed.rows.map((r) => r.route), ["/api/r7", "/api/r6", "/api/r5", "/api/r4", "/api/r3"]);
  await audit.flush();
  const written = lines(audit.file());
  assert.equal(written[0].dropped, 3);
  assert.deepEqual(written.slice(1).map((r) => r.route), ["/api/r3", "/api/r4", "/api/r5", "/api/r6", "/api/r7"]);
});

test("the list filters by caller and command and stops at its limit, queued rows included", async () => {
  const dir = dirOf();
  const audit = new CommandAudit({ dir: () => dir, flushMs: 60_000 });
  audit.note(row(1, { caller: "chat:a", command: "session.list" }));
  audit.note(row(2, { caller: "chat:b" }));
  await audit.flush();
  audit.note(row(3, { caller: "chat:a" }));
  assert.deepEqual((await audit.list({ caller: "chat:a" })).rows.map((r) => r.route), ["/api/r3", "/api/r1"]);
  assert.deepEqual((await audit.list({ command: "session.list" })).rows.map((r) => r.route), ["/api/r1"]);
  assert.deepEqual((await audit.list({ limit: 1 })).rows.map((r) => r.route), ["/api/r3"]);
});

test("GET /api/audit: its bounds are refused with a sentence; a good call answers rows", async () => {
  const dir = dirOf();
  const audit = new CommandAudit({ dir: () => dir, flushMs: 60_000 });
  audit.note(row(1));
  const app = new Hono();
  registerAuditRoutes(app, audit);
  for (const q of ["limit=0", "limit=1001", "limit=abc", "limit=1.5", "limit=-1", `caller=${"x".repeat(129)}`, `command=${"x".repeat(129)}`]) {
    const res = await app.request(`/api/audit?${q}`);
    assert.equal(res.status, 400, q);
    assert.match(((await res.json()) as { error: string }).error, /\.$/, q);
  }
  const ok = await app.request("/api/audit?limit=5");
  assert.equal(ok.status, 200);
  assert.deepEqual(((await ok.json()) as { rows: AuditRow[] }).rows.map((r) => r.route), ["/api/r1"]);
});

test("a damaged line is skipped, never the list's failure; a write that fails is logged, not thrown", async () => {
  const dir = dirOf();
  const logs: string[] = [];
  const audit = new CommandAudit({ dir: () => dir, flushMs: 60_000, log: (l) => logs.push(l) });
  audit.note(row(1));
  await audit.flush();
  writeFileSync(audit.file(), `${readFileSync(audit.file(), "utf8")}{not json\n`);
  assert.deepEqual((await audit.list()).rows.map((r) => r.route), ["/api/r1"]);
  const blocked = join(tmp, "blocked");
  writeFileSync(blocked, "a file where the dir would go");
  const broken = new CommandAudit({ dir: () => join(blocked, "audit"), flushMs: 60_000, log: (l) => logs.push(l) });
  broken.note(row(2));
  await broken.flush();
  assert.equal(logs.length, 1);
});

test("a command name is kept only when it is a catalogue id or an extension's", () => {
  assert.equal(commandName("session.list"), "session.list");
  assert.equal(commandName(" audit.list "), "audit.list");
  assert.equal(commandName("ext.notes.snap"), "ext.notes.snap");
  for (const bad of [undefined, "", "made.up", "session.list\nforged", "ext.", `ext.a.${"x".repeat(200)}`]) assert.equal(commandName(bad), undefined, String(bad));
  // Every command a valid extension id can declare (§app.extensions/backend-key): the manifest's id alphabet.
  for (const good of ["ext.Notes.x", "ext.My_Ext.ping", "ext.a.b.c", "ext.v1.2.run-it"]) assert.equal(commandName(good), good, good);
  // And nothing else: a name outside the command alphabet, an empty or slashed id, an id past the
  // length, and core-id lookalikes that are no extension's.
  for (const bad of ["ext.notes.Bad", "ext..x", "ext.a/b.x", `ext.${"a".repeat(120)}.x`, "ext.audit", "Ext.notes.x", "ext.session"]) assert.equal(commandName(bad), undefined, bad);
});

test("/api/audit needs what the classifier's default gave it, and no registered route's need moved", () => {
  const def = classifyRequest("GET", "/api/zz-no-rule-here");
  assert.equal(def.rule, "default");
  for (const m of ["GET", "POST"]) {
    assert.equal(classifyRequest(m, "/api/audit").need, def.need);
    assert.equal(classifyRequest(m, "/api/audit").rule, "full:audit");
  }
  // An exact segment: names that only start with "audit" still fall to the default.
  for (const p of ["/api/auditx", "/api/audit-log", "/api/audits"]) assert.equal(classifyRequest("GET", p).rule, "default", p);
  const baseline = JSON.parse(readFileSync(new URL("./commands-inventory/baseline.json", import.meta.url), "utf8")).routes as Record<string, { need: string }>;
  let swept = 0;
  for (const [key, { need }] of Object.entries(baseline)) {
    const [method, path] = key.split(" ") as [string, string];
    const concrete = path.replace(/:[^/]+/g, "x").replace(/\*/g, "x");
    assert.equal(classifyRequest(method === "ALL" ? "GET" : method, concrete).need, need, key);
    swept++;
  }
  assert.ok(swept > 400, `${swept} routes swept`);
  // Sentinels written here, not regenerated: the sweep above compares against a baseline a
  // regeneration would move with the code.
  assert.equal(classifyRequest("GET", "/api/sessions").need, "sessions");
  assert.equal(classifyRequest("PUT", "/api/settings/align").need, "admin");
  assert.equal(classifyRequest("GET", "/api/commands").need, "full");
  assert.equal(classifyRequest("GET", "/api/settings/align").need, "sessions");
});

test("a written line parses back to exactly its row", async () => {
  const dir = dirOf();
  const audit = new CommandAudit({ dir: () => dir, flushMs: 60_000 });
  const rows = [row(1), row(2, { caller: "chat:a\"b", command: "session.list", route: "/api/x/:id" }), row(3, { caller: "unattributed", method: "POST", status: 401 })];
  for (const r of rows) audit.note(r);
  await audit.flush();
  assert.deepEqual(lines(audit.file()), rows);
  assert.ok(readFileSync(audit.file(), "utf8").endsWith("}\n"));
});
