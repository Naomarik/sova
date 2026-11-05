// Run: pnpm test:int -- server/chat-runtime/trial-wake-tw6.integration.test.ts. Wake nudges end to end (§chat/wake-nudges, the
// harness: scripts/chat-runtime-trial/trial-test.ts).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("wake nudges: a paused team with no member running", [
  ["tw6", "tw6: a paused team with no member running"],
]);
