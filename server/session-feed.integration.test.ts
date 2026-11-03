// Run: node scripts/run-tests.mjs server/session-feed.integration.test.ts
// The change-driven session feed on a hermetic server (§app.decisions/push): a TUI session's live
// record changes only its status, and a connected feed hears list_changed within 6 s; the record
// asking for input reaches the feed as a pushed attention digest; nothing is pushed while nothing
// changes. A commit in a session's worktree, with no write to its session file, flips the row's
// merge readiness within about 6 s. A group made or a session assigned through the API reaches two connected feeds
// at once as groups_changed.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { startHermeticServer, type HermeticServer } from "./testing/hermetic-server";

let s: HermeticServer;
let tui: ChildProcess;
before(async () => {
  s = await startHermeticServer();
  // A stand-in TUI: any live process, so its live record counts.
  tui = spawn("sleep", ["300"], { stdio: "ignore" });
});
after(async () => {
  tui?.kill();
  const changed = await s?.stop();
  assert.deepEqual(changed ?? [], [], "the sentinel home is untouched");
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a live record's status alone reaches a connected feed as list_changed within 6 s; a dialog as an attention push", async () => {
  const dir = join(s.agentDir, "sessions", "--tui-work--");
  mkdirSync(dir, { recursive: true });
  const sessionFile = join(dir, "2026-10-22T00-00-00-000Z_feedtest.jsonl");
  const id = "01234567-89ab-7cde-8f01-00000000fe01";
  writeFileSync(
    sessionFile,
    [
      { type: "session", version: 3, id, timestamp: "2026-10-22T00:00:00.000Z", cwd: s.work },
      { type: "message", id: "m1", parentId: null, timestamp: "2026-10-22T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );
  const liveDir = join(s.agentDir, "sessions", "live");
  mkdirSync(liveDir, { recursive: true });
  const live = join(liveDir, `${tui.pid}.json`);
  const writeLive = (presence: Record<string, unknown>) => {
    // As writers do: tmp + rename, a new inode per write.
    const tmp = join(liveDir, `.${tui.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify({ heartbeat: Date.now(), session: { pid: tui.pid, sessionFile, mode: "tui", status: "idle" }, presence }));
    renameSync(tmp, live);
  };
  writeLive({ status: "idle", activity: { state: "idle", since: 1 } });

  const sock = new WebSocket(`${s.base.replace(/^http/, "ws")}/ws/watch?feed=sessions`, { headers: { "x-sova-token": s.token } });
  const got: { m: any; t: number }[] = [];
  sock.on("message", (d) => got.push({ m: JSON.parse(String(d)), t: Date.now() }));
  await new Promise<void>((r, j) => (sock.once("open", () => r()), sock.once("error", j)));
  const until = async (pred: (m: any) => boolean, ms: number) => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = got.find((x) => pred(x.m));
      if (hit) return hit;
      if (Date.now() > end) return null;
      await sleep(50);
    }
  };
  try {
    assert.ok(await until((m) => m.type === "marks" && m.full, 30_000), `no snapshot; got ${JSON.stringify(got.map((x) => x.m.type))}\n${s.log().slice(-2000)}`);
    // The row is listed with its live record before the test changes anything.
    const listed = await (await fetch(`${s.base}/api/sessions`, { headers: { "x-sova-token": s.token } })).json();
    assert.ok(listed.some((r: any) => r.path === sessionFile && r.live), "the TUI session is listed live");

    // Heartbeats alone (the record rewritten, nothing it says changed) are no change.
    await sleep(1500);
    got.length = 0;
    for (let i = 0; i < 3; i++) {
      writeLive({ status: "idle", activity: { state: "idle", since: 1 } });
      await sleep(700);
    }
    assert.ok(!got.some((x) => x.m.type === "list_changed" || x.m.type === "attention"), `a heartbeat pushed ${JSON.stringify(got.map((x) => x.m.type))}`);

    // Only the status changes.
    const t0 = Date.now();
    writeLive({ status: "busy", activity: { state: "idle", since: 1 } });
    const changed = await until((m) => m.type === "list_changed", 6_000);
    assert.ok(changed, `no list_changed within 6 s; got ${JSON.stringify(got.map((x) => x.m.type))}\n${s.log().slice(-2000)}`);
    assert.ok(changed.t - t0 <= 6_000);

    // A dialog open in the TUI: the digest gains a Needs you item, pushed, no request made.
    got.length = 0;
    writeLive({ status: "busy", activity: { state: "needs-input", since: Date.now() } });
    const pushed = await until((m) => m.type === "attention" && m.digest.items.some((i: any) => i.path === sessionFile), 6_000);
    assert.ok(pushed, `no attention push; got ${JSON.stringify(got.map((x) => x.m.type))}`);
  } finally {
    sock.close();
  }
});

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd: string, file: string, text: string) => {
  writeFileSync(join(cwd, file), `${text}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", text);
};

test("a commit in a session's worktree, with no session-file write, reaches a connected feed: list_changed and the row's readiness flip within about 6 s", async () => {
  const repo = join(s.scratch, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "master");
  commit(repo, "a.txt", "one");
  const base = git(repo, "rev-parse", "HEAD");
  const wtPath = join(s.scratch, "wt-feed");
  git(repo, "worktree", "add", "-q", "-b", "feat/feed-watch", wtPath);
  const wt = realpathSync(wtPath);
  const id = "01234567-89ab-7cde-8f01-00000000fe02";
  const dir = join(s.agentDir, "sessions", "--repo-feed--");
  mkdirSync(dir, { recursive: true });
  const sessionFile = join(dir, `2026-10-22T00-00-10-000Z_${id}.jsonl`);
  const lines = [
    { type: "session", version: 3, id, timestamp: "2026-10-22T00:00:10.000Z", cwd: realpathSync(repo) },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-10-22T00:00:11.000Z", message: { role: "user", content: [{ type: "text", text: "make the change" }], timestamp: 1 } },
    { type: "custom", customType: "worktrees", id: "w1", parentId: "u1", timestamp: "2026-10-22T00:00:12.000Z", data: { version: 1, trees: [{ path: wt, branch: "feat/feed-watch", base, baseBranch: "master", status: "active", session: id, how: "created", at: 1 }] } },
    { type: "message", id: "a1", parentId: "w1", timestamp: "2026-10-22T00:00:13.000Z", message: { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop", timestamp: 2 } },
  ];
  writeFileSync(sessionFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const sock = new WebSocket(`${s.base.replace(/^http/, "ws")}/ws/watch?feed=sessions`, { headers: { "x-sova-token": s.token } });
  const got: { m: any; t: number }[] = [];
  sock.on("message", (d) => got.push({ m: JSON.parse(String(d)), t: Date.now() }));
  await new Promise<void>((r, j) => (sock.once("open", () => r()), sock.once("error", j)));
  const rowState = async (): Promise<string | undefined> => {
    const rows = (await (await fetch(`${s.base}/api/sessions`, { headers: { "x-sova-token": s.token } })).json()) as any[];
    return rows.find((r) => r.path === sessionFile)?.readiness?.trees?.[0]?.state;
  };
  try {
    // Readiness is read in the background: wait for the first answer (no commit of its own yet).
    let state: string | undefined;
    for (let i = 0; i < 100 && state === undefined; i++) {
      state = await rowState();
      if (state === undefined) await sleep(200);
    }
    assert.equal(state, "in-progress", `before the commit; log:\n${s.log().slice(-1500)}`);
    await sleep(1500); // let the answer's own list_changed pass
    got.length = 0;
    const t0 = Date.now();
    commit(wt, "b.txt", "the feature");
    let changed: { t: number } | undefined;
    let flipped = false;
    while (Date.now() - t0 < 6_500 && !(changed && flipped)) {
      changed ??= got.find((x) => x.m.type === "list_changed");
      if (changed && !flipped) flipped = (await rowState()) === "ready";
      if (!(changed && flipped)) await sleep(100);
    }
    assert.ok(changed, `no list_changed within 6.5 s; got ${JSON.stringify(got.map((x) => x.m.type))}`);
    assert.ok(flipped, `readiness did not flip to ready; now ${await rowState()}`);
    assert.ok(changed.t - t0 <= 6_500, `list_changed after ${changed.t - t0} ms`);
  } finally {
    sock.close();
  }
});

test("a group change made by any client reaches every connected feed at once as groups_changed", async () => {
  const id = "01234567-89ab-7cde-8f01-00000000fe03";
  const dir = join(s.agentDir, "sessions", "--groups-feed--");
  mkdirSync(dir, { recursive: true });
  const sessionFile = join(dir, `2026-10-22T00-00-20-000Z_${id}.jsonl`);
  writeFileSync(
    sessionFile,
    [
      { type: "session", version: 3, id, timestamp: "2026-10-22T00:00:20.000Z", cwd: s.work },
      { type: "message", id: "m1", parentId: null, timestamp: "2026-10-22T00:00:21.000Z", message: { role: "user", content: [{ type: "text", text: "group me" }], timestamp: 1 } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );
  const headers = { "x-sova-token": s.token, "content-type": "application/json" };
  // Two windows: what one does, the other hears.
  const open = async () => {
    const sock = new WebSocket(`${s.base.replace(/^http/, "ws")}/ws/watch?feed=sessions`, { headers: { "x-sova-token": s.token } });
    const got: any[] = [];
    sock.on("message", (d) => got.push(JSON.parse(String(d))));
    await new Promise<void>((r, j) => (sock.once("open", () => r()), sock.once("error", j)));
    return { sock, got };
  };
  const a = await open();
  const b = await open();
  const until = async (got: any[], pred: (m: any) => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (got.some(pred)) return true;
      await sleep(25);
    }
    return false;
  };
  try {
    for (const w of [a, b]) assert.ok(await until(w.got, (m) => m.type === "marks" && m.full, 30_000), "no snapshot");
    assert.ok(!a.got.some((m) => m.type === "groups_changed"), "nothing on connect");
    const made = await fetch(`${s.base}/api/session-groups`, { method: "POST", headers, body: JSON.stringify({ name: "Spec audit" }) });
    assert.equal(made.status, 201);
    const group = ((await made.json()) as { id: string }).id;
    for (const w of [a, b]) assert.ok(await until(w.got, (m) => m.type === "groups_changed", 2_000), "create was not pushed");
    for (const w of [a, b]) w.got.length = 0;
    const t0 = Date.now();
    const assigned = await fetch(`${s.base}/api/session-groups/assign`, { method: "POST", headers, body: JSON.stringify({ path: sessionFile, groupId: group }) });
    assert.equal(assigned.status, 200, await assigned.text());
    for (const w of [a, b]) assert.ok(await until(w.got, (m) => m.type === "groups_changed", 2_000), `assign was not pushed; got ${JSON.stringify(w.got.map((m) => m.type))}`);
    assert.ok(Date.now() - t0 < 2_000, "at once, not at a poll");
    const listed = (await (await fetch(`${s.base}/api/session-groups`, { headers })).json()) as { id: string; members?: { id: string }[] }[];
    assert.ok(listed.find((g) => g.id === group)?.members?.some((m) => m.id === id), "the re-read shows the member");
  } finally {
    a.sock.close();
    b.sock.close();
  }
});
