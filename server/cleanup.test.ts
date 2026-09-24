import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { idOf, isZeroInput } from "./sessions-index";

const ID = "01234567-89ab-7cde-8f01-234567890abc";

const header = JSON.stringify({
  type: "session",
  version: 3,
  id: ID,
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "/tmp",
});
const modelChange = JSON.stringify({
  type: "model_change",
  id: "c1",
  parentId: null,
  timestamp: "2026-01-01T00:00:01.000Z",
  provider: "p",
  modelId: "m",
});
const userMsg = (text: string) =>
  JSON.stringify({
    type: "message",
    id: "m1",
    parentId: "c1",
    timestamp: "2026-01-01T00:00:02.000Z",
    message: { role: "user", content: text },
  });

/** A session file fixture in a fresh temp dir; returns its path. */
function fixture(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "sova-cleanup-"));
  const path = join(dir, `2026-01-01T00-00-00-000Z_${ID}.jsonl`);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

const clean = (path: string) => rmSync(dirname(path), { recursive: true, force: true });

test("isZeroInput: header-only and model-change-only files are husks", async () => {
  const a = fixture([header]);
  assert.equal(await isZeroInput(a, statSync(a).size), true);
  clean(a);
  const b = fixture([header, modelChange, modelChange]);
  assert.equal(await isZeroInput(b, statSync(b).size), true);
  clean(b);
});

test("isZeroInput: any user message disqualifies, even with empty text", async () => {
  const a = fixture([header, modelChange, userMsg("hello")]);
  assert.equal(await isZeroInput(a, statSync(a).size), false);
  clean(a);
  const b = fixture([header, userMsg("")]);
  assert.equal(await isZeroInput(b, statSync(b).size), false);
  clean(b);
});

test("isZeroInput: never guessed from an oversized (head-capped) file", async () => {
  const a = fixture([header]); // tiny on disk, but the caller reports it over the read cap
  assert.equal(await isZeroInput(a, 256 * 1024 + 1), false);
  clean(a);
});

test("idOf: the uuidv7 after the last underscore, .jsonl stripped", () => {
  assert.equal(
    idOf(`/x/--tmp--/2026-01-01T00-00-00-000Z_${ID}.jsonl`),
    ID,
  );
});
