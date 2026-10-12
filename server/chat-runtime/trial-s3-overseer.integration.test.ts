// Run: pnpm test:int -- server/chat-runtime/trial-s3-overseer.integration.test.ts. al_3 stage 3 end to end: the Overseer
// and the other special chats in processes of their own (the harness: scripts/chat-runtime-trial/trial-test.ts).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("chat runtime stage 3: the Overseer in a process of its own", [
  ["t6", "T6': the Overseer, a project overseer, a baton and a powers chat each run in a process of their own; a worker's session does not"],
  ["t10", "T10: the Overseer's served tools, file tools (read, edit), acting tools and explorer from its own process; the run note in the file"],
  ["t14", "T14: a brief while the Overseer's process reloads: one brief turn"],
]);
