// Run: pnpm test:int -- server/chat-runtime/trial-jobs-tj4.integration.test.ts. Background jobs on the systemd
// driver (the harness: scripts/chat-runtime-trial/trial-test.ts): deleting a chat stops its job, a Claude Code
// chat's bash keeps one, a sandboxed chat keeps none and background_job refuses it.
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("background jobs: delete, a Claude Code chat's bash, a sandboxed chat", [["tj4", "tj4: delete, Claude Code, sandboxed"]], { driver: "systemd" });
