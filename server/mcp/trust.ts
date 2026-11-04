// Approvals (§app.mcp/approval): `<state root>/mcp-trust.json`, per computer and per checkout, outside every
// repository. The newest 8 versions of each server stay approved. Only the page's route writes here.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "../state-root";

export const MCP_VERSIONS_KEPT = 8;
export const mcpTrustFile = () => join(stateRoot(), "mcp-trust.json");

/** Whose list a server is on. `checkout`: a real path, so each worktree approves its own copy. */
export type McpOwner = { kind: "computer" } | { kind: "project"; projectId: string; checkout: string };

type Versions = { version: string; at: string }[];
interface TrustFile {
  version: 1;
  computer: Record<string, Versions>;
  checkouts: Record<string, Record<string, Versions>>;
}

function read(): TrustFile {
  try {
    const raw = JSON.parse(readFileSync(mcpTrustFile(), "utf8")) as Partial<TrustFile>;
    if (raw?.version === 1) return { version: 1, computer: raw.computer ?? {}, checkouts: raw.checkouts ?? {} };
  } catch {
    // none yet, or unreadable: nothing is approved
  }
  return { version: 1, computer: {}, checkouts: {} };
}

function write(t: TrustFile): void {
  const file = mcpTrustFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(t, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

const shelf = (t: TrustFile, owner: McpOwner): Record<string, Versions> => (owner.kind === "computer" ? t.computer : (t.checkouts[owner.checkout] ??= {}));

export const approvedVersions = (owner: McpOwner, name: string): string[] => (shelf(read(), owner)[name] ?? []).map((v) => v.version);
export const isApproved = (owner: McpOwner, name: string, version: string): boolean => approvedVersions(owner, name).includes(version);

export function approve(owner: McpOwner, name: string, version: string): void {
  const t = read();
  const s = shelf(t, owner);
  s[name] = [{ version, at: new Date().toISOString() }, ...(s[name] ?? []).filter((v) => v.version !== version)].slice(0, MCP_VERSIONS_KEPT);
  write(t);
}

export function forgetApprovals(owner: McpOwner, name: string): void {
  const t = read();
  delete shelf(t, owner)[name];
  write(t);
}
