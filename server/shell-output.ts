// A finished command's whole output (§chat.shell-mode/card), in pages: GET /api/sessions/shell-output. The
// card shows the saved tail; its window reads every byte from here, a page at a time. The file is the one the
// command's own saved entry names (never a path from the caller), a regular file of this account with pi's
// output-file name; a command whose output was never cut is its saved output. Once the file is gone (its chat
// was archived), the answer is not found.
import { closeSync, lstatSync, openSync, readSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { HEntry } from "../shared/harness";
import type { ShellOutputPage } from "../shared/protocol";
import { parsePi } from "./harness/pi/reader";
import { ownOutputPath } from "./shell-model";

/** At most this many bytes of output a page (a page that isn't the last ends on a whole character). */
export const SHELL_OUTPUT_PAGE_BYTES = 1_000_000;

/** pi's name for a command's full-output file (its createOutputFileStream("pi-bash", ".log")). */
const OUTPUT_FILE = /^pi-bash-[0-9a-f]+\.log$/;

/** A path a saved command names as its full output, when it is one Sova may read or delete: pi's file name, a
    regular file (never a link) owned by this account. */
export function ownOutputFile(path: string | undefined): string | null {
  if (!path || !OUTPUT_FILE.test(basename(path))) return null;
  try {
    const st = lstatSync(path);
    if (!st.isFile() || (process.getuid && st.uid !== process.getuid())) return null;
    return path;
  } catch {
    return null;
  }
}

/** The bytes [from, from + max) of `buf`, cut back to a whole UTF-8 character unless they reach its end. */
function pageOf(read: (from: number, max: number) => Buffer, size: number, from: number): ShellOutputPage {
  const start = Math.min(Math.max(0, from), size);
  let bytes = read(start, Math.min(SHELL_OUTPUT_PAGE_BYTES, size - start));
  const end = start + bytes.length;
  if (end < size) {
    // Drop a character the page cut in two: back off over continuation bytes to its lead byte.
    let cut = bytes.length;
    while (cut > 0 && (bytes[cut - 1]! & 0xc0) === 0x80) cut--;
    if (cut > 0 && bytes[cut - 1]! >= 0xc0) cut--;
    if (cut > 0) bytes = bytes.subarray(0, cut);
  }
  const next = start + bytes.length;
  return { output: bytes.toString("utf8"), from: start, next: next < size ? next : null, bytes: size };
}

export type ShellOutputAnswer = { status: 200; body: ShellOutputPage } | { status: 404; error: string; code: "no-command" | "gone" };

/** The page of command `entryId`'s whole output in session `sessionPath` that starts at byte `from`. */
export async function shellOutputPage(sessionPath: string, entryId: string, from: number): Promise<ShellOutputAnswer> {
  const { entries } = parsePi(await readFile(sessionPath, "utf8"));
  const h = entries.find((e): e is Extract<HEntry, { kind: "shell" }> => e.kind === "shell" && e.id === entryId);
  if (!h) return { status: 404, error: "No such command in this chat.", code: "no-command" };
  if (!h.truncated || !h.fullOutputPath) {
    const buf = Buffer.from(h.output ?? "", "utf8");
    return { status: 200, body: pageOf((s, n) => buf.subarray(s, s + n), buf.length, from) };
  }
  const file = ownOutputFile(h.fullOutputPath);
  if (!file) return { status: 404, error: "The full output is gone: it is deleted when its chat is archived.", code: "gone" };
  const fd = openSync(file, "r");
  try {
    const size = lstatSync(file).size;
    return {
      status: 200,
      body: pageOf(
        (s, n) => {
          const b = Buffer.alloc(n);
          const got = readSync(fd, b, 0, n, s);
          return b.subarray(0, got);
        },
        size,
        from,
      ),
    };
  } finally {
    closeSync(fd);
  }
}

/** Every full-output file a session's commands name that Sova may delete (ownOutputFile). */
export function outputFilesOf(entries: readonly HEntry[]): string[] {
  const out = new Set<string>();
  for (const e of entries) if (e.kind === "shell") {
    // The harness's file, and the one Sova writes for the model when the harness wrote none (server/shell-model.ts).
    const f = ownOutputFile(e.fullOutputPath ?? ownOutputPath(e.sentAt, e.command ?? "", e.output ?? ""));
    if (f) out.add(f);
  }
  return [...out];
}

/** Archiving a chat deletes its commands' full-output files (§chat.shell-mode/lifecycle): read once its chat
    closed, so a command the close stopped is among them. The saved, cut output stays in the transcript. */
export async function removeOutputFiles(sessionPath: string): Promise<number> {
  const text = await readFile(sessionPath, "utf8").catch(() => "");
  let n = 0;
  for (const f of outputFilesOf(parsePi(text).entries)) {
    try {
      unlinkSync(f);
      n++;
    } catch {
      /* gone already */
    }
  }
  return n;
}
