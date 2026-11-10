// Run: pnpm test -- src/lib/discard-branch.test.ts. Discard Branch…'s words: the confirm's list from the dry run (missing
// parts left out), its plain warning that nothing comes back, the toast's chat clause only when a chat was archived,
// and a partial stop's line naming what was done and what stayed.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DiscardBranchPreview, DiscardBranchResult } from "../../shared/merge-queue";
import { DISCARD_LINE, discardMenuLine, discardConfirmWords, discardDoneToast, discardFileCount, discardPartialLine } from "./discard-branch";

const files = (uncommitted: string[], extra: Partial<{ ignored: string[]; nested: number }> = {}) => ({
  uncommitted,
  ignored: extra.ignored ?? [],
  nested: [],
  rebuildable: ["node_modules/"],
  counts: { uncommitted: uncommitted.length, ignored: extra.ignored?.length ?? 0, nested: extra.nested ?? 0, rebuildable: 1 },
  digest: "f1",
});
const preview = (o: Partial<DiscardBranchPreview> = {}): DiscardBranchPreview => ({
  branch: "feat/x",
  commit: "abc1234",
  target: "master",
  commits: { count: 3, shown: [] },
  folder: "/w/sova-x",
  files: files(["src/a.ts", "notes.md"]),
  drafts: ["discard-branch"],
  chat: { id: "s1", title: "Discard work", path: "/s/1.jsonl" },
  digest: "d1",
  refused: null,
  ...o,
});
type Step = DiscardBranchResult["steps"][number];
const steps = (folder: Step["state"], branch: Step["state"], chat: Step["state"], detail?: string): Step[] => [
  { step: "folder", state: folder, ...(folder === "failed" && detail ? { detail } : {}) },
  { step: "branch", state: branch, ...(branch === "failed" && detail ? { detail } : {}) },
  { step: "chat", state: chat, ...(chat === "failed" && detail ? { detail } : {}) },
];

test("the confirm lists every part the dry run found, in order, and says nothing comes back", () => {
  const w = discardConfirmWords(preview(), { folder: "~/w/sova-x" });
  assert.equal(w.title, "Discard feat/x?");
  assert.equal(w.confirm, "Discard Branch");
  assert.deepEqual(
    w.parts.map((p) => [p.key, p.code ? `${p.text} ${p.code}` : p.text]),
    [
      ["commits", "3 commits not on master"],
      ["files", "2 uncommitted files"],
      ["drafts", "1 spec draft"],
      ["folder", "Its folder, ~/w/sova-x"],
      ["chat", "Its chat, Discard work, archived"],
    ],
  );
  assert.equal(w.line, "No backup is kept: its 3 commits not on master can't be brought back.");
});

test("a missing part is left out, never listed as absent", () => {
  const w = discardConfirmWords(preview({ commits: { count: 0, shown: [] }, folder: null, files: null, drafts: [], chat: null }));
  assert.deepEqual(w.parts, []);
  assert.doesNotMatch(JSON.stringify(w), /No folder|No chat|\b0\b|undefined|null/);
  assert.equal(w.line, "Every commit is already on master. No backup is kept.");
  // Clean folder (not even a rebuildable one): the files part goes, the folder stays.
  const clean = { ...files([]), rebuildable: [], counts: { uncommitted: 0, ignored: 0, nested: 0, rebuildable: 0 } };
  assert.deepEqual(discardConfirmWords(preview({ files: clean })).parts.map((p) => p.key), ["commits", "drafts", "folder", "chat"]);
});

test("singulars, the chat you're in, and ignored and nested files counted with the uncommitted ones", () => {
  const w = discardConfirmWords(preview({ commits: { count: 1, shown: [] }, files: files(["a"]) }), { here: true });
  assert.equal(w.parts[0]!.text, "1 commit not on master");
  assert.equal(w.parts[1]!.text, "1 uncommitted file");
  assert.equal(w.parts.at(-1)!.text, "This chat, archived");
  assert.equal(w.line, "No backup is kept: its commit not on master can't be brought back.");
  assert.equal(discardFileCount(preview({ files: files(["a"], { ignored: [".env"], nested: 2 }) })), 4);
  // Each kind in its own words: an ignored file isn't uncommitted, a nested repository isn't a file.
  assert.deepEqual(
    discardConfirmWords(preview({ files: files(["a"], { ignored: [".env", "local.env"], nested: 1 }) })).parts.filter((p) => p.key === "files").map((p) => p.text),
    ["1 uncommitted file", "2 ignored files", "1 nested repository"],
  );
  // Only rebuildable folders: no listing shows them, so the list names them.
  assert.deepEqual(discardConfirmWords(preview({ files: files([]) })).parts.filter((p) => p.key === "files").map((p) => p.text), ["Rebuildable files: node_modules/"]);
  assert.equal(discardFileCount(preview({ files: null })), 0);
});

test("the copy never promises a way back", () => {
  for (const p of [preview(), preview({ commits: { count: 0, shown: [] }, files: null })]) {
    const w = discardConfirmWords(p);
    assert.doesNotMatch(`${w.line} ${w.parts.map((x) => x.text).join(" ")}`, /restor|undo|recover|retired|pinned|\bkept\b(?<!No backup is kept)/i);
    assert.match(w.line, /No backup is kept/);
  }
});

test("the toast names the archived chat only when it was archived", () => {
  assert.equal(discardDoneToast("feat/x", steps("done", "done", "done")), "Discarded feat/x. Its chat is archived.");
  assert.equal(discardDoneToast("feat/x", steps("done", "done", "skipped")), "Discarded feat/x.");
  assert.equal(discardDoneToast("feat/x", steps("skipped", "done", "skipped")), "Discarded feat/x.");
});

test("a partial stop says what was done and what stayed, with the failed step's reason", () => {
  assert.equal(discardPartialLine(steps("done", "failed", "not-run", "Git refused: it's checked out elsewhere.")), "Removed its folder. The branch and its chat stayed: Git refused: it's checked out elsewhere.");
  assert.equal(discardPartialLine(steps("done", "done", "failed", "The chat is open in a TUI")), "Removed its folder and deleted the branch. Its chat stayed: The chat is open in a TUI.");
  assert.equal(discardPartialLine(steps("failed", "not-run", "not-run", "A file is busy.")), "Nothing was discarded. Its folder, the branch, and its chat stayed: A file is busy.");
  // A part the dry run didn't have names nothing, even when the stop left its step "not-run".
  assert.equal(discardPartialLine(steps("done", "failed", "not-run", "Another folder has this branch checked out."), { folder: true, chat: false }), "Removed its folder. The branch stayed: Another folder has this branch checked out.");
  // A skipped step (no folder) names nothing.
  assert.equal(discardPartialLine(steps("skipped", "done", "failed")), "Deleted the branch. Its chat stayed.");
});

test("the menu line promises only what the dry run found", () => {
  // Before the dry run answers, it promises no chat.
  assert.equal(discardMenuLine(undefined), "Deletes the branch and its folder.");
  assert.equal(discardMenuLine(preview()), DISCARD_LINE);
  assert.equal(discardMenuLine(preview()), "Deletes the branch and its folder, and archives its chat.");
  assert.equal(discardMenuLine(preview({ chat: null })), "Deletes the branch and its folder.");
  assert.equal(discardMenuLine(preview({ folder: null })), "Deletes the branch and archives its chat.");
  assert.equal(discardMenuLine(preview({ folder: null, chat: null })), "Deletes the branch.");
});
