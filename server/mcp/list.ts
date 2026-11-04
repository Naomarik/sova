// Which servers a chat lists and what its setup card draws. A chat's list is data: it keeps a
// copy in its session state from its first message on, so nothing that happens to a record later changes it.
import type { SetupMcp } from "../../shared/mcp";
import type { McpEntry } from "./config";
import { readComputerList, readProjectList } from "./config";
import { versionOf } from "./fingerprint";
import { rowId } from "./ids";
import type { McpFolder } from "./places";
import { baseOf, refusalOf, sourceOf } from "./resolve";
import { toolTokens } from "./rows";
import type { McpChatList, McpChatServer } from "./list-shape";
import { readRow, recordOf } from "./store";
import { isApproved, type McpOwner } from "./trust";

export { NO_MCP, normalizeChatList, type McpChatList, type McpChatServer } from "./list-shape";

/**
 * Address servers don't run in a chat yet: pi's HTTP transport needs @earendil-works/pi-mcp as a direct dependency
 * (tmp/mcp-proof.md item 3). The one switch: a Check and a sign-in work on them already, and a chat's transport for
 * one is the seam in server/harness/pi/mcp.ts.
 */
export const ADDRESS_SERVERS_IN_CHATS = false;

export interface McpChoice {
  offMcp?: readonly string[];
  onMcp?: readonly string[];
}

type Row = SetupMcp["rows"][number];

interface Candidate {
  /** It can't run and has no Approve, so the card has nothing to offer. */
  refused: boolean;
  row: Row;
  server?: McpChatServer;
}

function candidate(owner: McpOwner, e: McpEntry, choice: McpChoice, sandboxOn: boolean): Candidate {
  const row = readRow(owner, e.name);
  const version = versionOf(e, baseOf(owner));
  const record = recordOf(row, version);
  const offTools = new Set(row.settings.offTools);
  const tools = record?.tools.filter((t) => !offTools.has(t.name)) ?? [];
  const refused = !!refusalOf(e);
  const off: Row["off"] =
    refused || !isApproved(owner, e.name, version)
      ? "waiting"
      : !record
        ? "no-check"
        : e.kind === "address" && !ADDRESS_SERVERS_IN_CHATS
          ? "address-in-chat"
          : e.kind === "address" && sandboxOn
            ? "sandbox"
            : undefined;
  const wanted = row.settings.newChats ? !choice.offMcp?.includes(e.name) : !!choice.onMcp?.includes(e.name);
  const on = !off && wanted;
  return {
    refused,
    row: {
      name: e.name,
      source: sourceOf(owner),
      ...(record ? { tokens: tools.reduce((n, t) => n + toolTokens(t), 0) } : {}),
      on,
      newChats: row.settings.newChats,
      ...(off ? { off } : {}),
    },
    ...(on ? { server: { id: rowId({ owner, name: e.name }), name: e.name, owner, kind: e.kind, version, record: { ...record!, tools } } } : {}),
  };
}

/** Every server a folder could list: this computer's and its checkout's, the project's where both have the name. */
function candidates(folder: McpFolder, choice: McpChoice, sandboxOn: boolean): Candidate[] {
  const owner: McpOwner | null = folder.project ? { kind: "project", projectId: folder.project.id, checkout: folder.checkout } : null;
  const own = owner ? readProjectList(owner.checkout).entries : [];
  const names = new Set(own.map((e) => e.name));
  const computer = readComputerList().entries.filter((e) => !names.has(e.name));
  return [...computer.map((e) => candidate({ kind: "computer" }, e, choice, sandboxOn)), ...own.map((e) => candidate(owner!, e, choice, sandboxOn))];
}

/** The list a chat in this folder takes now. */
export function chatListOf(folder: McpFolder, choice: McpChoice, sandboxOn: boolean): McpChatList {
  return { v: 1, servers: candidates(folder, choice, sandboxOn).flatMap((c) => (c.server ? [c.server] : [])) };
}

/** The setup card's group; undefined when a folder and computer have no servers and nothing to say. */
export function setupOf(folder: McpFolder, choice: McpChoice, sandboxOn: boolean): SetupMcp | undefined {
  const rows = candidates(folder, choice, sandboxOn).filter((c) => !c.refused).map((c) => c.row);
  const notProject = !folder.project && readProjectList(folder.checkout).file !== "missing";
  if (!rows.length && !notProject) return undefined;
  return { ...(notProject ? { notProject: true } : {}), rows };
}

/**
 * What a worker gets: the named servers, with their tools as trimmed in this chat. A name the
 * chat doesn't have is refused with the deck's sentence.
 */
export function workerListOf(list: McpChatList, names: readonly string[], chat: string): { list: McpChatList } | { refused: string } {
  const have = list.servers.map((s) => s.name);
  const unknown = names.find((n) => !have.includes(n));
  if (unknown !== undefined) return { refused: `${chat}'s servers are ${have.length ? have.join(", ") : "none"}, so a worker can't have ${unknown}.` };
  return { list: { v: 1, servers: list.servers.filter((s) => names.includes(s.name)) } };
}
