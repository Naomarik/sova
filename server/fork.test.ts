// Run: npx tsx --test server/fork.test.ts (or npm test). The rules of POST /api/sessions/fork,
// driven through fakes: no disk, no SDK. The SDK behaviour they stand on is pinned for real in
// server/fork-branch.test.ts, which is the half a fake can only agree with.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { ForkRequest, SessionSummary } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-fork-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
/** Real files in /tmp with pi's own clipboard name shape, so `available` is decided by
    checkTmpImage against the real disk rather than by a fake that could disagree with it. */
const madeFiles: string[] = [];
function clipboardFile(suffix: string, bytes: Buffer): string {
  const path = `/tmp/pi-clipboard-00000000-0000-0000-0000-0000000${suffix}.png`;
  writeFileSync(path, bytes);
  madeFiles.push(path);
  return path;
}
after(() => {
  for (const f of madeFiles) try { unlinkSync(f); } catch {}
  rmSync(agentDir, { recursive: true, force: true });
});

const { editorFor, findOnBranch, planFork, runFork } = await import("./fork");

const SOURCE = "/sessions/--tmp--/2026-09-22T00-00-00-000Z_01a0-src.jsonl";

const user = (id: string, parentId: string | null, content: unknown) => ({ type: "message", id, parentId, message: { role: "user", content } });
const text = (t: string) => [{ type: "text", text: t }];
const assistant = (id: string, parentId: string, t: string) => ({ type: "message", id, parentId, message: { role: "assistant", content: [{ type: "text", text: t }] } });

/** model_change → u1 → a1 → u2 → a2: an ordinary branch whose first entry is NOT a message. */
const branch = () => [
  { type: "model_change", id: "m0", parentId: null },
  user("u1", "m0", text("first ask")),
  assistant("a1", "u1", "first answer"),
  user("u2", "a1", text("second ask")),
  assistant("a2", "u2", "second answer"),
];

const summary = (path: string): SessionSummary =>
  ({ id: "child", path, title: "child", cwd: "/tmp", origin: "web" }) as unknown as SessionSummary;

function deps(over: Partial<Parameters<typeof runFork>[1]> = {}) {
  const branched: { path: string; leafId: string }[] = [];
  const discarded: string[] = [];
  const base = {
    resolveSource: (raw: string) => (raw === SOURCE ? SOURCE : null),
    sourceVersion: async () => 3,
    branch: async () => branch(),
    live: () => false,
    streaming: () => false,
    foreignWriter: () => false,
    misconfigured: () => false,
    async branchOff(path: string, leafId: string) {
      branched.push({ path, leafId });
      return `/sessions/--tmp--/child-${leafId}.jsonl`;
    },
    discard: (p: string) => void discarded.push(p),
    summary: async (p: string) => summary(p),
  };
  return { deps: { ...base, ...over } as Parameters<typeof runFork>[1], branched, discarded };
}

const req = (over: Partial<ForkRequest> = {}): ForkRequest => ({ path: SOURCE, entryId: "u2", position: "before", ...over });

describe("the fork request", () => {
  test("rejects a body it cannot act on", () => {
    assert.equal(planFork({} as ForkRequest).ok, false);
    assert.equal(planFork({ path: SOURCE, entryId: "", position: "at" }).ok, false);
    assert.equal(planFork({ path: SOURCE, entryId: "u1", position: "through" as never }).ok, false);
    assert.equal(planFork(req()).ok, true);
  });

  test("an unknown source is a 404, before anything else is read", async () => {
    const d = deps();
    const r = await runFork(req({ path: "/elsewhere.jsonl" }), d.deps);
    assert.equal(r.ok === false && r.status, 404);
    assert.deepEqual(d.branched, []);
  });
});

describe("what a fork refuses, and what it leaves behind", () => {
  const cases: [string, Partial<Parameters<typeof runFork>[1]>, string][] = [
    ["a TUI owns it", { live: () => true }, "tui-live"],
    ["it is mid-turn here", { streaming: () => true }, "mid-turn"],
    ["another process just wrote it", { foreignWriter: () => true }, "busy"],
    ["its cwd is gone", { misconfigured: () => true }, "config"],
    ["its file cannot be read", { sourceVersion: async () => null }, "missing"],
    ["it is in an older format", { sourceVersion: async () => 2 }, "old-format"],
  ];
  for (const [name, over, code] of cases) {
    test(`refuses when ${name} — and creates nothing`, async () => {
      const d = deps(over);
      const r = await runFork(req(), d.deps);
      assert.equal(r.ok, false);
      assert.equal(r.ok === false && r.status, 409);
      assert.equal(r.ok === false && "refused" in r && r.refused.code, code);
      assert.deepEqual(d.branched, [], "nothing was branched");
      assert.deepEqual(d.discarded, [], "and so there is nothing to roll back");
    });
  }

  test("the old-format refusal is a PRECONDITION, not a recovery", async () => {
    // SessionManager.open() MIGRATES an older file by rewriting it whole, and a runtime Sova
    // holds for that session would see the rewrite as a foreign write and lock the user out of
    // their own chat. So the version is checked before the source is opened, never after.
    const opened: string[] = [];
    const d = deps({ sourceVersion: async () => 2, branchOff: async (p: string) => { opened.push(p); return "x"; } });
    await runFork(req(), d.deps);
    assert.deepEqual(opened, []);
  });

  test("an entry that is not on the ACTIVE branch is refused", async () => {
    // After a rewind the file's tail is the abandoned branch, so this is an ordinary state. The
    // branch the deps return is the active one; anything else is simply not forkable from.
    const d = deps();
    const r = await runFork(req({ entryId: "abandoned-1" }), d.deps);
    assert.equal(r.ok === false && "refused" in r && r.refused.code, "not-on-branch");
    assert.deepEqual(d.branched, []);
  });

  test('"before" the very first entry is refused as nothing-before, not as an error', async () => {
    const d = deps({ branch: async () => [user("u1", null, text("only ask")), assistant("a1", "u1", "only answer")] });
    const r = await runFork(req({ entryId: "u1", position: "before" }), d.deps);
    assert.equal(r.ok === false && "refused" in r && r.refused.code, "nothing-before");
    assert.deepEqual(d.branched, []);
  });

  test("a failure AFTER the child exists unlinks it", async () => {
    // A header with no session behind it is a sidebar row that opens onto nothing.
    const d = deps({ summary: async () => null });
    const r = await runFork(req(), d.deps);
    assert.equal(r.ok === false && r.status, 500);
    assert.deepEqual(d.discarded, ["/sessions/--tmp--/child-a1.jsonl"], "its own debris, and only its own");
  });
});

describe("where a fork branches", () => {
  test('"before" a user entry branches through its PARENT', async () => {
    const d = deps();
    const r = await runFork(req({ entryId: "u2", position: "before" }), d.deps);
    assert.equal(r.ok, true);
    assert.deepEqual(d.branched, [{ path: SOURCE, leafId: "a1" }], "pi's /fork: everything up to the reply before it");
  });

  test('"at" an entry branches through the entry ITSELF', async () => {
    const d = deps();
    const r = await runFork(req({ entryId: "a2", position: "at" }), d.deps);
    assert.equal(r.ok, true);
    assert.deepEqual(d.branched, [{ path: SOURCE, leafId: "a2" }], "pi's /clone: everything through that reply");
  });

  test("a BLOCK id resolves to its entry", async () => {
    const d = deps();
    const r = await runFork(req({ entryId: "a2:1", position: "at" }), d.deps);
    assert.equal(r.ok, true);
    assert.deepEqual(d.branched, [{ path: SOURCE, leafId: "a2" }]);
  });

  test("findOnBranch never lets a suffix strip turn one entry into another", () => {
    const b = branch();
    assert.equal(findOnBranch(b, "u2")?.entry.id, "u2");
    assert.equal(findOnBranch(b, "u2:0")?.entry.id, "u2");
    assert.equal(findOnBranch(b, "ghost:0"), null);
    // An id that IS on the branch is found whole, before any stripping is attempted.
    const withColon = [{ type: "message", id: "weird:id", parentId: null, message: { role: "user", content: text("x") } }];
    assert.equal(findOnBranch(withColon, "weird:id")?.entry.id, "weird:id");
  });
});

describe("what the new composer starts with", () => {
  test('"before" a user entry hands back its text', async () => {
    const d = deps();
    const r = await runFork(req({ entryId: "u2", position: "before" }), d.deps);
    assert.equal(r.ok && r.result.editor?.text, "second ask");
  });

  test('"at" hands back nothing: the message is IN the child, not waiting to be sent', async () => {
    const d = deps();
    const r = await runFork(req({ entryId: "u2", position: "at" }), d.deps);
    assert.equal(r.ok && r.result.editor, undefined);
  });

  test('"before" an ASSISTANT entry hands back nothing', async () => {
    const d = deps();
    const r = await runFork(req({ entryId: "a2", position: "before" }), d.deps);
    assert.equal(r.ok && r.result.editor, undefined);
  });

  test("stored images come back as data URLs — the difference from a rewind", () => {
    // `rewound` hands text only, matching pi's /tree. A fork hands the whole message, because the
    // point is to send it again from somewhere else: images that vanished on the way would make
    // the new prompt a different prompt, silently.
    const editor = editorFor(
      user("u1", null, [
        { type: "text", text: "compare these" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "image", data: "BBBB", mimeType: "image/jpeg" },
      ]),
    );
    assert.equal(editor?.text, "compare these");
    assert.deepEqual(editor?.images, ["data:image/png;base64,AAAA", "data:image/jpeg;base64,BBBB"]);
  });

  test("an image-only message still produces an editor payload", () => {
    const editor = editorFor(user("u1", null, [{ type: "image", data: "AAAA", mimeType: "image/png" }]));
    assert.equal(editor?.text, undefined);
    assert.deepEqual(editor?.images, ["data:image/png;base64,AAAA"]);
  });

  test("clipboard paths become attachments and leave the text, as the transcript does it", () => {
    // The composer writes the paths back on send, so handing over the raw text AS WELL as the
    // chips would send every path twice.
    const path = "/tmp/pi-clipboard-00000000-0000-0000-0000-000000000000.png";
    const editor = editorFor(user("u1", null, text(`look at ${path} please`)));
    assert.equal(editor?.text, "look at please");
    assert.deepEqual(editor?.attachments?.map((a) => a.path), [path]);
    assert.equal(editor?.attachments?.[0]?.available, false, "the file is gone; the chip says so rather than lying");
  });

  test("a path the user TYPED about is left in the text", () => {
    // Only pi's own clipboard names are stripped; anything else is something the user wrote and
    // meant, and removing it would change the message.
    const editor = editorFor(user("u1", null, text("open /tmp/screenshot.png for me")));
    assert.match(editor?.text ?? "", /\/tmp\/screenshot\.png/);
  });

  test("a stored image whose file is STILL THERE travels as the file, not twice", () => {
    // The duplicate half of the partition: staging the file AND re-uploading the same bytes
    // attaches one image twice. Told apart by content hash, so it does not rest on an assumption
    // that a message never carries both a path and its own bytes.
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const path = clipboardFile("00aaaa", png); // really on disk, so `available` is really true
    const entry = user("u1", null, [
      { type: "text", text: `look at ${path}` },
      { type: "image", data: png.toString("base64"), mimeType: "image/png" },
    ]);
    const editor = editorFor(entry);
    assert.equal(editor?.attachments?.[0]?.available, true, "precondition: the file really is readable");
    assert.deepEqual(editor?.attachments?.map((a) => a.path), [path], "the file is the carrier");
    assert.equal(editor?.images, undefined, "and its bytes are NOT sent again");
  });

  test("a stored image whose file is GONE travels as bytes, so it is not lost", () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const path = "/tmp/pi-clipboard-00000000-0000-0000-0000-00000000bbbb.png"; // never created
    const entry = user("u1", null, [
      { type: "text", text: `look at ${path}` },
      { type: "image", data: png.toString("base64"), mimeType: "image/png" },
    ]);
    const editor = editorFor(entry);
    assert.equal(editor?.images?.length, 1, "the bytes come along instead");
    assert.equal(editor?.attachments?.[0]?.available, false, "and the dead path is still reported");
  });

  test("a DIFFERENT stored image alongside a live attachment sends both, once each", () => {
    const onDisk = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const inline = Buffer.from("ffd8ffe000104a464946", "hex");
    const path = clipboardFile("00cccc", onDisk);
    const entry = user("u1", null, [
      { type: "text", text: `look at ${path}` },
      { type: "image", data: inline.toString("base64"), mimeType: "image/jpeg" },
    ]);
    const editor = editorFor(entry);
    assert.deepEqual(editor?.attachments?.map((a) => a.path), [path]);
    assert.equal(editor?.images?.length, 1, "the unrelated inline image still travels");
    assert.ok(editor?.images?.[0]?.startsWith("data:image/jpeg;base64,"));
  });

  test("an image that can travel by NEITHER channel is still reported, never dropped", () => {
    // A clipboard path with no stored bytes and no file: nothing can carry it. Keeping the entry
    // is what lets the client say so; filtering it would make the omission invisible on both sides.
    const path = "/tmp/pi-clipboard-00000000-0000-0000-0000-00000000dddd.png";
    const editor = editorFor(user("u1", null, text(`look at ${path} please`)));
    assert.equal(editor?.images, undefined, "no bytes exist for it");
    assert.deepEqual(editor?.attachments?.map((a) => [a.path, a.available]), [[path, false]]);
  });

  test("a non-user entry has no editor payload at all", () => {
    assert.equal(editorFor(assistant("a1", "u1", "hi")), undefined);
    assert.equal(editorFor({ type: "model_change", id: "m0", parentId: null }), undefined);
  });
});
