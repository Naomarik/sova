// Remove takes a server's sign-in with it (§app.mcp/rows): its keys in pi's `mcp-auth.json` (`<namespace>|<url>`,
// quirk P33). The file stays the owner's alone.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentRoot } from "../state-root";
import type { McpEntry } from "./config";

export function forgetSignIn(e: McpEntry): void {
  if (!e.url) return;
  const path = join(agentRoot(), "mcp-auth.json");
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  let url: string;
  try {
    url = String(new URL(e.url));
  } catch {
    return;
  }
  const key = `mcp__${e.name.replace(/-/g, "_")}|${url}`;
  if (!(key in doc)) return;
  delete doc[key];
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
