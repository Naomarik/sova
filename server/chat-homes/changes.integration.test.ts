// Run: pnpm test:int server/chat-homes/changes.integration.test.ts
// The homes' change log under real concurrency (server/chat-homes/changes.ts): two writer processes and a compactor
// lose no line.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ChangeTail, segments, setChangeLogLimitsForTest, writeIndex, type ChangeLine } from "./changes";

const scratch = mkdtempSync(join(tmpdir(), "sova-home-changes-int-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const freshRoot = (): string => {
  const r = join(scratch, "homes");
  mkdirSync(r, { recursive: true });
  return r;
};

test("two writers and a compactor: every line of both is read, across rolls and removed segments", async () => {
  const root = freshRoot();
  setChangeLogLimitsForTest({ segmentBytes: 1024, graceMs: 0 });
  after(() => setChangeLogLimitsForTest({ segmentBytes: 1 << 20, graceMs: 10 * 60_000 }));
  const K = 400;
  const script = join(scratch, "writer.ts");
  writeFileSync(
    script,
    `import { appendChange, setChangeLogLimitsForTest } from ${JSON.stringify(join(import.meta.dirname, "changes.ts"))};\n` +
      `setChangeLogLimitsForTest({ segmentBytes: 1024, graceMs: 0 });\n` +
      `for (let i = 0; i < ${K}; i++) { appendChange(process.argv[2], "w" + process.argv[3], "meta"); if (i % 25 === 0) await new Promise((r) => setTimeout(r, 1)); }\n`,
  );
  const tail = new ChangeTail(root);
  const seen: ChangeLine[] = [];
  const kids = [1, 2].map(
    (w) =>
      new Promise<number>((res, rej) => {
        const p = spawn(process.execPath, [script, root, String(w)], { stdio: ["ignore", "ignore", "inherit"] });
        p.on("error", rej);
        p.on("exit", (code) => res(code ?? -1));
      }),
  );
  let done = false;
  const all = Promise.all(kids).then((codes) => {
    done = true;
    return codes;
  });
  let compactions = 0;
  let gaps = 0;
  while (!done) {
    const r = tail.read();
    seen.push(...r.lines);
    if (r.gap) gaps++;
    // The compactor: an index covering what was read, then the segments it passed removed.
    writeIndex(root, { v: 1, cursor: tail.cursor, homes: {} });
    compactions++;
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.deepEqual(await all, [0, 0]);
  seen.push(...tail.read().lines);
  assert.ok(segments(root).length >= 1 && segments(root)[0]! > 1, "segments rolled and old ones were removed");
  assert.ok(compactions > 1);
  assert.equal(gaps, 0, "the reader was never behind the compactor");
  const byWriter = new Map<number, Set<number>>();
  for (const l of seen) {
    let s = byWriter.get(l.p);
    if (!s) byWriter.set(l.p, (s = new Set()));
    s.add(l.g);
  }
  assert.equal(byWriter.size, 2);
  for (const s of byWriter.values()) assert.equal(s.size, K, "every line of each writer was read");
});

