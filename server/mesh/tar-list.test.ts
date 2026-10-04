// Run: pnpm exec tsx --test server/mesh/tar-list.test.ts
// The pre-scan's header reader against archives the host's own tar writes: ustar, pax and GNU
// long names, links, concatenated archives, and a truncated one. Temp trees removed after.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, describe, test } from "node:test";
import { tarMembers, type TarMember } from "./tar-list";

const tmp = mkdtempSync(join(tmpdir(), "sova-tar-list-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const longDir = "d".repeat(80);
const longFile = `${"f".repeat(120)}.txt`;
const src = join(tmp, "src");
mkdirSync(join(src, "proj", longDir, "sub"), { recursive: true });
writeFileSync(join(src, "proj", "a.txt"), "hello\n");
writeFileSync(join(src, "proj", longDir, "sub", longFile), Buffer.alloc(3000, 7));
writeFileSync(join(src, "proj", "é-ünï.md"), "x");
symlinkSync("a.txt", join(src, "proj", "link"));
symlinkSync(join("..", "x".repeat(130)), join(src, "proj", "longlink"));
writeFileSync(join(src, "other.txt"), "other");

/** bsdtar (macOS's tar) spells GNU's format `gnutar`. */
const bsdtar = /bsdtar/.test(execFileSync("tar", ["--version"], { encoding: "utf8" }));

function pack(format: string, ...members: string[]): string {
  const out = join(tmp, `${format}-${members.join("_").replace(/\W/g, "")}.tar`);
  execFileSync("tar", ["-C", src, `--format=${bsdtar && format === "gnu" ? "gnutar" : format}`, "-cf", out, ...members], { env: { ...process.env, LC_ALL: "C" } });
  return out;
}

async function list(file: string | Buffer): Promise<TarMember[]> {
  const out: TarMember[] = [];
  const it = typeof file === "string" ? createReadStream(file, { highWaterMark: 1000 }) : Readable.from([file]);
  for await (const m of tarMembers(it)) out.push(m);
  return out;
}

const expectedNames = [
  "proj/",
  "proj/a.txt",
  `proj/${longDir}/`,
  `proj/${longDir}/sub/`,
  `proj/${longDir}/sub/${longFile}`,
  "proj/é-ünï.md",
  "proj/link",
  "proj/longlink",
].sort();

describe("tarMembers", () => {
  for (const format of ["ustar", "pax", "gnu"]) {
    test(`${format}: names, types, sizes and link targets`, async () => {
      if (format === "ustar") {
        // ustar holds neither a 130-char link target nor a 120-char base name; the long directory
        // path still goes through its prefix/name split.
        const got = await list(pack(format, "--exclude=proj/longlink", `--exclude=${longFile}`, "proj"));
        assert.deepEqual(
          got.map((m) => m.name).sort(),
          expectedNames.filter((n) => n !== "proj/longlink" && !n.endsWith(longFile)),
        );
        return;
      }
      const got = await list(pack(format, "proj"));
      assert.deepEqual(got.map((m) => m.name).sort(), expectedNames);
      const by = new Map(got.map((m) => [m.name, m]));
      assert.equal(by.get("proj/")!.type, "dir");
      assert.equal(by.get("proj/a.txt")!.type, "file");
      assert.equal(by.get(`proj/${longDir}/sub/${longFile}`)!.size, 3000);
      assert.deepEqual(by.get("proj/link"), { name: "proj/link", type: "symlink", linkname: "a.txt", size: 0 });
      assert.equal(by.get("proj/longlink")!.linkname, join("..", "x".repeat(130)));
    });
  }

  test("a hard link names its target", async () => {
    execFileSync("ln", [join(src, "proj", "a.txt"), join(src, "proj", "hard")]);
    try {
      const got = await list(pack("gnu", "proj/a.txt", "proj/hard"));
      assert.deepEqual(got.find((m) => m.name === "proj/hard"), { name: "proj/hard", type: "hardlink", linkname: "proj/a.txt", size: 0 });
    } finally {
      rmSync(join(src, "proj", "hard"));
    }
  });

  test("concatenated archives read as one (as --ignore-zeros extracts them)", async () => {
    const both = Buffer.concat([readFileSync(pack("gnu", "proj")), readFileSync(pack("pax", "other.txt"))]);
    const got = await list(both);
    assert.deepEqual(got.map((m) => m.name).sort(), [...expectedNames, "other.txt"].sort());
  });

  test("a truncated archive throws", async () => {
    const whole = readFileSync(pack("gnu", "proj"));
    // Cut inside the big file's data.
    const at = whole.indexOf(Buffer.from(longFile)) + 512 + 1000;
    await assert.rejects(list(whole.subarray(0, at)), /truncated/);
    // Cut inside a header.
    await assert.rejects(list(whole.subarray(0, 700)), /truncated/);
  });

  test("bytes that aren't tar throw", async () => {
    await assert.rejects(list(Buffer.alloc(1024, 65)), /not a tar header/);
  });

  test("an empty stream lists nothing", async () => {
    assert.deepEqual(await list(Buffer.alloc(0)), []);
  });
});
