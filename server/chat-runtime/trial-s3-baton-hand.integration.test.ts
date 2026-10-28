// Run: pnpm test:int -- server/chat-runtime/trial-s3-baton-hand.integration.test.ts. al_3 stage 3 end to end: a baton in a
// process of its own (the harness: scripts/chat-runtime-trial/trial-test.ts). One baton check per file, so they run
// side by side.
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("chat runtime stage 3: batons in a process of their own", [
  ["t12d", "T12d: the model hands off (hand_to) from the baton's process: one hand-to row, one hand-off entry, one reply/ended"],
]);
