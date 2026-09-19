// Runs under plain `node --test` (type stripping); exercises bin/pi-sessions.ts as a subprocess.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { LiveRecord } from "./schema.ts";

const BIN = fileURLToPath(new URL("./bin/pi-sessions.ts", import.meta.url));
const example = (name: string): LiveRecord =>
  JSON.parse(readFileSync(new URL(`./public/examples/${name}.json`, import.meta.url), "utf8"));
// No Hyprland instance: even a gate bug could never reach a real focus.
const env = { ...process.env, HYPRLAND_INSTANCE_SIGNATURE: "", PI_SESSIONS_DIR: "" };

/** A fresh (alive pid = this test process, heartbeat now) copy of an example. */
function record(id: string, base: string, patch: (r: LiveRecord) => void = () => {}, heartbeat = Date.now()): LiveRecord {
  const r = example(base);
  r.session.id = id; r.session.pid = process.pid; r.heartbeat = heartbeat; r.session.lastActivity = heartbeat;
  if (r.presence?.target) r.presence.target.origin.pid = process.pid;
  patch(r);
  return r;
}
const put = (dir: string, r: LiveRecord) => writeFileSync(join(dir, `${r.session.id}.json`), JSON.stringify(r));
const run = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env, timeout: 10_000 });
const json = (text: string) => JSON.parse(text);

function withDir(fn: (dir: string) => void | Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sessions-cli-"));
    try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}

function fixtureDir(dir: string) {
  const now = Date.now();
  put(dir, record("p1-aaaaaaaa", "v1", r => { r.session.name = "zeta idle"; r.presence!.status = "Idle"; }));
  put(dir, record("p2-bbbbbbbb", "v2", r => {
    r.session.name = "alpha asks";
    r.presence!.activity = { state: "needs-input", since: now - 120_000 };
  }));
  put(dir, record("p3-cccccccc", "v2", r => { r.session.name = "stale one"; }, now - 60_000));
  writeFileSync(join(dir, "p4-dddddddd.json"), "{ not json");
}

test("snapshot: fresh-only, sorted, --include-stale, malformed is skipped", withDir(dir => {
  fixtureDir(dir);
  const res = run("snapshot", "--dir", dir);
  assert.equal(res.status, 0, res.stderr);
  const snap = json(res.stdout);
  assert.equal(snap.type, "snapshot");
  assert.equal(typeof snap.at, "number");
  assert.deepEqual(snap.sessions.map((s: { id: string }) => s.id), ["p2-bbbbbbbb", "p1-aaaaaaaa"]);
  assert.ok(snap.sessions.every((s: { fresh: boolean }) => s.fresh));

  const all = json(run("snapshot", "--include-stale", "--dir", dir).stdout);
  assert.deepEqual(all.sessions.map((s: { id: string }) => s.id), ["p2-bbbbbbbb", "p1-aaaaaaaa", "p3-cccccccc"]);
  assert.equal(all.sessions[2].fresh, false);

  // env override is honoured; --dir wins over it
  const viaEnv = spawnSync(process.execPath, [BIN, "snapshot"], { encoding: "utf8", env: { ...env, PI_SESSIONS_DIR: dir } });
  assert.equal(json(viaEnv.stdout).sessions.length, 2);
  const empty = mkdtempSync(join(tmpdir(), "pi-sessions-cli-"));
  try {
    const flagWins = spawnSync(process.execPath, [BIN, "snapshot", "--dir", empty], { encoding: "utf8", env: { ...env, PI_SESSIONS_DIR: dir } });
    assert.deepEqual(json(flagWins.stdout).sessions, []);
  } finally { rmSync(empty, { recursive: true, force: true }); }
}));

test("snapshot sort: attention, then working by recency, then idle by name", withDir(dir => {
  const now = Date.now();
  put(dir, record("p1-00000001", "v1", r => { r.session.name = "b idle"; r.presence!.status = "Idle"; }));
  put(dir, record("p1-00000002", "v1", r => { r.session.name = "a idle"; r.presence!.status = "Idle"; }));
  put(dir, record("p1-00000003", "v1", r => { r.session.name = "old work"; }, now - 5000));
  put(dir, record("p1-00000004", "v1", r => { r.session.name = "new work"; }));
  put(dir, record("p1-00000005", "v1", r => { r.session.name = "broken"; r.presence!.status = "Error"; }));
  put(dir, record("p1-00000006", "v1", r => { r.session.name = "asks"; r.presence!.status = "Needs input"; }));
  const names = json(run("snapshot", "--dir", dir).stdout).sessions.map((s: LiveRecord & { record: LiveRecord }) => s.record.session.name);
  assert.deepEqual(names, ["asks", "broken", "new work", "old work", "a idle", "b idle"]);
}));

test("menu dmenu: glyphs, labels, heading/worker segments, trailing tab+id", withDir(dir => {
  fixtureDir(dir);
  put(dir, record("p5-eeeeeeee", "legacy", r => { r.session.name = "plain\tname"; r.session.status = "Running: read"; }));
  const res = run("menu", "--dir", dir);
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 3); // stale and malformed excluded
  for (const line of lines) assert.match(line, /^[^\t]+\tp\d-[0-9a-f]{8}$/);
  assert.match(lines[0], /^⚑ alpha asks · needs input 2m · # Auth fix · ◆1\/3\tp2-bbbbbbbb$/);
  assert.equal(lines[1], "● plain name · working\tp5-eeeeeeee");
  assert.match(lines[2], /^○ zeta idle · idle \d+[smhd] · # Auth fix · ◆1\/1\tp1-aaaaaaaa$/);

  const asJson = json(run("menu", "--format", "json", "--dir", dir).stdout);
  assert.deepEqual(asJson.map((s: { id: string }) => s.id), ["p2-bbbbbbbb", "p5-eeeeeeee", "p1-aaaaaaaa"]);
  assert.equal(run("menu", "--format", "rofi", "--dir", dir).status, 2);
}));

test("focus: resolution and gates fail before any focus attempt", withDir(dir => {
  put(dir, record("p1-11111111", "legacy", r => { r.session.name = "web one"; }));
  put(dir, record("p2-22222222", "legacy", r => { r.session.name = "Web two"; }));
  put(dir, record("p3-33333333", "v2", r => {
    r.session.name = "preview only";
    r.presence!.focusable = false; r.presence!.focusReason = "tmux pane is hidden";
  }));
  put(dir, record("p4-44444444", "v2", r => { r.session.name = "foreign"; r.presence!.target!.origin.pid = 1; }));
  put(dir, record("p5-55555555", "legacy", r => { r.session.name = "gone quiet"; }, Date.now() - 60_000));
  writeFileSync(join(dir, "p6-66666666.json"), "garbage");

  const focus = (q: string) => { const res = run("focus", q, "--dir", dir); return { status: res.status, body: json(res.stdout) }; };

  assert.deepEqual(focus("p9-99999999"), { status: 1, body: { ok: false, reason: "not found" } });
  const amb = focus("WEB");
  assert.equal(amb.status, 1);
  assert.equal(amb.body.reason, "ambiguous");
  assert.deepEqual(amb.body.candidates, [{ id: "p1-11111111", name: "web one" }, { id: "p2-22222222", name: "Web two" }]);

  // exact id, id prefix and name substring all resolve, then hit the presence gate
  for (const q of ["p1-11111111", "p1-", "web ONE"]) {
    const r = focus(q);
    assert.equal(r.status, 1);
    assert.deepEqual(r.body, { ok: false, id: "p1-11111111", reason: "no rich presence published (reload that session)" });
  }
  assert.deepEqual(focus("preview").body, { ok: false, id: "p3-33333333", reason: "tmux pane is hidden" });
  assert.deepEqual(focus("foreign").body, { ok: false, id: "p4-44444444", reason: "focus target does not belong to this session's process" });
  const stale = focus("gone quiet").body;
  assert.equal(stale.ok, false); assert.equal(stale.id, "p5-55555555"); assert.match(stale.reason, /^stale/);
  assert.deepEqual(focus("p6-66666666").body, { ok: false, id: "p6-66666666", reason: "record is unreadable or invalid" });
  for (const r of [amb, focus("p3-33333333"), focus("p4")]) assert.ok(!JSON.stringify(r.body).includes("0x55d3a8c0f2a0"));
}));

test("usage errors exit 2 with text on stderr", () => {
  for (const args of [[], ["--help"], ["bogus"], ["snapshot", "--nope"], ["focus"], ["watch", "--snapshot-every", "soon"], ["menu", "--include-stale"]]) {
    const res = run(...args);
    assert.equal(res.status, 2, `args ${args.join(" ")}`);
    assert.ok(res.stderr.includes("usage: pi-sessions"));
    assert.equal(res.stdout, "");
  }
});

/** Spawn `watch` and pull NDJSON events with per-event deadlines. */
function watcher(dir: string, ...args: string[]) {
  const child = spawn(process.execPath, [BIN, "watch", "--dir", dir, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  const queue: Record<string, unknown>[] = [];
  let wake: (() => void) | undefined;
  createInterface({ input: child.stdout! }).on("line", line => { queue.push(JSON.parse(line)); wake?.(); });
  const exited = new Promise<number | null>(resolve => child.on("exit", code => resolve(code)));
  async function next(timeout = 5000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeout;
    while (!queue.length) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("timed out waiting for a watch event");
      await new Promise<void>(resolve => { wake = resolve; setTimeout(resolve, left); });
      wake = undefined;
    }
    return queue.shift()!;
  }
  return { child, next, exited, queue };
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("watch: hello, snapshot, upsert, heartbeat silence, error once, remove, SIGINT", withDir(async dir => {
  put(dir, record("p1-aaaaaaaa", "v1"));
  const w = watcher(dir);
  try {
    const hello = await w.next();
    assert.equal(hello.type, "hello"); assert.equal(hello.dir, dir); assert.equal(hello.feedVersion, 1);
    const snap = await w.next();
    assert.equal(snap.type, "snapshot");
    assert.deepEqual((snap.sessions as { id: string }[]).map(s => s.id), ["p1-aaaaaaaa"]);
    await pause(150); // let fs.watch settle

    put(dir, record("p2-bbbbbbbb", "v2"));
    const up = await w.next();
    assert.equal(up.type, "upsert");
    assert.equal((up.session as { id: string }).id, "p2-bbbbbbbb");
    assert.deepEqual(up.changed, ["session", "presence"]);

    const later = Date.now() + 1000;
    put(dir, record("p2-bbbbbbbb", "v2", () => {}, later)); // heartbeat-only rewrite
    writeFileSync(join(dir, "p3-cccccccc.json"), "{ broken");
    const err = await w.next();
    assert.equal(err.type, "error");
    assert.match(err.message as string, /p3-cccccccc\.json/);
    writeFileSync(join(dir, "p3-cccccccc.json"), "{ still broken");
    await pause(300);

    put(dir, record("p2-bbbbbbbb", "v2", r => { r.session.name = "renamed"; }, later));
    const renamed = await w.next();
    assert.equal(renamed.type, "upsert");
    assert.deepEqual(renamed.changed, ["session.name"]);

    unlinkSync(join(dir, "p1-aaaaaaaa.json"));
    assert.deepEqual({ ...(await w.next()), at: 0 }, { type: "remove", at: 0, id: "p1-aaaaaaaa", reason: "left" });

    writeFileSync(join(dir, "p2-bbbbbbbb.json"), "not json anymore");
    const invalid = await w.next();
    const tail = [invalid, await w.next()].map(e => ({ ...e, at: 0 }));
    assert.deepEqual(new Set(tail.map(e => JSON.stringify(e))), new Set([
      JSON.stringify({ type: "error", at: 0, message: "invalid record: p2-bbbbbbbb.json" }),
      JSON.stringify({ type: "remove", at: 0, id: "p2-bbbbbbbb", reason: "invalid" }),
    ]));
    await pause(300);
    assert.equal(w.queue.length, 0, `unexpected events: ${JSON.stringify(w.queue)}`);
  } finally {
    w.child.kill("SIGINT");
  }
  assert.equal(await w.exited, 0);
}));

test("watch --heartbeats and --snapshot-every", withDir(async dir => {
  put(dir, record("p1-aaaaaaaa", "v1"));
  const w = watcher(dir, "--heartbeats", "--snapshot-every", "700ms");
  try {
    assert.equal((await w.next()).type, "hello");
    assert.equal((await w.next()).type, "snapshot");
    await pause(150);
    put(dir, record("p1-aaaaaaaa", "v1", () => {}, Date.now() + 1000));
    const beat = await w.next();
    assert.equal(beat.type, "upsert");
    assert.deepEqual(beat.changed, ["heartbeat", "session.lastActivity"]);
    const again = await w.next();
    assert.equal(again.type, "snapshot");
    assert.equal((again.sessions as unknown[]).length, 1);
  } finally {
    w.child.kill("SIGTERM");
  }
  assert.equal(await w.exited, 0);
}));

test("watch exits 0 quietly when the consumer closes stdout", withDir(async dir => {
  const res = spawnSync("bash", ["-o", "pipefail", "-c", `"$0" "$1" watch --dir "$2" --snapshot-every 100ms 2>/tmp/.x-$$ | head -n 1; s=$?; cat /tmp/.x-$$ >&2; rm -f /tmp/.x-$$; exit $s`,
    process.execPath, BIN, dir], { encoding: "utf8", env, timeout: 10_000 });
  assert.equal(json(res.stdout).type, "hello");
  assert.equal(res.stderr, "");
  assert.equal(res.status, 0);
}));
