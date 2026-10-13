// Run: pnpm test:int -- server/chat-runtime/trial-restart-more.integration.test.ts. al_3 stage 2 end to end, compaction across a restart (the harness:
// scripts/chat-runtime-trial/trial-test.ts).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("chat runtime stage 2: compaction across a restart", [
  ["t1e", "T1e: a compaction across the restart completes and is written once"],
]);
