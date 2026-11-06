// Run: pnpm test:int -- server/chat-runtime/trial-jobs-tj5.integration.test.ts. A worker's process crashing
// mid-run with background jobs running (§app.chat-processes/worker-crash; the harness:
// scripts/chat-runtime-trial/trial-test.ts), on the systemd driver.
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("background jobs: a worker's crash leaves its jobs running", [["tj5", "tj5: a worker crash with jobs running"]], { driver: "systemd" });
