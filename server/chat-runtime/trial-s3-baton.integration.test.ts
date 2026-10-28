// Run: pnpm test:int -- server/chat-runtime/trial-s3-baton.integration.test.ts. al_3 stage 3 end to end: a baton in a
// process of its own (the harness: scripts/chat-runtime-trial/trial-test.ts). One baton check per file, so they run
// side by side.
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("chat runtime stage 3: batons in a process of their own", [
  ["t12a", "T12a: a participant's message through the share hub; record_decision's owner area in the roster's spelling, its quote checked"],
]);
