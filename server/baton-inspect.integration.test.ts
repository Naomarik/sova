// Run: pnpm exec tsx --test server/baton-inspect.integration.test.ts. inspect_files' commands run
// for real (§app.baton/files): the allowed commands work on a JSON, a zip and a tar, and nothing
// leaves the person's folder. Runs each case unconfined (the checks alone) and, where bwrap works
// here, inside it too. Fixtures (python3 builds the archives) in the OS temp dir. The checks
// themselves are baton-inspect.test.ts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { runInspect, workingBwrap } from "./baton-inspect";

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
// A zip and a tar whose members try to leave: "../evil", an absolute path, a symlink member.
const py = (code: string) => execFileSync("python3", ["-c", code], { cwd: view });
py(`
import zipfile
with zipfile.ZipFile("site.zip", "w") as z:
    z.writestr("src/app.js", "console.log('hi')\\n")
    z.writestr("../evil.txt", "ESCAPED\\n")
    z.writestr("/tmp/abs-evil.txt", "ABS\\n")
    info = zipfile.ZipInfo("link-out")
    info.external_attr = 0o120777 << 16
    z.writestr(info, "/etc/passwd")
`);
py(`
import tarfile, io
with tarfile.open("old.tar", "w") as t:
    for name, data in [("/tmp/sova-inspect-abs-evil", b"ABS\\n"), ("../up-evil", b"UP\\n"), ("notes.txt", b"inside\\n")]:
        i = tarfile.TarInfo(name); i.size = len(data); t.addfile(i, io.BytesIO(data))
`);
// A link planted in the view (never there in practice: the store only hard-links) must not lead out.
symlinkSync(join(root, "secret.txt"), join(view, "planted"));

const bw = workingBwrap();
const modes: [string, string | null][] = [["unconfined", null], ...(bw ? [["bwrap", bw] as [string, string]] : [])];

for (const [mode, bwrap] of modes)
  describe(`running (${mode})`, () => {
    const run = (cmd: string, o: { seesImages?: boolean; timeoutMs?: number } = {}) => runInspect(view, cmd, { ...o, bwrap });
    test("ls, file, wc, head, jq, grep, sort | uniq work on the person's JSON", async () => {
      assert.match((await run("ls")).text, /dump\.json/);
      assert.match((await run("file dump.json")).text, /JSON/);
      assert.match((await run("wc -c dump.json")).text, /\d+ dump\.json/);
      assert.equal((await run("jq '.records | length' dump.json")).text, "3");
      assert.equal((await run("jq -r '[.records[].at] | max' dump.json")).text, "2026-09-30");
      assert.equal((await run("grep -c exportedAt dump.json")).text, "1");
      assert.equal((await run("jq -r '.records[].id' dump.json | sort -n | head -n 1")).text, "1");
      assert.equal((await run("cat dump.json | jq -c '.records[0]'")).text, '{"id":1,"at":"2026-09-30"}');
    });
    test("unzip -l lists, unzip -p prints a member; nothing is extracted, an escaping member included", async () => {
      const list = (await run("unzip -l site.zip")).text;
      assert.match(list, /src\/app\.js/);
      assert.equal((await run("unzip -p site.zip src/app.js")).text, "console.log('hi')");
      await run("unzip -p site.zip");
      assert.equal(existsSync(join(root, "project-files", "p1", "sessions", "evil.txt")), false);
      assert.equal(existsSync("/tmp/abs-evil.txt"), false);
      assert.equal(existsSync(join(view, "src")), false);
    });
    test("tar -tf lists, tar -xOf prints members to the output: an absolute or ../ member never lands", async () => {
      assert.match((await run("tar -tf old.tar")).text, /notes\.txt/);
      const out = (await run("tar -xOf old.tar")).text;
      assert.match(out, /inside/);
      assert.equal(existsSync("/tmp/sova-inspect-abs-evil"), false);
      assert.equal(existsSync(join(store, "sessions", "up-evil")), false);
    });
    test("grep -r stays in the folder: the secret beside it is never found", async () => {
      const out = (await run("grep -r -l TOP")).text;
      assert.doesNotMatch(out, /secret/);
      assert.doesNotMatch((await run("grep -r -c THEIRS .")).text, /theirs/);
    });
    test("output is cut at 20,000 characters, marked; a slow command stops at its time", async () => {
      const big = await run("cat big.txt");
      assert.match(big.text, /\[Output cut at 20,000 characters\.\]$/);
      assert.ok(big.text.length < 20_200);
      const t0 = Date.now();
      const slow = await run("jq -n 'last(range(1e12))'", { timeoutMs: 300 });
      assert.match(slow.text, /\[Stopped after 0 seconds\.\]/);
      assert.ok(Date.now() - t0 < 5000, "stopped, not waited out");
      const binary = await run("cat site.zip");
      assert.match(binary.text, /binary output/);
    });
    test("a command's own failure is reported, not thrown", async () => {
      assert.match((await run("jq '.nope | keys' dump.json")).text, /\[exit 5\]|\[stderr\]/);
    });
  });

test("cat of an image answers it as an image only for a model that sees images", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  writeFileSync(join(view, "shot.png"), png);
  const seen = await runInspect(view, "cat shot.png", { seesImages: true, bwrap: null });
  assert.equal(seen.image?.mimeType, "image/png");
  const blind = await runInspect(view, "cat shot.png", { seesImages: false, bwrap: null });
  assert.equal(blind.image, undefined);
  assert.match(blind.text, /binary output/);
});
