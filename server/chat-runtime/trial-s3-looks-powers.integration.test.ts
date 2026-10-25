// Run: pnpm test:int -- server/chat-runtime/trial-s3-looks-powers.integration.test.ts. al_3 stage 3 end to end: a
// project overseer's look and a powers chat across a restart (the harness: scripts/chat-runtime-trial/trial-test.ts).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("chat runtime stage 3: looks and powers chats across a restart", [
  ["t13", "T13: a project overseer's look across a restart: one look message, one turn, recorded cut off at resume"],
  ["t16", "T16: a powers chat's session_send to another chat process (hop header); a restart mid-send delivers at most once"],
]);
