// The tools a held chat declares to its model now (§chat.transcript/setup-card-tools): GET
// /api/sessions/tools (shared/protocol.ts SessionTools), the setup card's Tools group. Read from the chat's
// driving session (`harness.declaredTools()`), never cached: the card reads it again whenever the chat's
// model or modes change, and each read is a list already in memory.
//
// On a Claude Code model the same tools reach the model through the provider's MCP facade, which names
// pi tool `read` `mcp__sova__read` (pi-config/extensions/claude-code/provider/types.ts MCP_TOOL_PREFIX; the
// server never imports claude-code beyond its listed exceptions, so the prefix is kept here and pinned by
// session-tools.test.ts against that file's text).
import type { SessionTool, SessionTools } from "../shared/protocol";
import { heldChat } from "./chat-manager";
import { CLAUDE_CODE_PROVIDER } from "./models";
import { estimateTokens } from "./session-setup";
import { getSessionSummary } from "./sessions-index";

/** The name Claude Code calls a pi tool by: this prefix, then the tool's own name. */
export const CLAUDE_MCP_TOOL_PREFIX = "mcp__sova__";

export const NOT_HELD = "Tools are listed once this chat is open here.";
export const IN_TERMINAL = "This session is open in a terminal, so its tools aren't listed here.";
export const SPECIAL = "This session's tools aren't listed here.";

/** What one declaration costs, by pi's estimate: its description and its parameters' schema as JSON. */
export function toolTokens(description: string, parameters: unknown): number {
  return estimateTokens(description + JSON.stringify(parameters ?? {}));
}

export interface ToolsDeps {
  now?: () => number;
  summary?: typeof getSessionSummary;
  held?: typeof heldChat;
}

/** The held chat's declared tools, or the sentence saying why they aren't listed. */
export async function getSessionTools(path: string, deps: ToolsDeps = {}): Promise<SessionTools> {
  const now = deps.now ?? Date.now;
  const s = await (deps.summary ?? getSessionSummary)(path).catch(() => null);
  if (s?.live) return { state: "unavailable", reason: IN_TERMINAL, checkedAt: now() };
  if (s && (s.overseer || s.projectOverseer || s.baton || s.org || s.workerSession)) return { state: "unavailable", reason: SPECIAL, checkedAt: now() };
  const chat = (deps.held ?? heldChat)(path);
  if (!chat) return { state: "unavailable", reason: NOT_HELD, checkedAt: now() };
  const claude = chat.harness.model()?.provider === CLAUDE_CODE_PROVIDER;
  const tools: SessionTool[] = chat.harness.declaredTools().map((t) => ({
    name: t.name,
    callName: claude ? `${CLAUDE_MCP_TOOL_PREFIX}${t.name}` : t.name,
    description: t.description,
    source: t.source,
    ...(t.origin ? { origin: t.origin } : {}),
    tokens: toolTokens(t.description, t.parameters),
  }));
  return { state: "ok", backend: claude ? "claude-code" : "pi", tools, checkedAt: now() };
}
