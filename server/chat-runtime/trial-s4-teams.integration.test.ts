// Run: pnpm test:int -- server/chat-runtime/trial-s4-teams.integration.test.ts. al_3 stage 4 end to end, a team across a restart and a parent reload (the
// harness: scripts/chat-runtime-trial/trial-test.ts; stage4-design.md §8). One check per file, so the trial's slowest
// checks run side by side.
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("chat runtime stage 4: a team across a restart and a parent reload", [
  ["t19", "T19: alpha's team_msg just before a restart reaches beta once; team_ask reaches the parent once; alpha's inbox survives a parent reload"],
]);
