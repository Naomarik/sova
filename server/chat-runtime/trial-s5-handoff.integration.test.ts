// Run: pnpm test:int -- server/chat-runtime/trial-s5-handoff.integration.test.ts. al_3 stage 5 (F8): /compact-handoff on a
// Claude Code parent, its fork resumed from the parent's CLI session on the fake claude (the harness:
// scripts/chat-runtime-trial/trial-test.ts).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("chat runtime stage 5: /compact-handoff on a Claude Code parent", [
  ["t21h", "T21h: the fork resumes the parent's CLI session, the note is saved, the parent compacts, the fork's usage is under the parent"],
]);
