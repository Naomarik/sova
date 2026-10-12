// Run: pnpm test:int -- server/chat-runtime/trial-code.integration.test.ts. al_3 stage 2 end to end, code pickup (the harness:
// scripts/chat-runtime-trial/trial-test.ts).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("chat runtime stage 2: code pickup", [
  ["t4", "T4: new code: older badge, reload at a quiet moment, Reload now, never mid-reply"],
  ["t4fail", "T4: a replacement that fails to boot halts the rollout and keeps the old process"],
]);
