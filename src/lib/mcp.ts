// The words and small decisions of MCP servers (§app/mcp, §design.copy-deck/mcp-servers): the server
// sends codes and data, and every sentence a row, a dialog, the setup card or a chat note draws is
// here. Pure, so each is tested against the state it must not be said in.
import type { McpErrorLine, McpNewServer, McpNote, McpProjectServers, McpRowState, McpServerRow, McpToolName, SetupMcp } from "../../shared/mcp";
import type { Tone } from "../components/ui";
import { tokenFacts } from "./session-setup";

export const MCP_TITLE = "MCP Servers";
export const MCP_INTRO = "Servers on this computer. Each project's own servers are on its project page.";
export const MCP_NONE = "No servers yet. Add one to give your chats more tools.";
export const MCP_LOAD_FAILED = "Couldn't read the MCP servers.";
export const mcpLoadFailedBody = (reason: string) => `Nothing was changed. ${reason}`;

export const SECRET_HINT = "Saved on this computer only. Never shown again and never copied to your other computers.";
export const SECRET_SAVED = "Saved on this computer.";
export const secretNeeded = (name: string) => `${name} isn't saved yet.`;

export const RESERVED_FIELD = "The name sova is Sova's own. Pick another.";
export const RESERVED_ROW = "This entry uses the name sova, which is Sova's own, so it won't run.";
export const WAITING_LEAD = "This server runs nothing until you approve it.";
export const WAITING_CHANGED = "This server changed, so it needs your approval again.";
export const UNPINNED = "Runs the newest version each start.";
export const APPROVE_CHANGED = "This server changed since you looked. Check what it runs, then approve it again.";
export const NO_ERRORS = "No errors from the last Check.";
export const NO_CHECK = "No Check yet.";
export const SIGN_IN_BODY = "The sign-in page opens in a new tab. If it ends on a page that won't load, paste that page's address here.";

export const PROJECT_INTRO = "From this project's .mcp.json. Each checkout approves its own copy.";
export const PROJECT_NONE = "No servers yet. Add a .mcp.json to this project to declare one.";
export const projectBroken = (reason: string) => `This project's .mcp.json can't be read: ${reason}.`;

const STATE_WORD: Record<McpRowState, string> = {
  waiting: "Waiting for You",
  off: "Off",
  "needs-sign-in": "Needs Sign-in",
  failed: "Failed",
  connected: "Connected",
  "no-check": "No Check yet",
};
const STATE_TONE: Record<McpRowState, Tone | undefined> = {
  waiting: "warn",
  off: undefined,
  "needs-sign-in": "warn",
  failed: "error",
  connected: "success",
  "no-check": undefined,
};
export const stateWord = (s: McpRowState): string => STATE_WORD[s];
export const stateTone = (s: McpRowState): Tone | undefined => STATE_TONE[s];

export const toolCountLabel = (n: number): string => (n === 1 ? "1 tool" : `${n} tools`);
/** The row's one line of facts: "Address · 6 tools". */
export function rowFacts(row: Pick<McpServerRow, "kind" | "toolCount">): string {
  return `${row.kind === "address" ? "Address" : "Command"} · ${toolCountLabel(row.toolCount)}`;
}

/** What the row says about an entry that can't run. A missing secret says so at its own field. */
export function refusedLines(refused: McpServerRow["refused"]): string[] {
  if (!refused) return [];
  return refused.why === "reserved" ? [RESERVED_ROW] : refused.names.map((n) => `${n} isn't a saved secret, so this server won't start.`);
}

export const replacedLine = (r: { project: string }, name: string): string => `Replaced in ${r.project} by that project's ${name}.`;
export const checkFailedLine = (name: string): string => `${name} didn't start.`;
export const removeQuestion = (name: string): string => `Remove ${name}? Its approval, secrets and sign-in go with it.`;
export const signInTitle = (name: string): string => `Sign in to ${name}`;

/** A row's error line, with the chat or worker it came from. */
export function errorLineText(e: McpErrorLine): string {
  if (!e.chat) return e.line;
  if (e.where === "write-only") return `In ${e.chat}, under write-only confinement: ${e.line}`;
  return e.where === "sandbox" ? `In ${e.chat}, inside its sandbox: ${e.line}` : `In ${e.chat}: ${e.line}`;
}

/** Reserved in any case: the field's own check, ahead of the server's. */
export const isReservedName = (name: string): boolean => name.trim().toLowerCase() === "sova";

export type AddWay = "address" | "command" | "paste";
export const ADD_WAYS: readonly { id: AddWay; label: string }[] = [
  { id: "address", label: "Address" },
  { id: "command", label: "Command" },
  { id: "paste", label: "Paste from Another Tool" },
];

export interface AddFields {
  address: string;
  command: string;
  paste: string;
  secret: string;
  secretName: string;
}

/** What Add and Check sends. */
export function newServer(way: AddWay, name: string, f: AddFields): McpNewServer {
  const n = name.trim();
  if (way === "paste") return { way, name: n, text: f.paste.trim() };
  if (way === "address") return { way, name: n, address: f.address.trim(), ...(f.secret ? { secret: f.secret } : {}) };
  return { way, name: n, command: f.command.trim(), ...(f.secret ? { secret: f.secret, secretName: f.secretName.trim() } : {}) };
}

/** What Edit sends: the entry and, when one was typed, its secret. */
export function editedServer(way: Exclude<AddWay, "paste">, f: AddFields): { address: string; secret?: string } | { command: string; secret?: string; secretName?: string } {
  if (way === "address") return { address: f.address.trim(), ...(f.secret ? { secret: f.secret } : {}) };
  return { command: f.command.trim(), ...(f.secret ? { secret: f.secret, secretName: f.secretName.trim() } : {}) };
}

/** Whether the form can go: a name that isn't reserved (null: Edit, the name is fixed), an entry, and
    a name for a command's secret. */
export function canSend(way: AddWay, f: AddFields, name: string | null): boolean {
  if (name !== null && (!name.trim() || isReservedName(name))) return false;
  if (way === "command" && f.secret && !f.secretName.trim()) return false;
  return !!(way === "address" ? f.address : way === "command" ? f.command : f.paste).trim();
}

/** The project section's groups: a checkout with no file says nothing beside one that has servers,
    and when none has a file the section is its one line. */
export function projectGroups(view: McpProjectServers): McpProjectServers["checkouts"] {
  return view.checkouts.filter((c) => c.file !== "missing" || c.servers.length > 0);
}

// -- the setup card --

export const SETUP_LABEL = "MCP Servers";
export const setupSwitchLabel = (name: string): string => `Use ${name}`;
export const setupTokens = (tokens: number | undefined): string => (typeof tokens === "number" ? tokenFacts(tokens) : "");

type SetupRow = SetupMcp["rows"][number];

/** Why a row has no switch. */
export function setupOffLine(r: SetupRow): string | null {
  switch (r.off) {
    case "waiting":
      return r.source === "project" ? "Waiting for You. Approve it on the project page." : "Waiting for You. Approve it in Settings → MCP Servers.";
    case "no-check":
      return NO_CHECK;
    case "sandbox":
      return "Address servers stay off while the sandbox is On.";
    case "address-in-chat":
      return "Address servers don't run in chats yet.";
    default:
      return null;
  }
}

/** The group's one line in place of rows. */
export function setupLine(m: SetupMcp): string | null {
  if (m.line?.why === "remote") return `MCP servers don't run in remote chats: they would run here while this chat's files are on ${m.line.target}.`;
  if (m.line?.why === "profile") return `${m.line.profile} removes MCP servers.`;
  return null;
}
export const NOT_PROJECT = "This folder isn't a project, so its .mcp.json won't run.";

/** A folder and computer with no servers shows no group. */
export const setupShows = (m: SetupMcp | undefined): m is SetupMcp => !!m && (!!m.line || !!m.notProject || m.rows.length > 0);

/** The chat's set as the card sends it: only what differs from a server's New Chats switch. */
export function mcpFlips(m: SetupMcp | undefined, flip?: { name: string; on: boolean }): { offMcp: string[]; onMcp: string[] } {
  const offMcp: string[] = [];
  const onMcp: string[] = [];
  for (const r of m?.rows ?? []) {
    if (r.off) continue;
    const on = flip?.name === r.name ? flip.on : r.on;
    if (on !== r.newChats) (on ? onMcp : offMcp).push(r.name);
  }
  return { offMcp, onMcp };
}

// -- a chat --

/** A chat's failure note. */
export function chatNoteText(n: McpNote): string {
  switch (n.how) {
    case "sandbox":
      return `${n.server} failed inside this chat's sandbox. It may need something the sandbox blocks.`;
    case "write-only":
      return `${n.server} failed under ${n.worker}'s write-only confinement. It may need to write outside its worktree.`;
    case "address-under-on":
      return `${n.server} is off while the sandbox is On.`;
    case "changed":
      return `${n.server} changed and is waiting for your approval.`;
    case "other-computer":
      return `${n.server} failed on ${n.host}. Check it in Sova on ${n.host}.`;
    default:
      return `${n.server} failed: ${(n.reason ?? "").replace(/\.$/, "")}.`;
  }
}
/** A note in a peer's chat: the server only ever sees its own computer's chats, so the page names the
    peer, and a row there is that computer's to open. */
export function noteOnHost(n: McpNote, host: string | null): McpNote {
  if (!host) return n;
  const { link: _link, ...rest } = n;
  return { ...rest, how: "other-computer", host };
}

/** A tool row's name. */
export const mcpToolWords = (t: McpToolName): string => `${t.server} · ${t.tool}`;
export const NOTE_LINK = "Open Its Settings";
