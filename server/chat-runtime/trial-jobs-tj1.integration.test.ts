// Run: pnpm test:int -- server/chat-runtime/trial-jobs-tj1.integration.test.ts. Background jobs end to end
// (§app/background-jobs; the harness: scripts/chat-runtime-trial/trial-test.ts), on the systemd driver.
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("background jobs: capture, idle stop, end card, Stop, archive", [["tj1", "tj1: kept jobs end to end"]], { driver: "systemd" });
