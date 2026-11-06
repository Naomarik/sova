// Run: pnpm test:int -- server/chat-runtime/trial-wake-tw2.integration.test.ts. Wake nudges end to end (§chat/wake-nudges, the
// harness: scripts/chat-runtime-trial/trial-test.ts).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("wake nudges: Sova off at the due time", [
  ["tw2", "tw2: Sova off at the due time"],
]);
