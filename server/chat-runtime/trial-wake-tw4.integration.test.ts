// Run: pnpm test:int -- server/chat-runtime/trial-wake-tw4.integration.test.ts. Wake nudges end to end (§chat/wake-nudges, the
// harness: scripts/chat-runtime-trial/trial-test.ts).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("wake nudges: a chat that starts and does not fire", [
  ["tw4", "tw4: a chat that starts and does not fire"],
]);
