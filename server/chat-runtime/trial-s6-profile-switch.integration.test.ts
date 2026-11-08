// Run: pnpm test:int -- server/chat-runtime/trial-s6-profile-switch.integration.test.ts. A chat's profile switch
// across backends (§chat.profiles/switch): Claude Code (the fake claude) to a pi model and back, the way back
// held to the reply's end (the harness: scripts/chat-runtime-trial/trial-test.ts).
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("chat runtime: a profile switch across backends", [
  ["tprofile", "Tprofile: Claude Code → a pi model idle, then back mid-reply; each turn runs on its profile's model"],
]);
