// Run: pnpm test:int -- server/chat-runtime/trial-s4-team-nudge.integration.test.ts. al_3 stage 4 end to end, a team monitor's nudge across a parent reload (the
// harness: scripts/chat-runtime-trial/trial-test.ts; stage4-design.md §8). One check per file, so the trial's slowest
// checks run side by side.
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("chat runtime stage 4: a team monitor's nudge across a parent reload", [
  ["t19n", "T19n: a monitor's wake_nudge set before a parent reload fires once after it"],
]);
