/**
 * MCP servers on the wire (§app/mcp): what the Settings tab, the project page, the setup card and a chat's
 * note read. Rows carry codes and names; the page draws the words (§design.copy-deck/mcp-servers). A
 * refusal is a non-2xx `{error, code?}` whose `error` is the deck's own sentence. No answer ever carries a
 * secret's value. Imports nothing.
 */

/** The first that applies, §app.mcp/rows. `no-check`: approved, nothing recorded (a Check was cut off). */
export type McpRowState = "waiting" | "off" | "needs-sign-in" | "failed" | "connected" | "no-check";

export interface McpServerRow {
  /** Opaque and URL-safe: computer + name, or project + checkout + name. */
  id: string;
  name: string;
  source: "computer" | "project";
  kind: "address" | "command";
  state: McpRowState;
  /** A Check is running now. */
  checking?: boolean;
  /** Tools in the record, on or off; 0 with none. */
  toolCount: number;
  newChats: boolean;
  tools: { name: string; description?: string; tokens: number; on: boolean }[];
  /** Newest first; free of secret values. */
  errors: McpErrorLine[];
  lastCheck?: { at: number; ok: boolean };
  signsIn: boolean;
  /** Can't run. reserved and bad-value: no Approve, no Check. */
  refused?: { why: "reserved" } | { why: "bad-value"; names: string[] };
  /** What Approve approves; on every row. */
  entry: {
    /** Sent back by Approve. */
    version: string;
    /** Command and arguments, joined for reading. */
    runs?: string;
    address?: string;
    /** Environment value and header names. */
    values: string[];
    /** Names only. */
    secrets: string[];
    /** "Runs the newest version each start." */
    unpinned: boolean;
  };
  /** Waiting because an approved version changed. */
  changed?: boolean;
  /** Presence only: no value, no last 4, ever. `saved: false` on a row that needs it can't start. */
  secrets: { name: string; saved: boolean }[];
  /** Computer rows. */
  replacedIn?: { project: string; projectId: string; name: string }[];
  /** Computer rows: prefills Edit. */
  edit?: { address?: string; command?: string; secretName?: string };
}

export interface McpErrorLine {
  line: string;
  /** From a chat's copy; absent: the last Check. */
  chat?: string;
  /** write-only: `chat` is the worker's name. */
  where?: "sandbox" | "write-only";
}

/** GET /api/mcp/servers */
export interface McpServers {
  servers: McpServerRow[];
}

/** GET /api/projects/:id/mcp */
export interface McpProjectServers {
  checkouts: { folder: string; file: "missing" | "ok" | "broken"; error?: string; servers: McpServerRow[] }[];
}

export type McpNewServer =
  | { way: "address"; name: string; address: string; secret?: string }
  /** `command` is one line; the server splits it. */
  | { way: "command"; name: string; command: string; secret?: string; secretName?: string }
  /** Every way has a Name; a pasted name fills it. */
  | { way: "paste"; name: string; text: string };

export type McpSignIn =
  | { state: "starting" }
  | { state: "waiting"; url: string }
  | { state: "done"; row: McpServerRow }
  | { state: "failed"; error: string };

/** SessionSetup's `mcp`, on `ok`, `remote` and `unavailable`. Absent: no group. */
export interface SetupMcp {
  line?: { why: "remote"; target: string } | { why: "profile"; profile: string };
  /** "This folder isn't a project, so its .mcp.json won't run." */
  notProject?: boolean;
  rows: {
    name: string;
    source: "computer" | "project";
    /** Its tools that are on, at its last Check. */
    tokens?: number;
    /** This chat's value now. */
    on: boolean;
    /** What it starts as. */
    newChats: boolean;
    /** No switch, and why. */
    off?: "waiting" | "no-check" | "sandbox" | "address-in-chat";
  }[];
}

/** On a TranscriptItem of kind "info", saved as `loginNote` is, so a reload keeps it. */
export interface McpNote {
  server: string;
  how: "failed" | "sandbox" | "write-only" | "address-under-on" | "changed" | "other-computer";
  /** failed */
  reason?: string;
  /** write-only */
  worker?: string;
  /** other-computer */
  host?: string;
  /** Absent on other-computer. */
  link?: { to: "settings"; id: string } | { to: "project"; projectId: string; id: string };
}

/** A tool row's server and tool, set by the server: a hashed tool name has lost the raw one. */
export interface McpToolName {
  server: string;
  tool: string;
}

/** `code` on a refusal. */
export type McpErrorCode = "changed" | "reserved" | "page-only" | "exists" | "invalid";
