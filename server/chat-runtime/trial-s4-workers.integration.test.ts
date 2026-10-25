// Run: pnpm test:int -- server/chat-runtime/trial-s4-workers.integration.test.ts. al_3 stage 4 end to end, workers across a server restart (the
// harness: scripts/chat-runtime-trial/trial-test.ts; stage4-design.md §8).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("chat runtime stage 4: workers across a server restart", [
  ["t17", "T17: a pi worker across a server restart: a chat process of its own, same pid, its reply once, its completion once, no pi --mode rpc"],
  ["t17c", "T17c: the same for a claude-code worker (the fake claude)"],
]);
