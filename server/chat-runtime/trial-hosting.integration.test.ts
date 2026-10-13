// Run: pnpm test:int -- server/chat-runtime/trial-hosting.integration.test.ts. al_3 stage 2 end to end, where chats run, server actions, isolation (the harness:
// scripts/chat-runtime-trial/trial-test.ts).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("chat runtime stage 2: where chats run, server actions, isolation", [
  ["t7", "T7: a server-hosted action cut by a restart reports outcome unknown and ran once; an undelivered one runs later"],
  ["t8", "T8: two servers never adopt or stop each other's chats"],
  ["t9", "T9: an outside SIGTERM to a chat process: the pane reconnects quietly and gets a fresh hello"],
]);
