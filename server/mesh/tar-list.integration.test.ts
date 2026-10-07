// Run: node scripts/run-tests.mjs server/mesh/tar-list.integration.test.ts
// The host's own tar (GNU, or bsdtar on macOS) still writes what the committed archives in
// server/fixtures/tar-list/ hold: ustar, pax and GNU long names, links. SOVA_TAR_FIXTURES_WRITE=1
// rewrites those archives from this host's tar (GNU tar for the committed ones). Temp trees removed after.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { checkFormat, checkHardLink, FIXTURES, longDir, longFile } from "./tar-list-test-fixtures";

const tmp = mkdtempSync(join(tmpdir(), "sova-tar-list-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

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

function pack(name: string, format: string, ...members: string[]): string {
  const out = join(tmp, name);
  const fixed = bsdtar ? [] : ["--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "--sort=name"];
  execFileSync("tar", ["-C", src, `--format=${bsdtar && format === "gnu" ? "gnutar" : format}`, ...fixed, "-cf", out, ...members], { env: { ...process.env, LC_ALL: "C" } });
  if (process.env.SOVA_TAR_FIXTURES_WRITE === "1") {
    mkdirSync(FIXTURES, { recursive: true });
    copyFileSync(out, join(FIXTURES, name));
  }
  return out;
}

test("this host's tar writes ustar, pax and GNU archives (and a hard link) that read as the committed ones do", async () => {
  await checkFormat("ustar", pack("ustar.tar", "ustar", "--exclude=proj/longlink", `--exclude=${longFile}`, "proj"));
  await checkFormat("pax", pack("pax.tar", "pax", "proj"));
  await checkFormat("gnu", pack("gnu.tar", "gnu", "proj"));
  pack("other-pax.tar", "pax", "other.txt");
  execFileSync("ln", [join(src, "proj", "a.txt"), join(src, "proj", "hard")]);
  try {
    await checkHardLink(pack("hard.tar", "gnu", "proj/a.txt", "proj/hard"));
  } finally {
    rmSync(join(src, "proj", "hard"));
  }
});
