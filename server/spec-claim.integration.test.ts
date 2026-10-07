// Run: pnpm test -- server/spec-claim.integration.test.ts. The spec card on the server (§chat.spec-card/record,
// /claim-sheet): the transcript row a `spec-turn` record makes, and the claim sheet's text read from the
// run's commits through the trusted spec tools, from the record's capture, or now. A throwaway agent dir
// and git repository under a scratch root; nothing outside it.
// Claims read from a real repository's commits with the real spec tools; the record and the card line in-process are spec-claim.test.ts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { scratchRoot } from "./test-scratch";
import { buildSpecTurn, SPEC_TURN_ENTRY, type SpecTurnDetails } from "../pi-config/extensions/mode/spec-turn.ts";

const root = scratchRoot("sova-spec-claim-");
after(() => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessions = join(agentDir, "sessions", "--repo--");
mkdirSync(sessions, { recursive: true });

const { normalizeEntries } = await import("./transcript");
const { specClaim, SpecClaimError } = await import("./spec-claim");

const repo = join(root, "repo");
mkdirSync(repo);
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" }).trim();
const put = (rel: string, text: string) => {
  mkdirSync(join(repo, rel, ".."), { recursive: true });
  writeFileSync(join(repo, rel), text);
};
const manifest = (ids: string[]) =>
  JSON.stringify({ formatVersion: 1, grammar: { claimsRoot: "claims/" }, claims: Object.fromEntries(ids.map((id) => [id, { kind: id.includes(".") ? "behavior" : "surface" }])) });
put(".sova/spec/manifest.json", manifest(["§app/shell", "§app.shell/head"]));
put(".sova/spec/claims/app/shell.md", "# §app/shell — Shell\n\nThe shell.\n\n## §app.shell/head — Head\n\nThe head, v1.\n");
git("init", "-q");
git("add", "-A");
git("commit", "-qm", "base");
const v1 = git("rev-parse", "HEAD");
put(".sova/spec/claims/app/shell.md", "# §app/shell — Shell\n\nThe shell.\n\n## §app.shell/head — Head\n\nThe head, v2.\n");
git("commit", "-qam", "promote v2");
const v2 = git("rev-parse", "HEAD");
// Then the work tree moves on: a committed text must never be read from it.
put(".sova/spec/claims/app/shell.md", "# §app/shell — Shell\n\nThe shell.\n\n## §app.shell/head — Head\n\nThe head, v3 in the work tree.\n");

let n = 0;
/** A session file holding one record; returns its path and the record's entry id. */
function session(d: SpecTurnDetails): { path: string; entry: string } {
  const entry = `st${++n}`;
  const path = join(sessions, `2026-10-06T00-00-0${n}_s${n}.jsonl`);
  const lines = [
    { type: "session", version: 3, id: `s${n}`, timestamp: "2026-10-06T00:00:00.000Z", cwd: repo },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-10-06T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "promote it" }] } },
    { type: "custom", id: entry, parentId: "u1", timestamp: "2026-10-06T00:00:02.000Z", customType: SPEC_TURN_ENTRY, data: d },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { path, entry };
}

const record = (over: Partial<Parameters<typeof buildSpecTurn>[0]> = {}) =>
  buildSpecTurn({
    ops: [{ kind: "commit", tree: repo, branch: "master", actor: "self", before: v1, after: v2 }],
    named: [{ ids: ["§app.shell/head"], text: "— v2 wording" }],
    foreign: ["§app.shell/head"],
    changes: new Map([["§app.shell/head", { change: "text", op: 0 }]]),
    unmapped: [],
    unpromoted: [],
    stale: [],
    reply: "Done.\nAlso changes: §app.shell/head — v2 wording",
    ok: true,
    reprompts: 0,
    ...over,
  });

test("a committed op's text is read at its commits, never from the work tree", async () => {
  const s = session(record());
  const r = await specClaim({ session: s.path, entry: s.entry, id: "§app.shell/head" });
  assert.equal(r.source, "commit");
  assert.equal(r.rev, v2);
  assert.match(r.after ?? "", /The head, v2\./);
  assert.match(r.before ?? "", /The head, v1\./);
  assert.doesNotMatch(JSON.stringify(r), /v3 in the work tree/);
});

test("a promote whose worktree was merged and removed: the sheet returns the prose captured at settle", async () => {
  const gone = join(root, "removed-worktree");
  const d = record({
    ops: [{ kind: "promote", tree: gone, branch: "feat/x", actor: "self", before: v2, after: v2 }],
    prose: { "§app.shell/head": "## §app.shell/head — Head\n\nThe head, as promoted in the worktree.\n" },
  });
  const s = session(d);
  const r = await specClaim({ session: s.path, entry: s.entry, id: "§app.shell/head" });
  assert.equal(r.source, "captured");
  assert.match(r.after ?? "", /as promoted in the worktree/);
  assert.match(r.before ?? "", /The head, v2\./, "the commit before, read through the session's repository");
});

test("a § no operation landed: the current text, said as such", async () => {
  const d = record({ ops: [], named: [{ ids: ["§app/shell"], text: "— the shell" }], foreign: [], changes: new Map() });
  const s = session(d);
  const r = await specClaim({ session: s.path, entry: s.entry, id: "§app/shell" });
  assert.equal(r.source, "current");
  assert.match(r.after ?? "", /The shell\./);
});

test("a deleted § has no text after; refusals name what's wrong", async () => {
  const s = session(record({ named: [{ ids: ["§app.shell/gone"], text: "— removed" }], foreign: [] }));
  const r = await specClaim({ session: s.path, entry: s.entry, id: "§app.shell/gone" });
  assert.equal(r.after, undefined);
  await assert.rejects(specClaim({ session: s.path, entry: s.entry, id: "not an id" }), SpecClaimError);
  await assert.rejects(specClaim({ session: s.path, entry: "nope", id: "§app/shell" }), /No such spec record/);
  await assert.rejects(specClaim({ session: join(root, "elsewhere.jsonl"), entry: s.entry, id: "§app/shell" }), /Unknown session/);
});
