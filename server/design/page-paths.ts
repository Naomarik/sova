// Where a chat that reads a design's page finds it. A read hands over the saved file's path, never the page itself, so
// a page enters a model's context only as far as it reads the file. A chat whose sandbox is on reads only what its
// policy leaves visible: the design folder is visible under the default policy (everything but the hidden paths is
// readable), but a policy may hide it. Then the page is exposed to that one chat, read-only, as a copy in its own
// session tmp, at the path its tools see. Never the page inlined instead.
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HEntry } from "../../shared/harness";
import { canonicalize, readDenial } from "../../pi-config/extensions/sandbox/policy.ts";
import { extensionEntries } from "../harness/pi/state";
import { sandboxOf, type LinkSandbox } from "../link-sandbox";
import { agentRoot } from "../state-root";
import { pageFile } from "./store";

/** The chat that reads: its id, folder and active branch (what says whether its sandbox is on). */
export interface PageReader {
  sessionId: string;
  cwd: string;
  branch(): readonly HEntry[];
}

let sandboxFor = (r: PageReader): LinkSandbox => sandboxOf({ sessionId: r.sessionId, cwd: r.cwd }, extensionEntries(r.branch() as HEntry[]), { agentDir: agentRoot() });
/** Tests: stand in for a reader's sandbox. */
export const setPageReaderSandboxForTest = (fn: ((r: PageReader) => LinkSandbox) | null): void =>
  void (sandboxFor = fn ?? ((r) => sandboxOf({ sessionId: r.sessionId, cwd: r.cwd }, extensionEntries(r.branch() as HEntry[]), { agentDir: agentRoot() })));

/** The path `reader` opens a saved version at: the file itself, or, when its sandbox hides the design folder, a
    read-only copy in its session tmp (on Linux at /tmp/..., where its tools see that tmp). */
export function pagePathFor(sessionId: string, label: string, n: number, reader?: PageReader, platform: NodeJS.Platform = process.platform): { path: string; exposed?: true } {
  const file = pageFile(sessionId, label, n);
  if (!reader) return { path: file };
  const box = sandboxFor(reader);
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
