// The restart verb's guard against the live unit (restart.ts runsAsUnit): a process that isn't a unit's main process
// (this test, any hermetic server) is never taken for it, so merge.restart there restarts nothing. Reads systemd only
// (systemctl show); never restarts anything.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runsAsUnit } from "./restart";

test("this process is not sova-runtime.service's main process, nor a unit's that doesn't exist", async () => {
  assert.equal(await runsAsUnit("sova-runtime.service"), false);
  assert.equal(await runsAsUnit("sova-standin-does-not-exist.service"), false);
  // A pid that systemd would print for a stopped unit (0) is never a match either.
  assert.equal(await runsAsUnit("sova-standin-does-not-exist.service", 0), false);
});
