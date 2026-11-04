// A server as it stands on disk now: its entry, version, approval and values. Files only, so a chat's process
// checks a start with no server to ask.
import { isAbsolute, resolve } from "node:path";
import type { McpServerRow } from "../../shared/mcp";
import { agentRoot } from "../state-root";
import { readComputerList, readProjectList, reservedName, type McpEntry } from "./config";
import { versionOf, namedFolders } from "./fingerprint";
import { readSecret } from "./saved-values";
import { isApproved, type McpOwner } from "./trust";
import { fillValues, namedValues } from "./values";

export const baseOf = (owner: McpOwner): string => (owner.kind === "computer" ? agentRoot() : owner.checkout);
export const sourceOf = (owner: McpOwner): "computer" | "project" => (owner.kind === "computer" ? "computer" : "project");

export function currentEntry(owner: McpOwner, name: string): McpEntry | undefined {
  const list = owner.kind === "computer" ? readComputerList() : readProjectList(owner.checkout);
  return list.entries.find((e) => e.name === name);
}

export type McpRefused = NonNullable<McpServerRow["refused"]>;

/** Why an entry can't run whatever anyone approves. */
export function refusalOf(e: McpEntry): McpRefused | undefined {
  if (reservedName(e.name)) return { why: "reserved" };
  if (e.problems?.length) return { why: "unusable", names: e.problems };
  const { bad } = namedValues(e);
  return bad.length ? { why: "bad-value", names: bad } : undefined;
}

/**
 * The names the row asks a secret for. In a project's file a value can name only a saved secret, so every name is
 * one; a computer entry may name an environment variable, which then needs nothing saved.
 */
export function secretNames(owner: McpOwner, e: McpEntry, env: NodeJS.ProcessEnv = process.env): string[] {
  const { names } = namedValues(e);
  return owner.kind === "computer" ? names.filter((n) => env[n] === undefined || readSecret(owner, e.name, n) !== undefined) : names;
}

export type McpReady =
  | { ok: true; entry: McpEntry; version: string; cwd: string | null; values: string[] }
  | { ok: false; how: "changed" | "failed"; reason: string };

/**
 * Whether this server may start now, and with what. `cwd` null: the chat's own folder. A value is filled here and
 * nowhere else, from the row's saved secrets, and a computer entry's environment variable by that name.
 */
export function readyToRun(owner: McpOwner, name: string, env: NodeJS.ProcessEnv = process.env): McpReady {
  const e = currentEntry(owner, name);
  if (!e) return { ok: false, how: "failed", reason: "it was removed from Sova" };
  const refused = refusalOf(e);
  if (refused) return { ok: false, how: "failed", reason: refused.why === "reserved" ? "the name is Sova's own" : `its entry can't run: ${refused.names.join(", ")}` };
  const base = baseOf(owner);
  const version = versionOf(e, base);
  if (!isApproved(owner, name, version)) return { ok: false, how: "changed", reason: "it changed and is waiting for your approval" };
  const values: string[] = [];
  const { entry, missing } = fillValues(e, (n) => {
    const value = readSecret(owner, name, n) ?? (owner.kind === "computer" ? env[n] : undefined);
    if (value !== undefined) values.push(value);
    return value;
  });
  if (missing.length) return { ok: false, how: "failed", reason: `${missing[0]} isn't saved yet` };
  return { ok: true, entry, version, cwd: cwdOf(e, owner, base), values };
}

/** A project's server starts at its checkout; a computer's in the chat's folder, unless it names `./` paths, which are approved from the agent dir. */
function cwdOf(e: McpEntry, owner: McpOwner, base: string): string | null {
  if (e.cwd) return isAbsolute(e.cwd) ? e.cwd : resolve(base, e.cwd);
  if (owner.kind === "project") return base;
  return namedFolders(e, base).length ? base : null;
}
