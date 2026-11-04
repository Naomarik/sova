// Saved secrets: `<state root>/secrets/mcp/` (0700), one file (0600) per value, the whole file
// the value, which is what the Overseer's redactor reads (server/overseer-redact.ts). A secret belongs to its row:
// a computer server, or a project's server, every checkout of the project sharing it. So a repository can't reach
// another's by naming it. Nothing here answers a value but `readSecret`, which only a start or a Check calls.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "../state-root";
import type { McpOwner } from "./trust";

export const mcpSecretsDir = () => join(stateRoot(), "secrets", "mcp");

const prefixOf = (owner: McpOwner, server: string) =>
  createHash("sha256").update(`${owner.kind === "computer" ? "computer" : `project:${owner.projectId}`}\0${server}`).digest("hex").slice(0, 32);
const fileOf = (owner: McpOwner, server: string, name: string) => join(mcpSecretsDir(), `${prefixOf(owner, server)}.${name}`);

export function readSecret(owner: McpOwner, server: string, name: string): string | undefined {
  try {
    return readFileSync(fileOf(owner, server, name), "utf8");
  } catch {
    return undefined;
  }
}

export const hasSecret = (owner: McpOwner, server: string, name: string): boolean => readSecret(owner, server, name) !== undefined;

export function saveSecret(owner: McpOwner, server: string, name: string, value: string): void {
  const dir = mcpSecretsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = fileOf(owner, server, name);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, value, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export const removeSecret = (owner: McpOwner, server: string, name: string): void => rmSync(fileOf(owner, server, name), { force: true });

export function removeServerSecrets(owner: McpOwner, server: string): void {
  const prefix = `${prefixOf(owner, server)}.`;
  let names: string[] = [];
  try {
    names = readdirSync(mcpSecretsDir());
  } catch {
    return;
  }
  for (const n of names) if (n.startsWith(prefix)) rmSync(join(mcpSecretsDir(), n), { force: true });
}

/** Every saved value of a server, to take out of an error line. */
export function secretValues(owner: McpOwner, server: string): string[] {
  const prefix = `${prefixOf(owner, server)}.`;
  let names: string[] = [];
  try {
    names = readdirSync(mcpSecretsDir());
  } catch {
    return [];
  }
  return names.filter((n) => n.startsWith(prefix)).flatMap((n) => {
    try {
      return [readFileSync(join(mcpSecretsDir(), n), "utf8")];
    } catch {
      return [];
    }
  });
}

/** `text` with each value gone. */
export function withoutSecrets(text: string, values: readonly string[]): string {
  let out = text;
  for (const v of [...values].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(v).join("[secret]");
  return out;
}
