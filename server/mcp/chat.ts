// The server's answers to a chat about its servers: the list it takes, the setup card's group, and a note for the
// chat that started a worker. Projects live in the server's engines, so a chat's process asks here.
import type { McpNote, SetupMcp } from "../../shared/mcp";
import { chatHandle } from "../chat-handle";
import { plan, readStoredCwd } from "../git-summary";
import { readBranch } from "../harness/pi/reader";
import { MCP_LIST, PROFILE, SANDBOX } from "../harness/state-kinds";
import { stateView } from "../harness/state-view";
import { readComputerList } from "./config";
import { chatListOf, setupOf, type McpChatList } from "./list";
import { folderOf } from "./places";

export interface McpListAsk {
  path: string;
  cwd: string;
  sandboxOn: boolean;
  offMcp: string[];
  onMcp: string[];
}

/** A chat's list now; null for a remote chat, whose files aren't here. */
export async function chatListFor(ask: McpListAsk): Promise<McpChatList | null> {
  const stored = await readStoredCwd(ask.path).catch(() => null);
  if (stored !== null && plan(stored).kind === "remote") return null;
  return chatListOf(folderOf(ask.cwd), ask, ask.sandboxOn);
}

export interface McpSetupAsk {
  path: string;
  cwd: string;
  /** The target of a remote chat. */
  remote?: string;
  off: { offMcp?: string[]; onMcp?: string[] } | null;
}

const hasServers = () => readComputerList().entries.length > 0;

/** The held chat's profile: a pick before the first message isn't in the file yet, since pi writes a session from its first reply. */
const heldProfile = (path: string) => chatHandle(path)?.mirror.profile?.profile;

export async function setupFor(ask: McpSetupAsk, held: (path: string) => { label: string; remove: readonly string[] } | null | undefined = heldProfile): Promise<SetupMcp | undefined> {
  if (ask.remote) return hasServers() ? { line: { why: "remote", target: ask.remote }, rows: [] } : undefined;
  const branch = await readBranch(ask.path).catch(() => null);
  const state = branch ? stateView(branch) : null;
  const profile = held(ask.path) ?? state?.latest(PROFILE)?.data?.profile ?? null;
  const folder = folderOf(ask.cwd);
  const setup = setupOf(folder, ask.off ?? {}, sandboxIsOn(state));
  if (!setup) return undefined;
  if (profile?.remove.includes("mcp")) return { line: { why: "profile", profile: profile.label }, rows: [] };
  // A chat that has begun reads its own list, whatever the rows say now.
  const kept = state?.latest(MCP_LIST)?.data;
  if (kept) {
    const names = new Set(kept.servers.map((s) => s.name));
    return { ...setup, rows: setup.rows.map((r) => ({ ...r, on: names.has(r.name) })) };
  }
  return setup;
}

function sandboxIsOn(state: ReturnType<typeof stateView> | null): boolean {
  return state?.latest(SANDBOX)?.data.on === true;
}

/** The chat that started a worker hears of a failure under its confinement. */
export async function tellParent(parent: string, note: McpNote): Promise<null> {
  await chatHandle(parent)?.noteMcp(note).catch(() => null);
  return null;
}
