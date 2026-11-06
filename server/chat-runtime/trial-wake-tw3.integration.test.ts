// Run: pnpm test:int -- server/chat-runtime/trial-wake-tw3.integration.test.ts. Wake nudges end to end (§chat/wake-nudges, the
// harness: scripts/chat-runtime-trial/trial-test.ts).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("wake nudges: archived then unarchived", [
  ["tw3", "tw3: archived then unarchived"],
]);
