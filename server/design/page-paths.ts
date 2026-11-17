// Where a chat that reads a design's page finds it. A read hands over the saved file's path, never the page itself, so
// a page enters a model's context only as far as it reads the file. A chat whose sandbox is on reads only what its
// policy leaves visible: the design folder is visible under the default policy (everything but the hidden paths is
// readable), but a policy may hide it. Then the page is exposed to that one chat, read-only, as a copy in its own
// session tmp, at the path its tools see. Never the page inlined instead.
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalize, readDenial } from "../../pi-config/extensions/sandbox/policy.ts";
import type { LinkSandbox } from "../link-sandbox";
import { pageFile } from "./store";

/** The chat that reads, by id. */
export interface PageReader {
  sessionId: string;
}

/** A chat's sandbox as its own tools have it: the server installs its one reading of it (server/app.ts, the same one a
    file copied into a chat honours), so this module never reads a chat's raw entries. None installed: nothing to honour. */
let readerSandbox: ((sessionId: string) => Promise<LinkSandbox>) | null = null;
export const installPageReaderSandbox = (fn: ((sessionId: string) => Promise<LinkSandbox>) | null): void => void (readerSandbox = fn);

/** The path `reader` opens a saved version at: the file itself, or, when its sandbox hides the design folder, a
    read-only copy in its session tmp (on Linux at /tmp/..., where its tools see that tmp). */
export async function pagePathFor(sessionId: string, label: string, n: number, reader?: PageReader, platform: NodeJS.Platform = process.platform): Promise<{ path: string; exposed?: true }> {
  const file = pageFile(sessionId, label, n);
  if (!reader || !readerSandbox) return { path: file };
  const box = await readerSandbox(reader.sessionId);
  // Off: its tools read what the server reads. On but unresolvable: every tool refuses anyway, so the real path is as good as any.
  if (!box.on || !("policy" in box) || !readDenial(box.policy, canonicalize(file))) return { path: file };
  const rel = join("lookbook", `${encodeURIComponent(sessionId)}`, label, `v${n}.html`);
  const copy = join(box.policy.tmpDir, rel);
  if (!existsSync(copy)) {
    mkdirSync(dirname(copy), { recursive: true, mode: 0o700 });
    copyFileSync(file, copy);
    chmodSync(copy, 0o400);
  }
  return { path: platform === "linux" ? join("/tmp", rel) : copy, exposed: true };
}

/** The folder a chat's own tools see as /tmp: its session tmp when its sandbox is on (Linux, where that tmp is mounted at
    /tmp), else null (its /tmp is the server's). */
export async function chatTmpDir(sessionId: string, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  if (!readerSandbox || platform !== "linux") return null;
  try {
    const box = await readerSandbox(sessionId);
    return box.on && "policy" in box ? box.policy.tmpDir : null;
  } catch {
    return null;
  }
}
