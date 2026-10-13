// Run: pnpm test:int -- server/chat-runtime/trial-s4-reload.integration.test.ts. al_3 stage 4 end to end, a parent reload or crash mid worker run (the
// harness: scripts/chat-runtime-trial/trial-test.ts; stage4-design.md §8).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("chat runtime stage 4: a parent reload or crash mid worker run", [
  ["t18", "T18: Reload now on the parent (a → b): the worker keeps its pid, agent_list shows it running, a steer after the reload reaches it once, one completion"],
  ["t18b", "T18b: kill -9 of the parent mid-run: its crash resume; the worker keeps its process; one completion"],
]);
