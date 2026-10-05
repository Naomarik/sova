// Run: pnpm exec tsx --test server/session-share-view.test.ts. §app.session-share/slice: the pure
// slice (sliceBranch, shownEntries) and what the builder makes of it: slice-local items and images,
// the `earlier` flag, the operator's outline and a share's span. Session files in a throwaway temp
// dir, deleted after.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { SESSION_SHARE_EXCERPT_MAX } from "../shared/session-share";
import { branchTo, resetShareViewCache, sessionShareImage, sessionShareOutline, sessionShareView, shareSpan, shownEntries, sliceBranch, type ShareSource } from "./session-share-view";
import { historyOf, type PiFile } from "./harness/pi/reader";
import type { Entry } from "./transcript";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-share-view-")));
after(() => rmSync(root, { recursive: true, force: true }));

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const png = (tag: string) => Buffer.concat([PNG, Buffer.from(tag)]);

let t = 0;
const msg = (id: string, parentId: string | null, role: string, text: string, image?: Buffer): Entry =>
  ({
    type: "message",
    id,
    parentId,
    timestamp: new Date(Date.UTC(2026, 8, 30, 0, 0, ++t)).toISOString(),
    message: { role, content: [{ type: "text", text }, ...(image ? [{ type: "image", data: image.toString("base64"), mimeType: "image/png" }] : [])] },
  }) as Entry;
const wake = (id: string, parentId: string | null) => msg(id, parentId, "user", "[wake_nudge n1] Scheduled wakeup fired (set 4m ago).\nReason: x\nContinue.");
const tool = (id: string, parentId: string) => ({ type: "message", id, parentId, message: { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "out" }] } }) as Entry;

/** u1 (image A) · a1 · wake · u2 (image B) · a2 · tool · u3 · a3 (image C). */
const chain = (): Entry[] => [
  msg("u1", null, "user", "one", png("A")),
  msg("a1", "u1", "assistant", "reply one"),
  wake("w1", "a1"),
  msg("u2", "w1", "user", "two", png("B")),
  msg("a2", "u2", "assistant", "reply two"),
  tool("t2", "a2"),
  msg("u3", "t2", "user", "three"),
  msg("a3", "u3", "assistant", `reply three ${"long ".repeat(60)}`, png("C")),
];

function write(name: string, entries: Entry[]): string {
  const p = join(root, name);
  writeFileSync(p, `${[{ type: "session", version: 3, id: name, cwd: "/tmp/proj" }, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`);
  resetShareViewCache();
  return p;
}
const src = (sessionPath: string, cutEntryId: string | null, from: string | null): ShareSource => ({ sessionPath, cutEntryId, from, title: "T", sharedAt: "2026-09-30T01:00:00.000Z", mode: cutEntryId ? "snapshot" : "live" });
const ids = (es: readonly { id: unknown }[] | null) => es?.map((e) => e.id) ?? null;
/** The chain as the share view reads a file: no header, the entries as neutral history. */
const chainFile = (): PiFile => ({ header: null, entries: historyOf(chain()) });

describe("sliceBranch", () => {
  const branch = historyOf(chain());
  test("null start is the whole branch; a start is the suffix from it", () => {
    assert.equal(sliceBranch(branch, null), branch);
    assert.deepEqual(ids(sliceBranch(branch, "u1")), ids(branch), "at the root");
    assert.deepEqual(ids(sliceBranch(branch, "u2")), ["u2", "a2", "t2", "u3", "a3"], "in the middle");
    assert.deepEqual(ids(sliceBranch(branch, "a3")), ["a3"], "at the end");
  });
  test("start equal to end is one entry", () => {
    const toA2 = branchTo(chainFile(), "a2")!;
    assert.deepEqual(ids(sliceBranch(toA2, "a2")), ["a2"]);
  });
  test("a start off the branch, or after the cut, is null", () => {
    assert.equal(sliceBranch(branch, "nope"), null);
    assert.equal(sliceBranch(branchTo(chainFile(), "a2")!, "u3"), null, "after the cut");
  });
});

describe("shownEntries", () => {
  test("keeps user and reply messages; drops wake nudges and tool results, before any scrub", () => {
    assert.deepEqual(
      shownEntries(historyOf(chain())).map((s) => s.e.id),
      ["u1", "a1", "u2", "a2", "u3", "a3"],
    );
  });
});

describe("the builder on a slice", () => {
  const p = write("chain.jsonl", chain());

  test("items and image indices restart at 0; nothing before the start is reachable", async () => {
    const v = (await sessionShareView(src(p, null, "u2")))!;
    assert.deepEqual(v.items.map((i) => [i.n, i.text.slice(0, 11)]), [[0, "two"], [1, "reply two"], [2, "three"], [3, "reply three"]]);
    assert.deepEqual(v.items[0]!.images, [{ n: 0, mime: "image/png" }]);
    assert.deepEqual(v.items[3]!.images, [{ n: 1, mime: "image/png" }]);
    assert.equal(v.images, 2);
    assert.deepEqual((await sessionShareImage(src(p, null, "u2"), 0))!.bytes, png("B"));
    assert.deepEqual((await sessionShareImage(src(p, null, "u2"), 1))!.bytes, png("C"));
    assert.equal(await sessionShareImage(src(p, null, "u2"), 2), null);
  });

  test("a snapshot slice ends at its cut", async () => {
    const v = (await sessionShareView(src(p, "a2", "u2")))!;
    assert.deepEqual(v.items.map((i) => i.text), ["two", "reply two"]);
    assert.equal(v.images, 1);
  });

  test("a start off the branch or after the cut reads as gone", async () => {
    assert.equal(await sessionShareView(src(p, "a2", "u3")), null);
    assert.equal(await sessionShareView(src(p, null, "nope")), null);
  });

  test("earlier is set only when the slice dropped a shown message", async () => {
    assert.equal((await sessionShareView(src(p, null, null)))!.earlier, undefined, "whole session");
    assert.equal((await sessionShareView(src(p, null, "u1")))!.earlier, undefined, "from the first message");
    assert.equal((await sessionShareView(src(p, null, "u2")))!.earlier, true);
    // Only a wake nudge (never shown) before the start: nothing the recipient would have seen was dropped.
    const q = write("wake-first.jsonl", [wake("w0", null), msg("u1", "w0", "user", "one"), msg("a1", "u1", "assistant", "reply")]);
    const first = (await sessionShareView(src(q, null, "u1")))!;
    assert.equal(first.earlier, undefined, "a dropped wake nudge alone doesn't set it");
    assert.deepEqual(first.items.map((i) => i.text), ["one", "reply"]);
  });

  test("Follow live with a start: a rewind above the start takes it off the branch (gone)", async () => {
    const rewound = write("rewound.jsonl", [...chain(), msg("b1", "a1", "assistant", "another reply")]);
    assert.equal(await sessionShareView(src(rewound, null, "u2")), null);
    assert.ok(await sessionShareView(src(rewound, null, "a1")), "a start still on the branch reads");
  });
});

describe("the outline and the span", () => {
  const p = write("outline.jsonl", chain());

  test("the outline carries every shown item's id, in order, as short excerpts", async () => {
    const o = (await sessionShareOutline({ sessionPath: p, cutEntryId: "a3" }))!;
    assert.equal(o.cut, "a3");
    assert.deepEqual(o.items.map((i) => [i.id, i.n, i.kind, i.images]), [
      ["u1", 0, "user", 1],
      ["a1", 1, "reply", 0],
      ["u2", 2, "user", 1],
      ["a2", 3, "reply", 0],
      ["u3", 4, "user", 0],
      ["a3", 5, "reply", 1],
    ]);
    const long = o.items.at(-1)!.excerpt;
    assert.ok(long.length <= SESSION_SHARE_EXCERPT_MAX + 1 && long.endsWith("…"), long);
    assert.ok(o.items.every((i) => i.at));
    assert.equal(await sessionShareOutline({ sessionPath: p, cutEntryId: "nope" }), null);
  });

  test("span: 1-based among shown messages; last null while live; none for a whole session", async () => {
    assert.deepEqual(await shareSpan(src(p, "a2", "u2")), { first: 3, last: 4, total: 6 });
    assert.deepEqual(await shareSpan(src(p, null, "u2")), { first: 3, last: null, total: 6 });
    assert.equal(await shareSpan(src(p, "a2", null)), undefined);
    assert.equal(await shareSpan(src(p, "a2", "u3")), undefined, "a slice that no longer reads");
  });
});
