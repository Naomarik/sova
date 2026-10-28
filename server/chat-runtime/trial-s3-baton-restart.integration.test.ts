// Run: pnpm test:int -- server/chat-runtime/trial-s3-baton-restart.integration.test.ts. al_3 stage 3 end to end: a baton in a
// process of its own (the harness: scripts/chat-runtime-trial/trial-test.ts). One baton check per file, so they run
// side by side.
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("chat runtime stage 3: batons in a process of their own", [
  ["t12b", "T12b: a restart mid baton reply: it finishes; one reply/writing, one reply/ended"],
]);
