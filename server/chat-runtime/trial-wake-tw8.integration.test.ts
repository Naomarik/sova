// Run: pnpm test:int -- server/chat-runtime/trial-wake-tw8.integration.test.ts. Wake nudges end to end (§chat/wake-nudges, the
// harness: scripts/chat-runtime-trial/trial-test.ts).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("wake nudges: the Overseer", [
  ["tw8", "tw8: the Overseer comes back for its nudge"],
]);
