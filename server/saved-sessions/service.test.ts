import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { CONTINUATION_NOTE_TYPE, ROOT_TOKEN, SAVED_SESSION_MARKER, SAVED_SESSIONS_REF, type SavedSessionCard } from "../../shared/session-bundle";
import { appendToClosedFile } from "../harness/pi/state";
import { scratchRoot } from "../test-scratch";
import { commitChange, localGit, readPath } from "./git";
import { continueInto, decideRev, listSaved, onMain, parseCard, prepareSave, preview, prune, purgeFromMain, removeFromMain, save, savedForSession, type SessionHooks } from "./service";
import { seenRevs } from "./store";
import { SAVED_SESSION_MARKER as EXTENSION_MARKER } from "../../pi-config/extensions/worktrees/saved-sessions.ts";

test("the worktree extension's marker is Sova's", () => {
  assert.equal(EXTENSION_MARKER, SAVED_SESSION_MARKER);
});

const root = scratchRoot("saved-service-");
after(() => rmSync(root, { recursive: true, force: true }));

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();

function repo(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "master");
  sh(dir, "config", "user.name", "Ada");
  sh(dir, "config", "user.email", "ada@example.invalid");
  sh(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  sh(dir, "add", "a.ts");
  sh(dir, "commit", "-q", "-m", "one");
  sh(dir, "checkout", "-q", "-b", "feat/x");
  return dir;
}

const T = "2026-01-01T00:00:00.000Z";
let n = 0;
function session(cwd: string, entries: Record<string, unknown>[]): string {
  const dir = join(root, "sessions");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `s${++n}.jsonl`);
  const lines = [{ type: "session", version: 3, id: `0190000${n}-0000-7000-8000-000000000000`, timestamp: T, cwd }, ...entries.map((e, i) => ({ timestamp: T, ...e, parentId: i === 0 ? null : entries[i - 1]!.id }))];
  writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return p;
}

/** A fake high-entropy token, built at run time so no literal key sits in the source (the leak scan). */
const TOKEN = ["Xk3vQ9pLm2", "Rt8Zw4Yb7N", "c1Hd6Fj0Ga5S"].join("");
const IMG = Buffer.from("png bytes").toString("base64");
const conversation = (top: string) => [
  { type: "model_change", id: "m1", provider: "zai", modelId: "glm-5.3" },
  { type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: `fix ${top}/a.ts, token ${TOKEN}` }, { type: "image", data: IMG, mimeType: "image/png" }], timestamp: 1 } },
  { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "Done: edited a.ts." }], provider: "zai", model: "glm-5.3", api: "x", stopReason: "stop", timestamp: 2, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
];

const titles = new Map<string, string>();
/** Hooks with no chats: state goes to the closed file, models are what the test says. */
const hooks = (models: { ref: string; window: number | null }[] = [{ ref: "zai/glm-5.3", window: 200_000 }], def: string | null = "anthropic/claude-x"): SessionHooks => ({
  liveElsewhere: () => false,
  appendState: async (path, kind, data) => {
    appendToClosedFile(path, kind, data);
  },
  appendNote: async () => {},
  closeForImport: async () => {},
  imported: () => {},
  setTitle: (id, title) => titles.set(id, title),
  models: async () => models,
  defaultModel: async () => def,
});

/** HEAD, the index's bytes and the working tree's status: what saving must never change. */
function untouched(dir: string) {
  return { head: sh(dir, "rev-parse", "HEAD"), branch: sh(dir, "symbolic-ref", "HEAD"), index: readFileSync(join(dir, ".git", "index")).toString("base64"), status: sh(dir, "status", "--porcelain") };
}

describe("version (rev) decisions", () => {
  const card = (rev: number) => ({ rev, savedBy: { name: "Bo" }, savedAt: T, previous: [] }) as unknown as SavedSessionCard;
  test("first save, next version, someone else's newer one, and the two answers", () => {
    assert.deepEqual(decideRev(null, null, undefined, () => "new1"), { ok: true, bundleId: "new1", rev: 1, previous: [] });
    const next = decideRev({ bundleId: "b", rev: 2 }, card(2), undefined, () => "x");
    assert.ok(next.ok && next.bundleId === "b" && next.rev === 3 && next.previous[0]!.rev === 2);
    const clash = decideRev({ bundleId: "b", rev: 2 }, card(3), undefined, () => "x");
    assert.deepEqual(clash, { ok: false, theirs: { rev: 3, savedBy: { name: "Bo" }, savedAt: T } });
    const replace = decideRev({ bundleId: "b", rev: 2 }, card(3), "replace", () => "x");
    assert.ok(replace.ok && replace.rev === 4 && replace.bundleId === "b");
    const copy = decideRev({ bundleId: "b", rev: 2 }, card(3), "new-copy", () => "fresh");
    assert.ok(copy.ok && copy.rev === 1 && copy.bundleId === "fresh");
    const gone = decideRev({ bundleId: "b", rev: 2 }, null, undefined, () => "x");
    assert.ok(gone.ok && gone.rev === 3 && gone.bundleId === "b");
  });
});

describe("save, list, preview, continue", () => {
  const top = repo("proj");
  const path = session(top, conversation(top));

  test("prepare reports, save refuses undecided items, then writes only the saved branch", async () => {
    const before = untouched(top);
    const p = await prepareSave(path);
    assert.ok(!("ok" in p), "ok" in p ? p.message : "");
    if ("ok" in p) return;
    assert.deepEqual(p.branches, ["feat/x"]);
    assert.ok(p.knownBranches.includes("master") && p.knownBranches.includes("feat/x"));
    const secret = p.review.find((r) => r.kind === "possible-secret");
    const image = p.review.find((r) => r.kind === "image");
    assert.ok(secret && image);
    assert.equal(p.cleaning.thinkingDropped, 1);
    assert.equal(p.push.remote, null);
    assert.equal(p.lineage, null);
    const base = { path, prepareId: p.prepareId, title: "Fix a", branches: ["feat/x"], scope: "whole" as const, trimToolOutput: false, includeImages: true, push: false };
    const undecided = await save({ ...base, decisions: { [secret.id]: "remove" } }, hooks());
    assert.ok(!undecided.ok && undecided.reason === "undecided");
    const saved = await save({ ...base, note: "Pick up the tests", decisions: { [secret.id]: "remove", [image.id]: "remove" } }, hooks());
    assert.ok(saved.ok, !saved.ok ? saved.message : "");
    if (!saved.ok) return;
    assert.deepEqual(untouched(top), before, "HEAD, branch, index and working tree are untouched");
    assert.equal(saved.card.rev, 1);
    assert.equal(saved.card.format, SAVED_SESSION_MARKER);
    assert.equal(saved.pushed, false);
    assert.equal(sh(top, "rev-parse", SAVED_SESSIONS_REF), saved.commit);
    assert.equal(sh(top, "log", "-1", "--format=%s", SAVED_SESSIONS_REF), "Save session: Fix a (v1)");
    const files = sh(top, "ls-tree", "-r", "--name-only", SAVED_SESSIONS_REF).split("\n");
    assert.deepEqual(files.sort(), [`sessions/${saved.card.bundleId}/README.md`, `sessions/${saved.card.bundleId}/session.json`, `sessions/${saved.card.bundleId}/transcript.jsonl`]);
    const transcript = sh(top, "cat-file", "blob", `${SAVED_SESSIONS_REF}:sessions/${saved.card.bundleId}/transcript.jsonl`);
    assert.ok(!transcript.includes(TOKEN) && !transcript.includes(top) && !transcript.includes(IMG) && !transcript.includes("private"));
    assert.ok(transcript.includes(`${ROOT_TOKEN}/a.ts`));
    assert.ok(sh(top, "cat-file", "blob", `${SAVED_SESSIONS_REF}:sessions/${saved.card.bundleId}/README.md`).includes(SAVED_SESSION_MARKER));
    assert.equal(saved.card.cleaning.possibleRemoved, 1);
    assert.equal(saved.card.cleaning.imagesRemoved, 1);
    // The session remembers it: the Saved list.
    const mine = await savedForSession(path);
    assert.equal(mine.repo, true);
    assert.deepEqual(mine.saved.map((s) => [s.bundleId, s.rev, s.how]), [[saved.card.bundleId, 1, "saved"]]);
  });

  test("saving again is the next version of the same saved session", async () => {
    const p = await prepareSave(path);
    assert.ok(!("ok" in p) && p.lineage);
    if ("ok" in p) return;
    assert.equal(p.lineage!.note, "Pick up the tests", "saving again prefills the saved note");
    assert.deepEqual(p.lineage!.branches, ["feat/x"]);
    const decisions = Object.fromEntries(p.review.map((r) => [r.id, "remove" as const]));
    const again = await save({ path, prepareId: p.prepareId, title: "Fix a", branches: ["feat/x", "master"], scope: "whole", trimToolOutput: false, includeImages: false, push: false, decisions }, hooks());
    assert.ok(again.ok, !again.ok ? again.message : "");
    if (!again.ok) return;
    assert.equal(again.card.bundleId, p.lineage!.bundleId);
    assert.equal(again.card.rev, 2);
    assert.equal(again.card.previous?.[0]?.rev, 1);
  });

  test("someone else's newer version asks first", async () => {
    const git = localGit(top);
    const p = await prepareSave(path);
    if ("ok" in p) return assert.fail(p.message);
    const id = p.lineage!.bundleId;
    const theirs = parseCard(await readPath(git, SAVED_SESSIONS_REF, `sessions/${id}/session.json`))!;
    const bumped = { ...theirs, rev: 7, savedBy: { name: "Bo" } };
    const tip = sh(top, "rev-parse", SAVED_SESSIONS_REF);
    const c = await commitChange(git, tip, { write: { [`sessions/${id}/session.json`]: JSON.stringify(bumped) } }, "Bo's save");
    sh(top, "update-ref", SAVED_SESSIONS_REF, c, tip);
    const req = { path, prepareId: p.prepareId, title: "Fix a", branches: ["feat/x"], scope: "whole" as const, trimToolOutput: false, includeImages: false, push: false, decisions: Object.fromEntries(p.review.map((r) => [r.id, "keep" as const])) };
    const asked = await save(req, hooks());
    assert.ok(!asked.ok && asked.reason === "conflict" && asked.theirs?.rev === 7 && asked.theirs.savedBy.name === "Bo");
    const replaced = await save({ ...req, onConflict: "replace" }, hooks());
    assert.ok(replaced.ok && replaced.card.rev === 8 && replaced.card.bundleId === id);
  });

  test("the list reads the branch with badges; preview marks it seen", async () => {
    const list = await listSaved(top);
    assert.equal(list.repo, true);
    assert.equal(list.folderBranch, "feat/x");
    assert.equal(list.sessions.length, 1);
    const row = list.sessions[0]!;
    assert.equal(row.badge, null, "this computer's own save is seen");
    assert.deepEqual(list.branches, ["feat/x"]);
    const pv = await preview(top, row.bundleId, null, hooks());
    assert.ok(!("ok" in pv));
    if ("ok" in pv) return;
    assert.deepEqual(pv.model, { provider: "zai", id: "glm-5.3", saved: true });
    assert.equal(pv.lastMessages.at(-1)?.text, "Done: edited a.ts.");
    assert.equal(seenRevs()[row.bundleId], row.rev);
  });

  test("continue loads it into a blank session elsewhere, paths restored, model fallback said", async () => {
    const other = repo("clone");
    const blank = session(other, [{ type: "custom", id: "mode1", customType: "mode", data: { v: 1 } }]);
    const row = (await listSaved(top)).sessions[0]!;
    // The saved branch reaches the other checkout as a colleague's fetch would bring it.
    sh(other, "fetch", "-q", top, `${SAVED_SESSIONS_REF}:${SAVED_SESSIONS_REF}`);
    const r = await continueInto({ path: blank, cwd: other, bundleId: row.bundleId, rev: row.rev }, hooks([], "anthropic/claude-x"));
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    assert.deepEqual(r.model, { provider: "anthropic", id: "claude-x", saved: false, savedId: "zai/glm-5.3" });
    assert.deepEqual(r.worktreeOffer, [{ branch: "feat/x", where: "here" }]);
    const text = readFileSync(blank, "utf8");
    assert.ok(text.includes(`${other}/a.ts`) && !text.includes(ROOT_TOKEN));
    const lines = text.trim().split("\n").map((l) => JSON.parse(l));
    const note = lines.find((l) => l.customType === CONTINUATION_NOTE_TYPE);
    assert.ok(note && note.display === true && note.details.bundleId === row.bundleId);
    assert.match(note.content, /saved by Ada/);
    assert.match(note.content, /saved on zai\/glm-5\.3, which this computer can't run; it continues on anthropic\/claude-x/);
    assert.equal(note.details.model.savedId, "zai/glm-5.3");
    assert.ok(lines.some((l) => l.type === "model_change" && l.provider === "anthropic"));
    assert.deepEqual((await savedForSession(blank)).saved.map((s) => s.how), ["continued"]);
    assert.equal(titles.get(lines[0].id), "Fix a", "the saver's title, not the first message's");
    // Never into a session with a conversation.
    const again = await continueInto({ path: blank, cwd: other, bundleId: row.bundleId, rev: row.rev }, hooks());
    assert.ok(!again.ok && again.reason === "not-blank");
  });

  test("prune drops a merged branch from its saved sessions", async () => {
    const before = (await listSaved(top)).sessions[0]!;
    const r = await prune(top, "feat/x");
    assert.ok(r.ok && r.removed === 1);
    const after = await listSaved(top);
    assert.equal(after.sessions.length, 0);
    assert.ok(before);
  });
});

describe("a saved session on main", () => {
  test("only the folders found decide the purge: older saved sessions already pushed don't block it", async () => {
    const top = repo("pushed-old");
    sh(top, "checkout", "-q", "master");
    const bare = join(root, "pushed-old.git");
    execFileSync("git", ["init", "-q", "--bare", bare], { env: ENV });
    sh(top, "remote", "add", "origin", bare);
    // An old mistake, added and removed, already pushed.
    mkdirSync(join(top, "old"), { recursive: true });
    writeFileSync(join(top, "old", "session.json"), JSON.stringify({ format: SAVED_SESSION_MARKER }));
    sh(top, "add", "old");
    sh(top, "commit", "-q", "-m", "old copy");
    sh(top, "rm", "-q", "-r", "old");
    sh(top, "commit", "-q", "-m", "old remove");
    sh(top, "push", "-q", "origin", "master");
    // The new one, unpushed.
    mkdirSync(join(top, "tmpcopy"), { recursive: true });
    writeFileSync(join(top, "tmpcopy", "session.json"), JSON.stringify({ format: SAVED_SESSION_MARKER }));
    sh(top, "add", "tmpcopy");
    sh(top, "commit", "-q", "-m", "copy chat");
    sh(top, "rm", "-q", "-r", "tmpcopy");
    sh(top, "commit", "-q", "-m", "remove chat");
    const r = await onMain(top);
    assert.deepEqual(r.found, [{ dir: "tmpcopy", historyOnly: true }]);
    assert.equal(r.purgeable, true);
    assert.equal(r.purge?.commits, 2);
    const p = await purgeFromMain(top, ["tmpcopy"]);
    assert.ok(p.ok, !p.ok ? p.message : "");
    assert.equal(sh(top, "log", "--format=%s", "origin/master..master"), "");
    // Pushed, then removed from main: only its deletion is unpushed, so it isn't listed (the checklist's case).
    mkdirSync(join(top, "handoff", "sessions", "abcdef99"), { recursive: true });
    writeFileSync(join(top, "handoff", "sessions", "abcdef99", "README.md"), `${SAVED_SESSION_MARKER}\n`);
    writeFileSync(join(top, "handoff", "sessions", "abcdef99", "session.json"), JSON.stringify({ format: SAVED_SESSION_MARKER, bundleId: "abcdef99", rev: 1, title: "Handoff", savedBy: { name: "A" }, savedAt: "2026-01-01", branches: [], bytes: 1, approxTokens: 1, counts: { messages: 1, entries: 1 } }));
    sh(top, "add", "handoff");
    sh(top, "commit", "-q", "-m", "copy handoff");
    const inTree = await onMain(top);
    assert.deepEqual(inTree.found, [{ dir: "handoff/sessions/abcdef99", bundleId: "abcdef99", title: "Handoff" }], "named by its card's title");
    sh(top, "push", "-q", "origin", "master");
    const removed = await removeFromMain(top, ["handoff/sessions/abcdef99"]);
    assert.ok(removed.ok);
    assert.deepEqual((await onMain(top)).found, []);
    // The pushed one can't be purged.
    const refused = await purgeFromMain(top, ["old"]);
    assert.ok(!refused.ok);
  });

  test("found by its marker, removed in one commit, or purged while unpushed", async () => {
    const top = repo("mainleak");
    sh(top, "checkout", "-q", "master");
    mkdirSync(join(top, "copied", "chat"), { recursive: true });
    writeFileSync(join(top, "copied", "chat", "session.json"), JSON.stringify({ format: SAVED_SESSION_MARKER, bundleId: "abcdef12", rev: 1, title: "Leaked" }));
    sh(top, "add", "copied");
    sh(top, "commit", "-q", "-m", "copy a chat in");
    writeFileSync(join(top, "b.ts"), "b\n");
    sh(top, "add", "b.ts");
    sh(top, "commit", "-q", "-m", "more work");
    const found = await onMain(top);
    assert.equal(found.mainBranch, "master");
    assert.deepEqual(found.found.map((f) => f.dir), ["copied/chat"]);
    assert.equal(found.purgeable, true);
    const head = sh(top, "rev-parse", "HEAD");
    const purged = await purgeFromMain(top, ["copied/chat"]);
    assert.ok(purged.ok, !purged.ok ? purged.message : "");
    if (!purged.ok) return;
    assert.equal(purged.backupBranch, `backstop/saved-sessions-${head.slice(0, 12)}`);
    assert.equal(sh(top, "rev-parse", purged.backupBranch), head);
    assert.equal(sh(top, "log", "--format=%s", "-S", SAVED_SESSION_MARKER, "master"), "", "gone from main's history");
    assert.deepEqual(sh(top, "log", "--format=%s", "master").split("\n"), ["more work", "one"]);
    assert.equal(sh(top, "status", "--porcelain"), "");
    assert.ok(statSync(join(top, "b.ts")).isFile());
    // Removal (always offered) is one commit deleting only that folder.
    mkdirSync(join(top, "again"), { recursive: true });
    writeFileSync(join(top, "again", "session.json"), JSON.stringify({ format: SAVED_SESSION_MARKER }));
    sh(top, "add", "again");
    sh(top, "commit", "-q", "-m", "again");
    const removed = await removeFromMain(top, ["again"]);
    assert.ok(removed.ok, !removed.ok ? removed.message : "");
    assert.deepEqual(sh(top, "show", "--name-status", "--format=%s", "HEAD").split("\n").filter(Boolean), ["Remove a saved session from master", "D\tagain/session.json"]);
    // Removed from the tree, it is still in main's unpushed history: only the purge would take it out.
    assert.deepEqual((await onMain(top)).found, [{ dir: "again", historyOnly: true }]);
    // A Merge Anyway of a branch that added a card and deleted it: gone from main's tree, still in its
    // unpushed history. Only the purge applies.
    mkdirSync(join(top, "hidden"), { recursive: true });
    writeFileSync(join(top, "hidden", "session.json"), JSON.stringify({ format: SAVED_SESSION_MARKER }));
    sh(top, "add", "hidden");
    sh(top, "commit", "-q", "-m", "add hidden");
    sh(top, "rm", "-q", "-r", "hidden");
    sh(top, "commit", "-q", "-m", "delete hidden");
    const hist = await onMain(top);
    assert.deepEqual(hist.found.filter((f) => f.dir === "hidden"), [{ dir: "hidden", historyOnly: true }]);
    assert.equal(hist.purgeable, true);
    const p2 = await purgeFromMain(top, ["again", "hidden"]);
    assert.ok(p2.ok, !p2.ok ? p2.message : "");
    assert.equal(sh(top, "log", "--format=%s", "-S", SAVED_SESSION_MARKER, "master"), "");
    assert.deepEqual((await onMain(top)).found, []);
  });
});
