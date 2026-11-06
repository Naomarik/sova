// Run: pnpm test:int -- server/chat-runtime/trial-wake-tw7.integration.test.ts. Wake nudges end to end (§chat/wake-nudges, the
// harness: scripts/chat-runtime-trial/trial-test.ts).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("wake nudges: a chain near the limit, a message from another chat partway", [
  ["tw7", "tw7: a chain near the limit, a message from another chat partway"],
]);
