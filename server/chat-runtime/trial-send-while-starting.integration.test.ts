// Run: pnpm test:int -- server/chat-runtime/trial-send-while-starting.integration.test.ts.
// §chat.transcript/send-while-starting end to end over real chat processes (the harness:
// scripts/chat-runtime-trial/trial-test.ts): a socket that sends to a chat closed while quiet and
// closes at once still has its model switch and message run, in order; one client id on two
// sockets runs once; a refusal with no socket left goes back as the session's saved draft.
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("a message sent while its chat starts", [["tsend", "tsend: delivered after the socket left, once, refusals back as the draft"]]);
