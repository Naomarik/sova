// Stand-ins for the recorder's thread, for stall-recorder.integration.test.ts: what the watchdog
// might do at its worst, picked by its workerData's `FIXTURE_FAULT` environment.
const fault = process.env.FIXTURE_FAULT;
if (fault === "throw") throw new Error("the watchdog fell over");
if (fault === "late-throw") setTimeout(() => { throw new Error("the watchdog fell over later"); }, 50);
if (fault === "exit") process.exit(3);
if (fault === "hang") while (true) { /* a watchdog stuck for good */ }
