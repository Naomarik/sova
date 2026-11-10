// Run: pnpm test:int -- server/chat-runtime/trial-modes-flip.integration.test.ts. "Sova runs chat modes" flipped while a chat
// runs in a process of its own (§chat.mode-menu/sova-runs-modes): it follows at its next quiet moment through the same
// two-phase rollout as "On older code" (the harness: scripts/chat-runtime-trial/trial-test.ts).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("chat runtime: a modes switch flip reaches an open chat at its quiet moment", [
  ["tmodes", "tmodes: never mid-reply, a new process once it settles; a flip back first reloads nothing"],
]);
