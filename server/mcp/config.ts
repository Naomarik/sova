// The two places a server is declared (§app/mcp): this computer's list, `<agent dir>/mcp.json`, in pi's shape,
// so a server added from a terminal shows up too; and a project's shared `.mcp.json` at a checkout's root.
// Both read into one normalized entry. Nothing here runs or expands anything.
import { readFileSync, renameSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentRoot } from "../state-root";

export interface McpEntry {
  name: string;
  kind: "command" | "address";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Where it starts, relative to its checkout (a computer entry: the agent dir). */
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** pi's oauth block, as written. */
  oauth?: Record<string, unknown>;
  /** pi's provider token (`auth: {provider}`): never in a project's file. */
  auth?: { provider: string };
  timeout?: number;
  /** What makes it unusable as written, by field: no Approve, no Check. */
  problems?: string[];
}

export type McpFile = { file: "missing"; entries: McpEntry[] } | { file: "ok"; entries: McpEntry[] } | { file: "broken"; error: string; entries: McpEntry[] };

export const computerListPath = () => join(agentRoot(), "mcp.json");
export const projectListPath = (checkout: string) => join(checkout, ".mcp.json");

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
const stringMap = (v: unknown): v is Record<string, string> => !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((s) => typeof s === "string");

/** One entry in the shape other tools write it. `project`: a repository can't pick where a credential goes. */
export function normalizeEntry(name: string, raw: unknown, source: "computer" | "project"): McpEntry {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const problems: string[] = [];
  const type = r.type;
  if (type !== undefined && type !== "stdio" && type !== "http" && type !== "streamable-http") problems.push(`type: ${String(type)}`);
  const command = typeof r.command === "string" && r.command ? r.command : undefined;
  const url = typeof r.url === "string" && r.url ? r.url : undefined;
  if (!command && !url) problems.push("no command or url");
  if (command && url) problems.push("both command and url");
  if (r.args !== undefined && !strings(r.args)) problems.push("args");
  if (r.env !== undefined && !stringMap(r.env)) problems.push("env");
  if (r.headers !== undefined && !stringMap(r.headers)) problems.push("headers");
  if (r.cwd !== undefined && typeof r.cwd !== "string") problems.push("cwd");
  const auth = r.auth as { provider?: unknown } | undefined;
  if (auth !== undefined && source === "project") problems.push("auth");
  const entry: McpEntry = { name, kind: url && !command ? "address" : "command" };
  if (command) entry.command = command;
  if (strings(r.args) && r.args.length) entry.args = [...r.args];
  if (stringMap(r.env) && Object.keys(r.env).length) entry.env = { ...r.env };
  if (typeof r.cwd === "string") entry.cwd = r.cwd;
  if (url) entry.url = url;
  if (stringMap(r.headers) && Object.keys(r.headers).length) entry.headers = { ...r.headers };
  if (r.oauth && typeof r.oauth === "object" && !Array.isArray(r.oauth)) entry.oauth = r.oauth as Record<string, unknown>;
  if (source === "computer" && typeof auth?.provider === "string") entry.auth = { provider: auth.provider };
  if (typeof r.timeout === "number" && r.timeout > 0) entry.timeout = r.timeout;
  if (problems.length) entry.problems = problems;
  return entry;
}

/** A file's servers. A missing file is no servers; an unreadable one says why and gives none. */
export function readMcpFile(path: string, source: "computer" | "project"): McpFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { file: "missing", entries: [] };
    return { file: "broken", error: (err as Error).message, entries: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { file: "broken", error: (err as Error).message, entries: [] };
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return { file: "broken", error: "it has no mcpServers object", entries: [] };
  return { file: "ok", entries: Object.entries(servers).map(([name, raw]) => normalizeEntry(name, raw, source)) };
}

export const readComputerList = (): McpFile => readMcpFile(computerListPath(), "computer");
export const readProjectList = (checkout: string): McpFile => readMcpFile(projectListPath(checkout), "project");

function writeComputerList(change: (servers: Record<string, unknown>) => void): void {
  const path = computerListPath();
  let doc: Record<string, unknown> = {};
  try {
    doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const servers = { ...((doc.mcpServers ?? {}) as Record<string, unknown>) };
  change(servers);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...doc, mcpServers: servers }, null, 2)}\n`);
  renameSync(tmp, path);
}

/** An entry as the list holds it: pi's keys. */
export function entryJson(e: McpEntry): Record<string, unknown> {
  const { name: _n, kind: _k, problems: _p, ...rest } = e;
  return rest;
}

export const putComputerEntry = (e: McpEntry) => writeComputerList((servers) => void (servers[e.name] = entryJson(e)));
export const removeComputerEntry = (name: string) => writeComputerList((servers) => void delete servers[name]);

/** `sova`, in any case, is Sova's own (§app.mcp/add-server). */
export const reservedName = (name: string): boolean => name.toLowerCase() === "sova";
