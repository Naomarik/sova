// Run: pnpm test:int -- server/chat-runtime/trial-s5-generations.integration.test.ts. al_3 stage 5: per-chat code generations
// on a server run from a scratch git clone the trial edits (the harness: scripts/chat-runtime-trial/trial-test.ts;
// stage5-design.md §A-3, G-tests).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("chat runtime stage 5: per-chat code generations", [
  ["t25", "T25: a chat runs its own copy of the code; a checkout edit never reaches it; quiet chats move one at a time; a worker runs the current copy; unused copies go; a failed start halts the rollout"],
], { spawnMs: 285_000 });
