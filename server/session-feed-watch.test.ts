// What tells the session feed to compare (§app.decisions/push): file watches over temp folders and
// a stubbed live-record signature. No server, no ~/.pi.
import assert from "node:assert/strict";
import { type FSWatcher, mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { sessionsChanged } from "./list-generation";
import { watchFeedInputs } from "./session-feed-watch";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "feed-watch-"));
  dirs.push(root);
  const sessionsDir = join(root, "sessions");
  const liveDir = join(sessionsDir, "live");
  const extra = join(root, "org-sessions");
  mkdirSync(join(sessionsDir, "--w--"), { recursive: true });
  mkdirSync(liveDir, { recursive: true });
  mkdirSync(extra, { recursive: true });
  return { sessionsDir, liveDir, extra };
}

/** Wait until `pred` holds, up to `ms`. */
async function until(pred: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(20);
  }
  return pred();
}

describe("watchFeedInputs", () => {
  test("a session file written in a cwd folder, at the top, in a new folder or an extra root is a change", async () => {
    const f = fixture();
    let n = 0;
    const stop = watchFeedInputs(() => n++, { sessionsDir: f.sessionsDir, liveDir: f.liveDir, roots: () => [f.extra], liveSignature: () => "same" });
    try {
      writeFileSync(join(f.sessionsDir, "--w--", "a.jsonl"), "{}\n");
      assert.ok(await until(() => n > 0), "a cwd folder's session");
      n = 0;
      writeFileSync(join(f.extra, "b.jsonl"), "{}\n");
      assert.ok(await until(() => n > 0), "an extra root's session");
      n = 0;
      mkdirSync(join(f.sessionsDir, "--new--"));
      await sleep(400); // the folder set is re-read
      writeFileSync(join(f.sessionsDir, "--new--", "c.jsonl"), "{}\n");
      assert.ok(await until(() => n > 0), "a new folder's session");
      n = 0;
      writeFileSync(join(f.sessionsDir, "--w--", "notes.txt"), "x");
      await sleep(300);
      assert.equal(n, 0, "a file that is no session is no change");
    } finally {
      stop();
    }
  });

  test("`files` hears each session file's full path before the change, and null when a folder joins or leaves", async () => {
    const f = fixture();
    const heard: (string | null)[] = [];
    let atChange = -1;
    const stop = watchFeedInputs(() => (atChange = heard.length), {
      sessionsDir: f.sessionsDir,
      liveDir: f.liveDir,
      roots: () => [f.extra],
      liveSignature: () => "same",
      files: (p) => heard.push(p),
    });
    try {
      const a = join(f.sessionsDir, "--w--", "a.jsonl");
      writeFileSync(a, "{}\n");
      assert.ok(await until(() => heard.includes(a)), "a cwd folder's session, by full path");
      assert.ok(atChange > heard.indexOf(a), "noted before the change");
      const b = join(f.extra, "b.jsonl");
      writeFileSync(b, "{}\n");
      assert.ok(await until(() => heard.includes(b)), "an extra root's session");
      assert.equal(heard.includes(null), false, "no null for file events");
      writeFileSync(join(f.sessionsDir, "--w--", "notes.txt"), "x");
      mkdirSync(join(f.sessionsDir, "--new--"));
      assert.ok(await until(() => heard.includes(null)), "a folder added to the watched set");
      assert.equal(heard.some((p) => p?.endsWith("notes.txt")), false, "a file that is no session is never named");
      heard.length = 0;
      rmSync(join(f.sessionsDir, "--new--"), { recursive: true });
      assert.ok(await until(() => heard.includes(null)), "a folder gone");
    } finally {
      stop();
    }
  });

  test("a live record is a change only when its signature moves: a heartbeat alone is none", async () => {
    const f = fixture();
    let sig = "s1";
    let n = 0;
    const stop = watchFeedInputs(() => n++, { sessionsDir: f.sessionsDir, liveDir: f.liveDir, roots: () => [], liveSignature: () => sig, liveCheckMs: 60_000 });
    try {
      writeFileSync(join(f.liveDir, "1.json"), "{}"); // a heartbeat rewrite
      await sleep(400);
      assert.equal(n, 0);
      sig = "s2"; // its status moved
      writeFileSync(join(f.liveDir, "1.json"), "{}");
      assert.ok(await until(() => n === 1), "a changed record");
    } finally {
      stop();
    }
  });

  test("the periodic live check catches a change no file event tells of (a process that died)", async () => {
    const f = fixture();
    let sig = "alive";
    let n = 0;
    const stop = watchFeedInputs(() => n++, { sessionsDir: f.sessionsDir, liveDir: f.liveDir, roots: () => [], liveSignature: () => sig, liveCheckMs: 100 });
    try {
      await sleep(250);
      assert.equal(n, 0);
      sig = "dead";
      assert.ok(await until(() => n === 1, 1000));
    } finally {
      stop();
    }
  });

  test("an in-process store write (the list generation) is a change; nothing after stop", async () => {
    const f = fixture();
    let n = 0;
    const stop = watchFeedInputs(() => n++, { sessionsDir: f.sessionsDir, liveDir: f.liveDir, roots: () => [], liveSignature: () => "x" });
    sessionsChanged();
    assert.equal(n, 1);
    stop();
    sessionsChanged();
    writeFileSync(join(f.sessionsDir, "--w--", "d.jsonl"), "{}\n");
    await sleep(300);
    assert.equal(n, 1);
  });
});

describe("watchFeedInputs with a scope (§app.session-list/live-watch-scope)", () => {
  test("a cold folder is left unwatched; a hot one, and one opened, are watched, and re-watching reads only that folder's files", async () => {
    const f = fixture();
    const cold = join(f.sessionsDir, "--cold--");
    const hot = join(f.sessionsDir, "--hot--");
    const homes = join(f.sessionsDir, "..", "homes");
    const home = join(homes, "h1", "sessions");
    const fresh = join(homes, "h2", "sessions");
    for (const d of [cold, hot, home]) mkdirSync(d, { recursive: true });
    const old = new Date(Date.now() - 30 * 86_400_000);
    writeFileSync(join(home, "old.jsonl"), "{}\n");
    utimesSync(join(home, "old.jsonl"), old, old);
    for (const d of [cold, hot, home, join(f.sessionsDir, "--w--")]) utimesSync(d, old, old);
    const hotSet = new Set([hot, home]);
    const active = new Set<string>();
    const heard: (string | null)[] = [];
    const stop = watchFeedInputs(() => {}, {
      sessionsDir: f.sessionsDir,
      liveDir: f.liveDir,
      roots: () => [],
      liveSignature: () => "same",
      liveCheckMs: 50,
      resyncMs: 300,
      files: (p) => heard.push(p),
      scope: { hot: () => new Set([...hotSet, ...active]), active: () => active, folders: () => [home], accepts: (d) => d === fresh },
    });
    const named = (end: string) => heard.some((p) => p?.endsWith(end));
    try {
      writeFileSync(join(cold, "a.jsonl"), "{}\n");
      utimesSync(cold, old, old);
      writeFileSync(join(hot, "b.jsonl"), "{}\n");
      assert.ok(await until(() => named("b.jsonl")), "a hot folder is watched");
      await sleep(200);
      assert.equal(named("a.jsonl"), false, "a cold folder is not");
      hotSet.delete(home); // turns cold: dropped at the next re-sync
      await sleep(500);
      writeFileSync(join(home, "c.jsonl"), "{}\n");
      utimesSync(home, old, old);
      await sleep(200);
      assert.equal(named("c.jsonl"), false, "a home gone cold is not watched");
      active.add(home); // opened: watched at once, not at the next re-sync
      assert.ok(await until(() => named("c.jsonl")), "the file written while unwatched is noted when it is watched again");
      assert.equal(named("old.jsonl"), false, "a file older than its drop is not");
      writeFileSync(join(home, "d.jsonl"), "{}\n");
      assert.ok(await until(() => named("d.jsonl")), "an opened home is watched");
      // A home published whole by a rename (a Transport's arrival, a restore) keeps its old file times.
      const staged = join(f.sessionsDir, "..", "staged");
      mkdirSync(staged);
      writeFileSync(join(staged, "e.jsonl"), "{}\n");
      utimesSync(join(staged, "e.jsonl"), old, old);
      mkdirSync(join(homes, "h2"));
      renameSync(staged, fresh);
      active.add(fresh); // not listed by folders() yet
      assert.ok(await until(() => named("e.jsonl")), "every file of a folder never watched is noted, whatever its time");
      assert.equal(heard.includes(null), false, "never a full read for a folder joining the scope");
    } finally {
      stop();
    }
  });

  test("a watch refused for the system's limit is logged once per sync, naming how many folders went unwatched", () => {
    const f = fixture();
    mkdirSync(join(f.sessionsDir, "--x--"));
    const lines: string[] = [];
    const limit = Object.assign(new Error("ENOSPC: System limit for number of file watchers reached"), { code: "ENOSPC" });
    const stop = watchFeedInputs(() => {}, {
      sessionsDir: f.sessionsDir,
      liveDir: f.liveDir,
      roots: () => [],
      liveSignature: () => "same",
      log: (l) => lines.push(l),
      watch: ((dir: string, ...rest: unknown[]) => {
        if (dir === f.sessionsDir || dir === f.liveDir) return (watch as (...a: unknown[]) => FSWatcher)(dir, ...rest);
        throw limit;
      }) as typeof watch,
    });
    stop();
    assert.deepEqual(lines, [
      "Session list: the system's file-watch limit is reached (ENOSPC: System limit for number of file watchers reached); 2 folders aren't watched, so their changes reach the list at the next full build.",
    ]);
  });
});
