// Run: pnpm test:int -- server/chat-runtime/trial-s3-acts.integration.test.ts. al_3 stage 3 end to end: an Overseer's
// and a project overseer's server-side acts cut by a restart (q5; the harness: scripts/chat-runtime-trial/trial-test.ts).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("chat runtime stage 3: special chats' server actions across a restart", [
  ["t11", "T11: a restart mid an Overseer's served tool: outcome unknown, ran once; run facts reach the next server"],
  ["t11b", "T11b: a restart after an Overseer's act ran, before its result: unknown, the note once, never re-sent"],
  ["t11c", "T11c: a restart before a project overseer's act ran: unknown, no note, never re-sent"],
]);
