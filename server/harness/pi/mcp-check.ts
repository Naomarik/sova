// A short-lived pi runtime with pi's MCP extension and one address server, for a Check and a Sign In: pi's HTTP
// client, OAuth and token store, with no chat and no model. Runs only in server/mcp/check-child.ts. Quirks P14, P32.
// pi's HTTP path expands `!command` and `${VAR}` in headers and oauth.clientSecret, so every value reaches it as an
// indirection to a variable of this process holding the literal: nothing in a value is ever read as a command.
import { createAgentSessionFromServices, createAgentSessionServices, createMcpExtension, ModelRuntime, SessionManager, type McpServerConfig } from "@earendil-works/pi-coding-agent";
import type { McpEntry } from "../../mcp/config";
import type { McpCheckRecord, McpRecordTool } from "../../mcp/store";
import { agentRoot, stateRoot } from "../../state-root";
import { join } from "node:path";
import type { CheckAnswer } from "../../mcp/check-child";
import type { PiExtensionAPI } from "./extension-types";

let held = 0;
/** `${VAR}` naming a variable of this process that holds `value`, literally. */
function literal(value: string): string {
  const name = `SOVA_MCP_VALUE_${held++}`;
  process.env[name] = value;
  return `\${${name}}`;
}

export function literalConfig(e: McpEntry): McpServerConfig {
  const headers = e.headers ? Object.fromEntries(Object.entries(e.headers).map(([k, v]) => [k, literal(v)])) : undefined;
  const secret = e.oauth?.clientSecret;
  const oauth = e.oauth ? { ...e.oauth, ...(typeof secret === "string" ? { clientSecret: literal(secret) } : {}) } : undefined;
  return { url: e.url!, exposure: "direct", ...(headers ? { headers } : {}), ...(oauth ? { oauth } : {}), ...(e.auth ? { auth: e.auth } : {}), ...(e.timeout ? { timeout: e.timeout } : {}) } as McpServerConfig;
}

interface Tapped {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  namespace?: { instructions?: string };
}

interface Ui {
  openUrl?: (url: string) => void;
  input?: (title: string, placeholder?: string, options?: { signal?: AbortSignal }) => Promise<string | undefined>;
}

async function open(e: McpEntry, cwd: string, ui: Ui) {
  const agentDir = agentRoot();
  const notes: string[] = [];
  const seen: Tapped[] = [];
  const inner = createMcpExtension({
    loadConfig: () => ({ servers: [{ name: e.name, source: "sova", scope: "global", config: literalConfig(e) }], errors: [], autoEnableCodemode: false }),
    updateConfig: () => {},
    logPath: join(stateRoot(), "mcp.log"),
    ...(ui.openUrl ? { openUrl: ui.openUrl } : {}),
  });
  // The tool's raw name and its schema: `getAllTools` has no label, and a hashed name has lost the raw one.
  const factory = (api: PiExtensionAPI) =>
    inner(
      new Proxy(api, {
        get(t, k, r) {
          if (k === "registerTool") return (d: Tapped) => (seen.push(d), (t.registerTool as (x: unknown) => void)(d));
          const v = Reflect.get(t, k, r);
          return typeof v === "function" ? v.bind(t) : v;
        },
      }),
    );
  const modelRuntime = await ModelRuntime.create();
  const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime, resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true, extensionFactories: [{ name: "sova-mcp-check", factory }] } });
  const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(cwd) });
  const uiContext = {
    notify: (text: string) => void notes.push(text),
    setStatus() {},
    select: async () => undefined,
    confirm: async () => false,
    input: ui.input ?? (async () => undefined),
    custom: async () => undefined,
    setWidget() {},
    theme: {},
  };
  await session.bindExtensions({ uiContext: uiContext as never, mode: "rpc" as never });
  const runner = (session as unknown as { extensionRunner: { getCommand(n: string): { handler(a: string, c: unknown): Promise<void> } | undefined; createCommandContext(): unknown } }).extensionRunner;
  const command = runner.getCommand("mcp");
  if (!command) throw new Error("pi's /mcp command is missing");
  const ctx = runner.createCommandContext();
  const run = async (args: string): Promise<string[]> => {
    const from = notes.length;
    await command.handler(args, ctx);
    return notes.slice(from);
  };
  return { run, seen, notes };
}

const recordOf = (name: string, seen: readonly Tapped[]): McpCheckRecord => {
  const tools = new Map<string, McpRecordTool>();
  for (const d of seen) {
    const raw = d.label?.startsWith(`${name}/`) ? d.label.slice(name.length + 1) : d.name;
    tools.set(raw, { name: raw, ...(d.description ? { description: d.description } : {}), inputSchema: (d.parameters ?? { type: "object", properties: {} }) as Record<string, unknown> });
  }
  const instructions = seen.find((d) => d.namespace?.instructions)?.namespace?.instructions;
  return { protocolVersion: "2025-06-18", serverInfo: { name, version: "" }, ...(instructions ? { instructions } : {}), tools: [...tools.values()] };
};

/** The status line `/mcp` prints for this server: pi's only read of "needs sign-in" (quirk P32). */
export function readStatus(name: string, lines: readonly string[]): { state: "connected" | "needs-sign-in" | "failed"; errors: string[] } {
  const text = lines.join("\n").split("\n");
  const at = text.findIndex((l) => l.startsWith(`${name}: `));
  const line = at < 0 ? "" : text[at]!;
  if (line.startsWith(`${name}: needs sign-in`)) return { state: "needs-sign-in", errors: [] };
  if (line.startsWith(`${name}: connected`)) return { state: "connected", errors: [] };
  const tail = at < 0 ? [] : text.slice(at + 1).filter((l) => l.startsWith("    ")).map((l) => l.trim());
  return { state: "failed", errors: [line ? line.slice(name.length + 2) : "the server didn't answer", ...tail] };
}

export async function checkAddress(e: McpEntry, cwd: string): Promise<CheckAnswer> {
  const r = await open(e, cwd, {});
  const status = readStatus(e.name, await r.run(""));
  if (status.state === "connected") return { ok: true, record: recordOf(e.name, r.seen) };
  return { ok: false, errors: status.errors, needsSignIn: status.state === "needs-sign-in" };
}

export interface SignInIo {
  url(url: string): void;
  /** Stays pending until the person pastes or the signal aborts: answering undefined cancels the sign-in at once. */
  pasted(signal: AbortSignal | undefined): Promise<string | undefined>;
}

export async function signInAddress(e: McpEntry, cwd: string, io: SignInIo): Promise<{ ok: boolean; error?: string }> {
  const r = await open(e, cwd, { openUrl: io.url, input: (_t, _p, o) => io.pasted(o?.signal) });
  const notes = await r.run(`login ${e.name}`);
  const status = readStatus(e.name, await r.run(""));
  return status.state === "connected" ? { ok: true } : { ok: false, error: [...notes, ...status.errors].join(" ").trim() || "The sign-in didn't finish." };
}
