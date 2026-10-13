// Run: pnpm test:int -- server/chat-runtime/trial-s5-hermetic.integration.test.ts. al_3 stage 5: a trial server reads
// nothing in the user's home (HOME a tripwire home, watched with inotifywait) and never runs a claude
// other than the trial's fake (the harness: scripts/chat-runtime-trial/trial-test.ts).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("chat runtime stage 5: hermeticity", [
  ["hermetic", "Hermetic: chats, workers, /btw, a claude-code-cli parent, a restart and every page's data open nothing in a tripwire home and never run its claude"],
]);
