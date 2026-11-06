// Run: pnpm test:int -- server/chat-runtime/trial-jobs-tj3.integration.test.ts. background_job end to end
// (§app.background-jobs/request; the harness: scripts/chat-runtime-trial/trial-test.ts), on the systemd driver.
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("background jobs: background_job in a chat and a worker, its pass/fail card, worker stop", [["tj3", "tj3: requested jobs end to end"]], { driver: "systemd" });
