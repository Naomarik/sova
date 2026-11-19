// Run: pnpm test:int -- server/chat-runtime/trial-mcp-open.integration.test.ts. §app.mcp/tool-list and
// §app.chat-processes/server-actions end to end over a real chat process (the harness:
// scripts/chat-runtime-trial/trial-test.ts): with one approved, checked command server, a new chat's open
// never waits on its MCP list, and the chat declares that server's tool before its first message.
import { trialSuite } from "../../scripts/chat-runtime-trial/trial-test";

trialSuite("a new chat's MCP servers", [["tmcp", "tmcp: a new chat has its servers from its open, with no wait on the server"]]);
