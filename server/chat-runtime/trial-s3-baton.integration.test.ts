// Run: pnpm test:int -- server/chat-runtime/trial-s3-baton.integration.test.ts. al_3 stage 3 end to end: a baton in a
// process of its own (the harness: scripts/chat-runtime-trial/trial-test.ts).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("chat runtime stage 3: batons in a process of their own", [
  ["t12a", "T12a: a participant's message through the share hub; record_decision's owner area in the roster's spelling, its quote checked"],
  ["t12b", "T12b: a restart mid baton reply: it finishes; one reply/writing, one reply/ended"],
  ["t12c", "T12c: take-back mid reply: the (taken back) entry is in the file when the route answers; one reply/ended"],
  ["t12d", "T12d: the model hands off (hand_to) from the baton's process: one hand-to row, one hand-off entry, one reply/ended"],
  ["t15", "T15: kill -9 of a baton's process mid-reply: the pane's error, reply/ended once, no continue; reopening spawns a new process"],
]);
