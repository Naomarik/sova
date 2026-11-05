// Run: pnpm test:int -- server/chat-runtime/trial-jobs-tj2.integration.test.ts. Background jobs: the limit,
// a crash, a Sova restart and a reload (§app/background-jobs), on the systemd driver.
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("background jobs: the limit, crash, restart, reload", [["tj2", "tj2: what a kept job survives"]], { driver: "systemd" });
