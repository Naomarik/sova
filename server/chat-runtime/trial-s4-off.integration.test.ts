// Run: pnpm test:int -- server/chat-runtime/trial-s4-off.integration.test.ts. al_3 stage 4 end to end, the switch off, and the LLM count (the
// harness: scripts/chat-runtime-trial/trial-test.ts; stage4-design.md §8).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("chat runtime stage 4: the switch off, and the LLM count", [
  ["t22", "T22: switch off: workers are lowered children of the server; a mode switch keeps them; a restart ends them (restored); agent_resume reopens one"],
  ["t24", "T24: a worker's model call counted once on /ws/watch?feed=llm; its tokens stay after it ends"],
]);
