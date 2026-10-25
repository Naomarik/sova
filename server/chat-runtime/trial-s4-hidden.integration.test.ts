// Run: pnpm test:int -- server/chat-runtime/trial-s4-hidden.integration.test.ts. al_3 stage 4 end to end, hidden chats in processes of their own (the
// harness: scripts/chat-runtime-trial/trial-test.ts; stage4-design.md §8).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("chat runtime stage 4: hidden chats in processes of their own", [
  ["t21", "T21: /explain, /compact-handoff and /btw each in a process of its own, counted; an /explain across a parent reload settles once"],
  ["t21c", "T21c: /btw and /explain on a Claude Code model (the fake claude) record their usage under the parent as their hidden chats"],
]);
