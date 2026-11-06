// Run: pnpm test:int -- server/chat-runtime/trial-wake-tw5.integration.test.ts. Wake nudges end to end (§chat/wake-nudges, the
// harness: scripts/chat-runtime-trial/trial-test.ts).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("wake nudges: a worker", [
  ["tw5", "tw5: a worker"],
]);
