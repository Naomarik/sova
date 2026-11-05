// Run: pnpm test:int -- server/chat-runtime/trial-wake-tw1.integration.test.ts. Wake nudges end to end (§chat/wake-nudges, the
// harness: scripts/chat-runtime-trial/trial-test.ts).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("wake nudges: no tab open, a busy chat, a short turn", [
  ["tw1", "tw1: no tab open, a busy chat, a short turn"],
]);
