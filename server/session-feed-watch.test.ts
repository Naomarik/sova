// What tells the session feed to compare (§app.decisions/push): file watches over temp folders and
// a stubbed live-record signature. No server, no ~/.pi.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
