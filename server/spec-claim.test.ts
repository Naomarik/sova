// Run: pnpm test -- server/spec-claim.test.ts. The spec card on the server (§chat.spec-card/record,
// /claim-sheet): the transcript row a `spec-turn` record makes, and the claim sheet's text read from the
// run's commits through the trusted spec tools, from the record's capture, or now. A throwaway agent dir
// and git repository under a scratch root; nothing outside it.
// Claims read from a real repository's commits with the real spec tools: spec-claim.integration.test.ts.
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

test("a spec-turn record is a spec-turn row carrying the record without its captured prose", () => {
  const d = record({ prose: { "§app.shell/head": "captured" } });
  const rows = normalizeEntries([{ type: "custom", id: "x1", parentId: null, customType: SPEC_TURN_ENTRY, data: d }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.kind, "spec-turn");
  assert.deepEqual(rows[0]!.specTurn?.own, [{ id: "§app.shell/head", what: "v2 wording", change: "text", op: 0 }]);
  assert.equal("prose" in (rows[0]!.specTurn ?? {}), false, "the row never carries the captured text");
  assert.deepEqual(normalizeEntries([{ type: "custom", id: "x2", parentId: null, customType: SPEC_TURN_ENTRY, data: { v: 1, own: "x" } }]), [], "unreadable data: no row");
  // The record as a custom MESSAGE would be model context: the reader never takes it for the card.
  const asMessage = normalizeEntries([{ type: "custom_message", id: "x3", parentId: null, customType: SPEC_TURN_ENTRY, content: "x", display: false, details: d }]);
  assert.equal(asMessage.some((r) => r.kind === "spec-turn"), false);
});

test("the card's collapsed line is the TUI's line, from the same record", async () => {
  const { specTurnLine: tuiLine } = await import("../pi-config/extensions/mode/spec-turn.ts");
  const { specTurnLine: cardLine } = await import("../src/lib/spec-card");
  const arrived = { from: "master", count: 83, byArea: [{ area: "chat.composer", count: 12 }] };
  for (const d of [record(), record({ arrived }), record({ named: [], foreign: [], arrived }), record({ named: [], foreign: [] })]) {
    const { prose: _p, ...info } = d;
    assert.equal(cardLine(info), tuiLine(d));
  }
});
