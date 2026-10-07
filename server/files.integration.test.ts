// execBounded itself — a real subprocess, because a stubbed exec proves none of this. The project
// file index's rules, over fake filesystems and execs, are in files.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { execBounded } from "./files";

const node = process.execPath;

test("execBounded decodes one character split across two stdout chunks", async () => {
  // "…" is 3 bytes; the child writes the first byte of it in one chunk and the rest in another,
  // which is what a decode-per-chunk implementation turns into replacement characters.
  const src = `const b = Buffer.from("a…b", "utf8");
    process.stdout.write(b.subarray(0, 2));
    setTimeout(() => process.stdout.write(b.subarray(2)), 30);`;
  const r = await execBounded([node, "-e", src], { timeoutMs: 30_000, byteCap: 1024 });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "a…b");
  assert.equal(r.truncated, false);
});

test("execBounded caps stdout by bytes before storing it, and says so", async () => {
  const r = await execBounded([node, "-e", `process.stdout.write("x".repeat(200_000))`], { timeoutMs: 30_000, byteCap: 1_000 });
  assert.equal(Buffer.byteLength(r.stdout), 1_000, "exactly the cap was kept — the over-limit chunk was never stored whole");
  assert.equal(r.truncated, true);
});

test("execBounded kills a child that outruns its timeout and rejects", async () => {
  // The child would idle for 30 s and then exit 0: a "timed out" rejection is its timeout's answer.
  await assert.rejects(
    execBounded([node, "-e", "setTimeout(() => {}, 30_000)"], { timeoutMs: 150, byteCap: 1024 }),
    /timed out/,
  );
});

test("execBounded rejects when the binary isn't there", async () => {
  await assert.rejects(execBounded(["definitely-not-a-binary-xyz"], { timeoutMs: 1_000, byteCap: 16 }));
});
