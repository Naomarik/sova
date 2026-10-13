// Run: pnpm test:int -- server/chat-runtime/trial-s4-off.integration.test.ts. al_3 stage 4 end to end, the LLM count (the
// harness: scripts/chat-runtime-trial/trial-test.ts; stage4-design.md §8). T22 (the switch off) went with the switch (Part B).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("chat runtime stage 4: the LLM count", [
  ["t24", "T24: a worker's model call counted once on /ws/watch?feed=llm; its tokens stay after it ends"],
]);
