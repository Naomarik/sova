// Where a folder's `.mcp.json` lives and whether any server could be on in a chat there, from the disk alone, so a
// chat's process can tell it has nothing to ask.
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { McpListAsk } from "./chat";
import { readComputerList, projectListPath } from "./config";
import { chatListOf, NO_MCP, type McpChatList } from "./list";

export const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** The top of the checkout a folder is in, by its `.git`; null when it is in none. */
export function checkoutRootOf(cwd: string): string | null {
  for (let dir = real(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** Where a chat in `cwd` could find a project's list: its checkout's top, or with no checkout its folder and every one above it
    (the server may take a project's root above it). */
function projectListsFor(cwd: string): string[] {
  const top = checkoutRootOf(cwd);
  if (top) return [projectListPath(top)];
  const out: string[] = [];
  for (let dir = real(cwd); ; dir = dirname(dir)) {
    out.push(projectListPath(dir));
    if (dirname(dir) === dir) return out;
  }
}

/**
 * No server could be on in a chat here, from the disk alone: no `.mcp.json` where its folder's list could be (a project's
 * rows need the server's engines), and none of this computer's on for it (approved, checked, on for it, and no address
 * server under Sandbox On).
 */
export function nothingCouldBeOn(ask: Pick<McpListAsk, "cwd" | "sandboxOn" | "offMcp" | "onMcp">): boolean {
  if (projectListsFor(ask.cwd).some((p) => existsSync(p))) return false;
  if (readComputerList().entries.length === 0) return true;
  return chatListOf({ project: null, checkout: real(ask.cwd) }, ask, ask.sandboxOn).servers.length === 0;
}

/** A chat's list, as its process takes it: the server's answer as it is, or none, unasked, where no server could be on.
    Never its own reading in place of the server's: a remote chat, whose files aren't here, gets the server's none. */
export async function askedList<A extends McpListAsk>(ask: A, server: (ask: A) => Promise<McpChatList | null>): Promise<McpChatList | null> {
  return nothingCouldBeOn(ask) ? NO_MCP : server(ask);
}
