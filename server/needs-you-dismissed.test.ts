// The dismiss store (§app.session-list/needs-you-dismiss): `<stateRoot>/needs-you-dismissed.json`.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "sova-needs-you-dismissed-test-"));
process.env.PI_CODING_AGENT_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const store = await import("./needs-you-dismissed");
let n = 0;
const fresh = () => join(dir, `d${++n}`, "needs-you-dismissed.json");

describe("the store", () => {
  test("it persists: a fresh read of the file says the same, and the write leaves no temp file behind", () => {
    const file = fresh();
    store.dismissChat("/s/a.jsonl", 100, 500, file);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { "/s/a.jsonl": { since: 100, at: 500 } });
    assert.deepEqual(readdirSync(join(file, "..")), ["needs-you-dismissed.json"]);
    assert.deepEqual(store.readDismissed(file), { "/s/a.jsonl": { since: 100, at: 500 } });
  });

  test("a missing or unreadable file hides nothing, and a bad record is dropped", () => {
    assert.deepEqual(store.readDismissed(fresh()), {});
    const file = fresh();
    store.dismissChat("/s/x.jsonl", 1, 1, file);
    writeFileSync(file, "{not json");
    store.dismissChat("/s/y.jsonl", 2, 2, file);
    assert.deepEqual(Object.keys(store.readDismissed(file)), ["/s/y.jsonl"]);
    writeFileSync(file, JSON.stringify({ "/s/a.jsonl": { since: "soon", at: 1 }, "/s/b.jsonl": { since: 1, at: 2 }, "/s/c.jsonl": 7 }));
    store.endDismissals(["/s/none.jsonl"], file);
    assert.deepEqual(store.readDismissed(file), { "/s/b.jsonl": { since: 1, at: 2 } });
  });

  test("a second press never covers less", () => {
    const file = fresh();
    store.dismissChat("/s/a.jsonl", 100, 1, file);
    assert.equal(store.dismissChat("/s/a.jsonl", 50, 2, file).since, 100);
    assert.equal(store.dismissChat("/s/a.jsonl", 200, 3, file).since, 200);
  });

  test("Undo takes it out and tells the next check once, with what it covered; undoing nothing tells nothing", () => {
    const file = fresh();
    store.takeUndone();
    store.dismissChat("/s/a.jsonl", 100, 1, file);
    assert.equal(store.undoDismissal("/s/a.jsonl", file), true);
    assert.deepEqual(store.readDismissed(file), {});
    assert.deepEqual([...store.takeUndone()], [["/s/a.jsonl", 100]]);
    assert.deepEqual([...store.takeUndone()], []);
    assert.equal(store.undoDismissal("/s/a.jsonl", file), false);
    assert.deepEqual([...store.takeUndone()], []);
  });

  test("pruning: a session listed or with its file still there stays; one with its file gone goes", () => {
    const here = join(dir, "here.jsonl");
    writeFileSync(here, "");
    const data = { "/s/listed.jsonl": { since: 1, at: 1 }, [here]: { since: 1, at: 1 }, "/s/deleted.jsonl": { since: 1, at: 1 } };
    assert.equal(existsSync("/s/deleted.jsonl"), false);
    assert.deepEqual(store.prunable(data, new Set(["/s/listed.jsonl"])), ["/s/deleted.jsonl"]);
    const file = fresh();
    store.dismissChat("/s/deleted.jsonl", 1, 1, file);
    store.dismissChat("/s/kept.jsonl", 1, 1, file);
    store.endDismissals(["/s/deleted.jsonl"], file);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8"))), ["/s/kept.jsonl"]);
  });

  test("a baton wait read outside the digest: covered unless newer; an undismissed session's never", () => {
    const data = { "/s/a.jsonl": { since: 100, at: 1 } };
    assert.equal(store.waitDismissed("/s/a.jsonl", 100, data), true);
    assert.equal(store.waitDismissed("/s/a.jsonl", 101, data), false);
    assert.equal(store.waitDismissed("/s/b.jsonl", 1, data), false);
    assert.equal(store.waitDismissed(null, 1, data), false);
  });
});
