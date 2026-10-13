// Run: pnpm test:int -- server/chat-runtime/trial-restart.integration.test.ts. al_3 stage 2 end to end, a server restart mid-reply (the harness:
// scripts/chat-runtime-trial/trial-test.ts).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("chat runtime stage 2: a server restart mid-reply", [
  ["t1", "T1: a reply in flight survives a server restart (same pid, hello.live, one entry, no resume)"],
  ["t1b", "T1b: a bash call across the restart returns once"],
  ["t1c", "T1c: a dialog open across the restart is re-sent and answered"],
  ["t1d", "T1d: a steer queued before the restart is delivered once"],
]);
