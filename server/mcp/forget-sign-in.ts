// A server's sign-in in pi's `mcp-auth.json` (`<namespace>|<url>`, quirk P33). Remove takes it, and an Edit that
// moves the server takes the old address's. The file stays the owner's alone.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentRoot } from "../state-root";
import type { McpEntry } from "./config";

const authPath = () => join(agentRoot(), "mcp-auth.json");

/** pi's key for this server's sign-in at this address. */
function keyOf(e: McpEntry): string | undefined {
  try {
    return e.url ? `mcp__${e.name.replace(/-/g, "_")}|${String(new URL(e.url))}` : undefined;
  } catch {
    return undefined;
  }
}

function readAuth(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(authPath(), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** A sign-in is kept for this server at this address. */
export function hasSignIn(e: McpEntry): boolean {
  const key = keyOf(e);
  return !!key && key in readAuth();
}

export function forgetSignIn(e: McpEntry): void {
  const key = keyOf(e);
  const doc = readAuth();
  if (!key || !(key in doc)) return;
  delete doc[key];
  const path = authPath();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
