// The project page's branch read (§app.project-overseer/coding-worktrees, "Read in two steps"): adoption
// and the statechart's writes one at a time, the git reads side by side and bounded.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mapLimit, readCodingPass, WORKTREE_READS_AT_ONCE } from "./project-coding-read";

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

describe("the coding sessions' branch read", () => {
  test("two `later` builds adopt in turn: an adoption that yields mid-write never loses the other's", async () => {
    // The build records as one file: each adoption reads it, yields, then writes it back whole (a read-modify-write).
    let records: Record<string, { branch?: string }> = { a: {}, b: {} };
    const adopt = async (id: string) => {
      const before = { ...records };
      await tick();
      records = { ...before, [id]: { branch: `feat/${id}` } };
      return id;
    };
    const out = await readCodingPass(["a", "b"], {
      adopt,
      locate: async (id) => records[id]?.branch ?? null,
      read: async (branch) => `read ${branch}`,
      finish: async (id, located, reading) => ({ id, located, reading }),
    });
    assert.deepEqual(records, { a: { branch: "feat/a" }, b: { branch: "feat/b" } }, "both adoptions are kept");
    assert.deepEqual(out, [
      { id: "a", located: "feat/a", reading: "read feat/a" },
      { id: "b", located: "feat/b", reading: "read feat/b" },
    ]);
  });

  test("the git reads run side by side, never more than the limit; finish runs one at a time, in list order", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `s${i}`);
    let reading = 0;
    let most = 0;
    let finishing = 0;
    const finished: string[] = [];
    const out = await readCodingPass(ids, {
      adopt: async (id) => id,
      locate: async (id) => (id === "s3" ? null : id),
      read: async (id) => {
        most = Math.max(most, ++reading);
        // Later rows answer first: the order out must still be the list's.
        await new Promise((r) => setTimeout(r, 12 - Number(id.slice(1))));
        reading--;
        return id.toUpperCase();
      },
      finish: async (id, _l, w) => {
        assert.equal(finishing++, 0, "one finish at a time");
        await tick();
        finishing--;
        finished.push(id);
        return w;
      },
    });
    assert.equal(most, WORKTREE_READS_AT_ONCE, `at most ${WORKTREE_READS_AT_ONCE} reads at once, and that many used`);
    assert.deepEqual(finished, ids);
    assert.deepEqual(out, ids.map((id) => (id === "s3" ? null : id.toUpperCase())), "a row in the root is never read");
  });

  test("mapLimit keeps the input order and copes with fewer items than lanes, and none", async () => {
    assert.deepEqual(await mapLimit([3, 1, 2], 8, async (n) => n * 2), [6, 2, 4]);
    assert.deepEqual(await mapLimit([], 4, async (n: number) => n), []);
  });
});
