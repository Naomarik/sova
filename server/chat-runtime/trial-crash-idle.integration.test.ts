// Run: pnpm test:int -- server/chat-runtime/trial-crash-idle.integration.test.ts. al_3 stage 2 end to end, crash and idle stop (the harness:
// scripts/chat-runtime-trial/trial-test.ts).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("chat runtime stage 2: crash and idle stop", [
  ["t2", "T2: a killed chat process: pane error, new process, one crash continue, never twice"],
  ["t3", "T3: idle stop only when quiet and unattended; reopens on attach"],
]);
