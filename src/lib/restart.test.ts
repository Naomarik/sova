import assert from "node:assert/strict";
import { test } from "node:test";
import { aheadPhrase, LATE_MS, NO_SERVICE_HINT, POLL_MS, restartBlockView, restartConfirmText, restartedLine, runsLabel, serviceCheckCommand, SLOW_POLL_MS, UPGRADE_HINT, waitForRestart } from "./restart";

/**
 * Restart Sova's words and its wait for the server to come back, with a fake clock: every wait is a
 * step of the clock, never a real sleep.
 */

test("the confirm names newer code only when there is some, each part only when it applies, counted right", () => {
  const base = "Sova restarts in a few seconds. Chats keep running; open tabs reconnect.";
  assert.deepEqual(restartConfirmText({ diskAhead: null }), [base]);
  assert.deepEqual(restartConfirmText({}), [base], "an older server sends nothing");
  assert.deepEqual(restartConfirmText({ diskAhead: { commits: 3, dirty: true } }), [base, "It loads newer code: 3 new commits and uncommitted changes since it started."]);
  assert.equal(aheadPhrase({ commits: 1, dirty: false }), "1 new commit");
  assert.equal(aheadPhrase({ commits: 2, dirty: false }), "2 new commits");
  assert.equal(aheadPhrase({ commits: 0, dirty: true }), "uncommitted changes");
  assert.equal(aheadPhrase({ commits: 0, dirty: false }), "");
});

test("what runs and where to look", () => {
  assert.equal(runsLabel("feat/x", "0123456789abcdef"), "feat/x · 0123456");
  assert.equal(runsLabel(null, "0123456789abcdef"), "0123456");
  assert.equal(runsLabel(null, null), "");
  assert.equal(serviceCheckCommand({ manager: "systemd", name: "sova-runtime.service" }), "systemctl --user status sova-runtime.service");
  assert.equal(serviceCheckCommand({ manager: "launchd", name: "sova-runtime" }), "launchctl print gui/$(id -u)/sova-runtime");
});

/** A fake clock and a health that answers from a script of (time → startedAt|null). */
function rig(answer: (t: number) => string | null) {
  const clock = { t: 0 };
  const waits: number[] = [];
  const asked: number[] = [];
  let late: number | null = null;
  let stop = false;
  const w = {
    before: "A",
    health: async () => (asked.push(clock.t), answer(clock.t)),
    wait: async (ms: number) => {
      waits.push(ms);
      clock.t += ms;
    },
    now: () => clock.t,
    onLate: () => {
      if (late !== null) throw new Error("told twice");
      late = clock.t;
    },
    stopped: () => stop,
  };
  return { w, clock, waits, asked, late: () => late, stopNow: () => (stop = true) };
}

test("asks every second while Sova is down or still the old one; the new start ends it", async () => {
  const x = rig((t) => (t < 4_000 ? "A" : t < 7_000 ? null : "B"));
  assert.equal(await waitForRestart(x.w), "B");
  assert.ok(x.waits.every((ms) => ms === POLL_MS));
  assert.equal(x.clock.t, 7_000);
  assert.equal(x.late(), null, "never late");
});

test("after a minute: told once, asks every 5 s, and still ends when Sova answers", async () => {
  const x = rig((t) => (t < 90_000 ? null : "B"));
  assert.equal(await waitForRestart(x.w), "B");
  assert.equal(x.late(), LATE_MS);
  const slow = x.waits.filter((ms) => ms === SLOW_POLL_MS).length;
  assert.equal(slow, (90_000 - LATE_MS) / SLOW_POLL_MS);
});

test("a health call that throws is a down server, not an end; closing the section ends the wait", async () => {
  const x = rig(() => null);
  let n = 0;
  x.w.health = async () => {
    if (++n === 3) x.stopNow();
    throw new Error("down");
  };
  assert.equal(await waitForRestart(x.w), null);
  assert.equal(n, 3, "it kept asking past the throws until the section closed");
  assert.equal(x.waits.length, 2, "and waited no more once closed");
});

test("the block's states: no service, ready, an upgrade running, already restarting, confirming, waiting", () => {
  const unit = { manager: "systemd" as const, name: "sova-runtime.service" };
  const ready = { canRestart: true, restartWhyNot: null, restartUnit: unit };
  assert.deepEqual(restartBlockView({ canRestart: false, restartWhyNot: NO_SERVICE_HINT, restartUnit: null }, false, "idle"), { button: null, hint: NO_SERVICE_HINT });
  assert.deepEqual(restartBlockView({}, false, "idle"), { button: null, hint: NO_SERVICE_HINT }, "an older server: no button");
  assert.deepEqual(restartBlockView(ready, false, "idle"), { button: { label: "Restart Sova", disabled: false }, hint: null });
  // The page saw the job start before the server's state said so, and after: the same.
  assert.deepEqual(restartBlockView(ready, true, "idle"), { button: { label: "Restart Sova", disabled: true }, hint: UPGRADE_HINT });
  assert.deepEqual(restartBlockView({ ...ready, canRestart: false, restartWhyNot: UPGRADE_HINT }, true, "idle"), { button: { label: "Restart Sova", disabled: true }, hint: UPGRADE_HINT });
  assert.deepEqual(restartBlockView({ ...ready, canRestart: false, restartWhyNot: "Sova is already restarting." }, false, "idle"), { button: { label: "Restart Sova", disabled: true }, hint: "Sova is already restarting." });
  assert.deepEqual(restartBlockView(ready, false, "confirm").hint, null);
  for (const phase of ["sending", "waiting"] as const) assert.deepEqual(restartBlockView({ ...ready, canRestart: false, restartWhyNot: "Sova is already restarting." }, false, phase), { button: { label: "Restarting…", disabled: true }, hint: null });
  assert.deepEqual(restartBlockView(ready, false, "done"), { button: { label: "Restart Sova", disabled: false }, hint: null });
});

test("the line once Sova is back names what it runs", () => {
  assert.equal(restartedLine({ branch: "master", startedHead: "abcdef0123", head: "ffff" }), "Restarted just now. Runs master · abcdef0.");
  assert.equal(restartedLine({ branch: null, startedHead: null, head: null }), "Restarted just now.");
});
