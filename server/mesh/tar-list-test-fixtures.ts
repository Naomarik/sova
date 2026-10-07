// Shared by tar-list.test.ts (committed archives) and tar-list.integration.test.ts (the host's own
// tar): the tree both describe and what each archive of it must list.
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { tarMembers, type TarMember } from "./tar-list";

/** Archives GNU tar wrote of the tree below; tar-list.integration.test.ts rewrites them with
 *  SOVA_TAR_FIXTURES_WRITE=1. */
export const FIXTURES = join(import.meta.dirname, "..", "fixtures", "tar-list");
export const longDir = "d".repeat(80);
export const longFile = `${"f".repeat(120)}.txt`;

export async function list(file: string | Buffer): Promise<TarMember[]> {
  const out: TarMember[] = [];
  const it = typeof file === "string" ? createReadStream(file, { highWaterMark: 1000 }) : Readable.from([file]);
  for await (const m of tarMembers(it)) out.push(m);
  return out;
}

export const expectedNames = [
  "proj/",
  "proj/a.txt",
  `proj/${longDir}/`,
  `proj/${longDir}/sub/`,
  `proj/${longDir}/sub/${longFile}`,
  "proj/é-ünï.md",
  "proj/link",
  "proj/longlink",
].sort();

/** What each format's archive of `proj` must list (ustar holds neither a 130-char link target nor a
 *  120-char base name; the long directory path still goes through its prefix/name split). */
export async function checkFormat(format: string, file: string): Promise<void> {
  const got = await list(file);
  if (format === "ustar") {
    assert.deepEqual(
      got.map((m) => m.name).sort(),
      expectedNames.filter((n) => n !== "proj/longlink" && !n.endsWith(longFile)),
    );
    return;
  }
  assert.deepEqual(got.map((m) => m.name).sort(), expectedNames);
  const by = new Map(got.map((m) => [m.name, m]));
  assert.equal(by.get("proj/")!.type, "dir");
  assert.equal(by.get("proj/a.txt")!.type, "file");
  assert.equal(by.get(`proj/${longDir}/sub/${longFile}`)!.size, 3000);
  assert.deepEqual(by.get("proj/link"), { name: "proj/link", type: "symlink", linkname: "a.txt", size: 0 });
  assert.equal(by.get("proj/longlink")!.linkname, join("..", "x".repeat(130)));
}

export async function checkHardLink(file: string): Promise<void> {
  const got = await list(file);
  assert.deepEqual(got.find((m) => m.name === "proj/hard"), { name: "proj/hard", type: "hardlink", linkname: "proj/a.txt", size: 0 });
}
