// Run: pnpm test:int -- server/chat-runtime/trial-jobs-tj6.integration.test.ts. A worker that finished, woken by
// its own job's end, reports again (§app.background-jobs/end-card; the harness:
// scripts/chat-runtime-trial/trial-test.ts), on the systemd driver.
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("background jobs: a job's end wakes a worker that finished", [["tj6", "tj6: its reply is a second report, its process up throughout"], ["tj6b", "tj6b: its reply is a second report, its process and the parent's stopped idle"]], { driver: "systemd", spawnMs: 130_000 });
