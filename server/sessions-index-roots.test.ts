// Run: pnpm exec tsx --test server/sessions-index-roots.test.ts. Regression: with no sessions dir
// at all, the extra session roots (attached orgs' workspace sessions/) are still listed.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-roots-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent"); // never created: no sessions dir
const { setExtraSessionRoots } = await import("./paths");
const { listSessionFiles } = await import("./sessions-index");
after(() => rmSync(root, { recursive: true, force: true }));

test("no sessions dir + one extra root: the root's .jsonl files are listed, nothing nested", async () => {
  const extra = join(root, "ws", "sessions");
  mkdirSync(join(extra, "nested"), { recursive: true });
  const file = join(extra, "2026-09-26T00-00-00-000Z_01a0dd00-0000-7000-8000-000000000009.jsonl");
  writeFileSync(file, "{}\n");
  writeFileSync(join(extra, "nested", "x.jsonl"), "{}\n");
  writeFileSync(join(extra, "notes.txt"), "");
  setExtraSessionRoots(() => [extra]);
  assert.deepEqual(await listSessionFiles(), [file]);
});
