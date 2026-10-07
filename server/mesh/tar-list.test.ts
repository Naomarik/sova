// Run: pnpm test -- server/mesh/tar-list.test.ts
// The pre-scan's header reader against committed archives (server/fixtures/tar-list/, written by
// GNU tar: ustar, pax and GNU long names, links), concatenated archives, and a truncated one. That
// the host's own tar still writes what these hold: tar-list.integration.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { checkFormat, checkHardLink, expectedNames, FIXTURES, list, longFile } from "./tar-list-test-fixtures";

const fixture = (name: string) => join(FIXTURES, name);

describe("tarMembers", () => {
  for (const format of ["ustar", "pax", "gnu"]) {
    test(`${format}: names, types, sizes and link targets`, async () => {
      await checkFormat(format, fixture(`${format}.tar`));
    });
  }

  test("a hard link names its target", async () => {
    await checkHardLink(fixture("hard.tar"));
  });

  test("concatenated archives read as one (as --ignore-zeros extracts them)", async () => {
    const both = Buffer.concat([readFileSync(fixture("gnu.tar")), readFileSync(fixture("other-pax.tar"))]);
    const got = await list(both);
    assert.deepEqual(got.map((m) => m.name).sort(), [...expectedNames, "other.txt"].sort());
  });

  test("a truncated archive throws", async () => {
    const whole = readFileSync(fixture("gnu.tar"));
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
