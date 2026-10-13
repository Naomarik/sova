// The Bun chat processes and workers run on (§app.chat-processes/workers): the server's own runtime.
// A server on Node has none, so it opens no chats and starts no workers.

/** What a worker start answers on a server that has no Bun to run the chat runtime. */
export const NO_BUN = "Workers need Bun to run Sova's chat runtime";
export const NO_BUN_CHATS = "Chats need Bun to run Sova's chat runtime";

/** This server's Bun for chat processes: its own runtime, or null on Node. */
export function chatBun(versions: NodeJS.ProcessVersions = process.versions, execPath = process.execPath): string | null {
  return versions.bun ? execPath : null;
}
