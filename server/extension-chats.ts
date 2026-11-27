// What an extension that reads chats gets (§app.extensions/reads-chats): the homes folder as
// SOVA_CHATS_DIR, and its own folder in each home, `<home>/ext/<id>/`, which Sova never reads and
// which goes from every home when the extension is removed with its data.
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homesRoot } from "./chat-homes/root";

/** The homes folder an extension that reads chats is given; null when this server has none yet. */
export function chatsDirForExtensions(): string | null {
  try {
    return homesRoot();
  } catch {
    return null;
  }
}

/** Remove the extension's own folder from every home (Remove with Also delete its data). Never throws. */
export function removeExtensionFolders(id: string, dir: string | null = chatsDirForExtensions()): number {
  if (!dir || !id || id === "." || id === ".." || id.includes("/") || id.includes("\\")) return 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const chat of names) {
    try {
      const at = join(dir, chat, "ext", id);
      rmSync(at, { recursive: true, force: false });
      n++;
    } catch {
      // no folder of its own in that home
    }
  }
  return n;
}
