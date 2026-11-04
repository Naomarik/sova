// What Sova keeps per server beside its entry: the row's switches, its Check records (newest 8 versions), the last
// Check, and the error lines chats' copies report. `<state root>/mcp/<row key>.json`, and `.chat.json` for the lines,
// which chat processes write. Never synced: nothing in server/sync names it.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { McpErrorLine } from "../../shared/mcp";
import { stateRoot } from "../state-root";
import { MCP_VERSIONS_KEPT, type McpOwner } from "./trust";

/** A tool as the server declared it. */
export interface McpRecordTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  [key: string]: unknown;
}

/** What a Check recorded: the handshake's answer and the tools, in the server's own shape. */
export interface McpCheckRecord {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  instructions?: string;
  tools: McpRecordTool[];
}

export interface RowFile {
  settings: { newChats: boolean; offTools: string[] };
  versions: { version: string; record: McpCheckRecord; at: number }[];
  last?: { at: number; ok: boolean; version: string; errors: string[]; needsSignIn?: boolean };
}

const empty = (): RowFile => ({ settings: { newChats: true, offTools: [] }, versions: [] });
const CHAT_LINES = 20;

const keyOf = (owner: McpOwner, name: string) => createHash("sha256").update(`${owner.kind === "computer" ? "computer" : owner.checkout}\0${name}`).digest("hex").slice(0, 32);
const rowPath = (owner: McpOwner, name: string) => join(stateRoot(), "mcp", `${keyOf(owner, name)}.json`);
const chatPath = (owner: McpOwner, name: string) => join(stateRoot(), "mcp", `${keyOf(owner, name)}.chat.json`);

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function readRow(owner: McpOwner, name: string): RowFile {
  try {
    const raw = JSON.parse(readFileSync(rowPath(owner, name), "utf8")) as RowFile;
    return { ...empty(), ...raw, settings: { ...empty().settings, ...raw.settings } };
  } catch {
    return empty();
  }
}

export const changeRow = (owner: McpOwner, name: string, change: (row: RowFile) => void): RowFile => {
  const row = readRow(owner, name);
  change(row);
  writeJson(rowPath(owner, name), row);
  return row;
};

export const recordOf = (row: RowFile, version: string) => row.versions.find((v) => v.version === version)?.record;

/** A Check that worked: this version's record, newest first. */
export function saveCheck(owner: McpOwner, name: string, version: string, record: McpCheckRecord, at = Date.now()): RowFile {
  return changeRow(owner, name, (row) => {
    row.versions = [{ version, record, at }, ...row.versions.filter((v) => v.version !== version)].slice(0, MCP_VERSIONS_KEPT);
    row.last = { at, ok: true, version, errors: [] };
  });
}

/** A Check that failed: the record the same version had stays. */
export function saveFailedCheck(owner: McpOwner, name: string, version: string, errors: string[], needsSignIn = false, at = Date.now()): RowFile {
  return changeRow(owner, name, (row) => {
    row.last = { at, ok: false, version, errors, ...(needsSignIn ? { needsSignIn } : {}) };
  });
}

export function chatLines(owner: McpOwner, name: string): McpErrorLine[] {
  try {
    return JSON.parse(readFileSync(chatPath(owner, name), "utf8")) as McpErrorLine[];
  } catch {
    return [];
  }
}

/** A chat's copy failed: its line joins the row's, newest first. */
export const addChatLine = (owner: McpOwner, name: string, line: McpErrorLine): void => writeJson(chatPath(owner, name), [line, ...chatLines(owner, name)].slice(0, CHAT_LINES));

export function forgetRow(owner: McpOwner, name: string): void {
  rmSync(rowPath(owner, name), { force: true });
  rmSync(chatPath(owner, name), { force: true });
}
