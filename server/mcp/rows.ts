// A server's row as the page, the setup card and the catalogue read it. Reads files; runs nothing.
import type { McpRowState, McpServerRow, McpErrorLine } from "../../shared/mcp";
import { CHARS_PER_TOKEN } from "../../shared/protocol";
import type { McpEntry } from "./config";
import { versionOf } from "./fingerprint";
import { hasSignIn } from "./forget-sign-in";
import { rowId } from "./ids";
import { baseOf, refusalOf, secretNames, sourceOf } from "./resolve";
import { hasSecret, secretValues, withoutSecrets } from "./saved-values";
import { chatLines, readRow, recordOf, type McpRecordTool, type RowFile } from "./store";
import { approvedVersions, isApproved, type McpOwner } from "./trust";
import { unpinned } from "./values";

/** What one declared tool costs a model, by the same estimate as the setup card's context files. */
export const toolTokens = (t: McpRecordTool): number => Math.ceil(JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema }).length / CHARS_PER_TOKEN);

const authorized = (e: McpEntry) => Object.keys(e.headers ?? {}).some((h) => h.toLowerCase() === "authorization");

/** The first state that applies. */
export function rowState(approved: boolean, row: RowFile, version: string): McpRowState {
  if (!approved) return "waiting";
  if (!row.settings.newChats) return "off";
  const last = row.last?.version === version ? row.last : undefined;
  if (last?.needsSignIn) return "needs-sign-in";
  if (last && !last.ok) return "failed";
  return recordOf(row, version) ? "connected" : "no-check";
}

export interface RowExtras {
  checking?: boolean;
  replacedIn?: McpServerRow["replacedIn"];
}

export function rowOfEntry(owner: McpOwner, e: McpEntry, extras: RowExtras = {}): McpServerRow {
  const version = versionOf(e, baseOf(owner));
  const row = readRow(owner, e.name);
  const approved = isApproved(owner, e.name, version);
  const refused = refusalOf(e);
  const state = refused ? "waiting" : rowState(approved, row, version);
  // A changed entry has no record until a Check of the new version succeeds.
  const record = recordOf(row, version);
  const off = new Set(row.settings.offTools);
  const values = secretValues(owner, e.name);
  const needed = secretNames(owner, e);
  const clean = (line: McpErrorLine): McpErrorLine => ({ ...line, line: withoutSecrets(line.line, values) });
  const errors = [...chatLines(owner, e.name), ...(row.last?.errors ?? []).map((line) => ({ line }))].map(clean);
  const runs = e.command ? [e.command, ...(e.args ?? [])].join(" ") : undefined;
  return {
    id: rowId({ owner, name: e.name }),
    name: e.name,
    source: sourceOf(owner),
    kind: e.kind,
    state,
    ...(extras.checking ? { checking: true } : {}),
    toolCount: record?.tools.length ?? 0,
    newChats: row.settings.newChats,
    tools: (record?.tools ?? []).map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), tokens: toolTokens(t), on: !off.has(t.name) })),
    errors,
    ...(row.last ? { lastCheck: { at: row.last.at, ok: row.last.ok } } : {}),
    signsIn: e.kind === "address" && !authorized(e) && (hasSignIn(e) || (row.last?.version === version && !!row.last.needsSignIn)),
    ...(refused ? { refused } : {}),
    entry: {
      version,
      ...(runs ? { runs } : {}),
      ...(e.url ? { address: e.url } : {}),
      values: [...Object.keys(e.env ?? {}), ...Object.keys(e.headers ?? {})],
      secrets: needed,
      unpinned: unpinned(e),
    },
    ...(!approved && !refused && approvedVersions(owner, e.name).length ? { changed: true } : {}),
    secrets: needed.map((name) => ({ name, saved: hasSecret(owner, e.name, name) })),
    ...(extras.replacedIn?.length ? { replacedIn: extras.replacedIn } : {}),
    ...(owner.kind === "computer" ? { edit: editOf(e) } : {}),
  };
}

/** What Edit opens with. A secret's own value is never part of it. */
function editOf(e: McpEntry): NonNullable<McpServerRow["edit"]> {
  const named = /^\$\{([^}]+)\}$/;
  const envName = Object.entries(e.env ?? {}).find(([, v]) => named.test(v))?.[0];
  if (e.url) return { address: e.url };
  return { command: [e.command!, ...(e.args ?? [])].map(quoted).join(" "), ...(envName ? { secretName: envName } : {}) };
}

/** One word of a command line, as `splitCommand` reads it back. */
const quoted = (word: string): string => (word && !/[\s"'\\]/.test(word) ? word : `"${word.replace(/(["\\])/g, "\\$1")}"`);
