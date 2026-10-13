// Run: pnpm test:int -- server/chat-runtime/trial-s4-crash.integration.test.ts. al_3 stage 4 end to end, a worker's crash and idle stop (the
// harness: scripts/chat-runtime-trial/trial-test.ts; stage4-design.md §8).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("chat runtime stage 4: a worker's crash and idle stop", [
  ["t20", "T20: kill -9 of a worker mid-run: one continue, the run finishes, one completion; a second kill during the resume is final"],
  ["t23", "T23: idle stop of a waiting worker: no death, still waiting, a steer reopens it once"],
]);
