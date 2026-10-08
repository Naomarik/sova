// Run: pnpm test -- server/baton-inspect.test.ts. inspect_files' confinement (§app.baton/files):
// the person chatting steers the model, so every way out of their own files must be refused. The
// checks run in process; the allowed commands run for real (unconfined and in bwrap) in
// baton-inspect.integration.test.ts. Fixtures in the OS temp dir.
import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { checkCommand, InspectRefusal, runInspect, splitCommand } from "./baton-inspect";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-inspect-")));
after(() => rmSync(root, { recursive: true, force: true }));
// The session's view (links to its files), its neighbours (another session's view, the bytes
// folder) and a secret outside, as the store lays them out.
const store = join(root, "project-files", "p1");
const view = join(store, "sessions", "s-one");
const other = join(store, "sessions", "s-two");
mkdirSync(view, { recursive: true });
mkdirSync(other, { recursive: true });
writeFileSync(join(root, "secret.txt"), "TOP-SECRET\n");
writeFileSync(join(other, "theirs.json"), '{"secret": "THEIRS"}\n');
const put = (name: string, data: string | Buffer) => {
  const f = join(store, `f_${name.replace(/[^a-z]/g, "")}`);
  mkdirSync(f, { recursive: true });
  writeFileSync(join(f, name), data);
  linkSync(join(f, name), join(view, name));
};
put("dump.json", JSON.stringify({ exportedAt: "2026-10-01", records: [{ id: 1, at: "2026-09-30" }, { id: 2, at: "2026-09-12" }, { id: 3, at: "2026-08-02" }] }));
put("big.txt", "x".repeat(30_000));
// The archives the checks name: only their presence matters here (the real ones, whose members
// try to leave, are baton-inspect.integration.test.ts's).
put("site.zip", "PK\x05\x06" + "\0".repeat(18));
put("old.tar", "\0".repeat(1024));
// A link planted in the view (never there in practice: the store only hard-links) must not lead out.
symlinkSync(join(root, "secret.txt"), join(view, "planted"));

describe("the command line is split without a shell", () => {
  test("words, quotes and pipes", () => {
    assert.deepEqual(splitCommand(`jq '.records | length' "my file.json"`), [["jq", ".records | length", "my file.json"]]);
    assert.deepEqual(splitCommand("cat a.json | jq . | head -n 3"), [["cat", "a.json"], ["jq", "."], ["head", "-n", "3"]]);
    assert.deepEqual(splitCommand("cat my\\ file"), [["cat", "my file"]]);
  });
  test("every other shell character is refused", () => {
    for (const bad of ["cat x; ls", "cat x && ls", "cat x || ls", "cat x > y", "cat < x", "cat $(id)", "cat `id`", "cat x &", "(ls)", "cat x\nls", "ls |", "| ls", "a | b | c | d | e", "cat 'x", "{ ls; }"])
      assert.throws(() => splitCommand(bad), InspectRefusal, bad);
  });
});

describe("the checks refuse every way out", () => {
  const refused = [
    // absolute paths, .., /proc, other sessions, the bytes folder
    "cat /etc/passwd",
    "cat ../s-two/theirs.json",
    "cat ../../../../../etc/passwd",
    "cat ../../f_dumpjson/dump.json",
    "ls /",
    "ls ..",
    "ls -d /",
    "cat /proc/self/environ",
    "head -n 1 /etc/passwd",
    "wc -l ../../../secret.txt",
    "cat -- ../s-two/theirs.json",
    "cat planted",
    // option injection that reads another file, writes one, or runs a program
    "grep -r root /",
    "grep -r TOP ..",
    "grep -f /etc/passwd dump.json",
    "grep --file=/etc/passwd dump.json",
    "grep -d recurse x ..",
    "jq -f /etc/passwd dump.json",
    "jq --from-file /etc/passwd dump.json",
    "jq --rawfile a /etc/passwd . dump.json",
    "jq --slurpfile a ../s-two/theirs.json . dump.json",
    "jq -L / . dump.json",
    `jq 'import "a" as $a; .' dump.json`,
    `jq 'include "x"; .' dump.json`,
    "jq --args . dump.json",
    "sort -o out.txt dump.json",
    "sort --output=out.txt dump.json",
    "sort -T /tmp dump.json",
    "sort --compress-program=sh dump.json",
    "sort --files0-from=dump.json",
    "uniq dump.json out.txt",
    "file -m /etc/magic dump.json",
    "file -f dump.json",
    "tail -f dump.json",
    // archives: never extracted to disk, never an option after the archive
    "unzip site.zip",
    "unzip -d /tmp site.zip",
    "unzip -o site.zip",
    "unzip -p site.zip -d /tmp",
    "unzip -l /etc/passwd",
    "tar -xf old.tar",
    "tar xf old.tar",
    "tar -tf /etc/passwd",
    "tar -tf old.tar --to-command=sh",
    "tar -xOf old.tar -C /",
    "tar --use-compress-program=sh -tf old.tar",
    "tar -tf host:/etc/passwd",
    // commands that are not allowed at all
    "sh -c id",
    "bash",
    "find .",
    "cp dump.json x",
    "env",
    "python3 -c 1",
    "cat dump.json | sh",
    "nonexistent.json",
  ];
  for (const cmd of refused)
    test(cmd, () => {
      assert.throws(() => checkCommand(cmd, view), InspectRefusal);
    });
});

test("cat of an image, for a model that sees images, answers it as an image without running anything", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  writeFileSync(join(view, "shot.png"), png);
  const seen = await runInspect(view, "cat shot.png", { seesImages: true, bwrap: null });
  assert.equal(seen.image?.mimeType, "image/png");
});
