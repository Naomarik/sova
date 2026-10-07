// Run: node scripts/run-tests.mjs server/share-ws-hop.test.ts. The gateway's `/ws/h` hop's handshake
// check (server/share/ws-hop.ts validHandshake) and a draining hop's deadline on a stepped clock, in
// process; the hop's lifecycle over real sockets, and the grace measured in real time, is
// share-ws-hop.integration.test.ts. A throwaway PI_CODING_AGENT_DIR; ~/.pi untouched.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-ws-hop-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const { drainDeadline, validHandshake } = await import("./share/ws-hop");
type HopTimers = import("./share/ws-hop").HopTimers;

const GOOD_KEY = Buffer.alloc(16, 7).toString("base64");

test("B2: validHandshake refuses a Connection header without the upgrade token", () => {
  const req = { method: "GET", headers: { upgrade: "websocket", connection: "keep-alive", "sec-websocket-key": GOOD_KEY, "sec-websocket-version": "13" } };
  assert.equal(validHandshake(req as never), false);
  assert.equal(validHandshake({ ...req, headers: { ...req.headers, connection: "keep-alive, Upgrade" } } as never), true);
});

/** A clock the test steps: a timer fires only when `advance` passes its time, never on its own. */
function steppedClock() {
  let now = 0;
  let next = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timers: HopTimers = {
    set: (fn, ms) => (due.set(++next, { at: now + ms, fn }), next),
    clear: (handle) => void due.delete(handle as number),
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [h, t] of [...due].sort((a, b) => a[1].at - b[1].at))
      if (t.at <= now) {
        due.delete(h);
        t.fn();
      }
  };
  return { timers, advance, pending: () => due.size };
}

test("drainWhere's deadline, stepped: the first grace (300 ms) ends the hop; a second drain (5 s) doesn't extend it; cancel drops it", () => {
  const clock = steppedClock();
  const deadline = drainDeadline(clock.timers);
  let ended = 0;
  deadline.arm(300, () => ended++);
  deadline.arm(5000, () => ended++); // a hop already waiting keeps its first deadline
  assert.equal(deadline.armed, true);
  assert.equal(clock.pending(), 1, "one timer: the second drain armed nothing");
  clock.advance(299);
  assert.equal(ended, 0, "not before the grace");
  clock.advance(1);
  assert.equal(ended, 1, "at 300 ms");
  clock.advance(5000);
  assert.equal(ended, 1, "nothing at 5 s: the second grace never ran");

  const cancelled = drainDeadline(clock.timers);
  cancelled.arm(300, () => ended++);
  cancelled.cancel(); // the hop ended first (the host's own close)
  clock.advance(1000);
  assert.equal(ended, 1, "a cancelled deadline never fires");
});
