// The real reader child over a stand-in program file: a copy of real rows, never a Claude Code.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readClaudeTableInChild } from "./claude-table";

const dir = mkdtempSync(join(tmpdir(), "claude-table-child-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "../pi-config/extensions/claude-code/tests/fixtures/claude-tables/2.1.321.json"), "utf8")) as { rows: string[]; latestPerFamily: string };

test("the child reads a file's table and answers in one line", async () => {
  const file = join(dir, "good");
  writeFileSync(file, `x;[${fixture.rows.join(",")}];y={latest_per_family:${fixture.latestPerFamily}};`);
  const result = await readClaudeTableInChild(file);
  assert.ok(result.ok);
  assert.equal(result.table.rows.length, 24);
  assert.equal(result.table.latest.fable, "claude-fable-5-2");
});

test("the child answers no data for a file with no table, or none at all", async () => {
  const file = join(dir, "bad");
  writeFileSync(file, "#!/bin/sh\necho claude\n");
  assert.deepEqual(await readClaudeTableInChild(file), { ok: false, reason: "no model rows found" });
  assert.equal((await readClaudeTableInChild(join(dir, "missing"))).ok, false);
});
