// Run: npx tsx --test server/session-loadout-runtime.test.ts (or pnpm test). A throwaway
// PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written, and no model is called.
//
// Switching a new session's context files and skills (§chat.transcript/setup-card-toggles) through
// real chat runtimes: the route's write, the rebuilt runtime's system prompt, the card's read, the
// reopen after every chat is gone, and the refusal once a message is on the branch.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-loadout-runtime-")));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({}));
const sessionsDir = join(agentDir, "sessions", "--tmp-loadout--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });
const GLOBAL = join(agentDir, "AGENTS.md");
const LOCAL = join(cwd, "AGENTS.md");
writeFileSync(GLOBAL, "GLOBAL-RULES-MARKER\n");
writeFileSync(LOCAL, "LOCAL-RULES-MARKER\n");
for (const name of ["alpha-skill", "beta-skill"]) {
  mkdirSync(join(agentDir, "skills", name), { recursive: true });
  writeFileSync(join(agentDir, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} description.\n---\n\nbody\n`);
}

const { acquireChat, disposeAllChats, heldChat } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
const { applyLoadout, clearSetupCache, getSessionSetup } = await import("./session-setup");
const { LOADOUT_ENTRY } = await import("./session-loadout");
const { entryOf, normalizeEntries } = await import("./transcript");
const { readActiveBranch } = await import("./harness/pi/reader");
const { addWebSession } = await import("./web-sessions");
const { markOwned } = await import("./write-guard");

after(async () => {
  await disposeAllChats();
});

let n = 0;
/** A web session file in `cwd`; `talked` adds one exchange. */
function makeSession(talked = false): string {
  const id = `0199bbbb-0000-7000-8000-${String(++n).padStart(12, "0")}`;
  const path = canonicalPath(join(sessionsDir, `2026-10-03T00-00-${String(n).padStart(2, "0")}-000Z_${id}.jsonl`));
  const lines: unknown[] = [{ type: "session", version: 3, id, timestamp: "2026-10-03T00:00:00.000Z", cwd }];
  if (talked) {
    lines.push({ type: "message", id: `u${n}`, parentId: null, timestamp: "2026-10-03T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 } });
  }
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  markOwned(path);
  addWebSession(id);
  return path;
}
const loadoutEntries = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "custom" && e.customType === LOADOUT_ENTRY);
const ok = <T extends { state: string }>(s: T) => {
  assert.equal(s.state, "ok");
  return s as Extract<T, { state: "ok" }>;
};

test("a switch writes the entry, rebuilds the runtime without the off rows, and the card still lists them", async () => {
  const path = makeSession();
  const before = await acquireChat(path);
  assert.match(before.session.systemPrompt, /GLOBAL-RULES-MARKER/);
  assert.match(before.session.systemPrompt, /beta-skill/);
  const first = ok(await getSessionSetup(path, { fresh: true }));
  assert.equal(first.toggleable, true);
  assert.ok(first.context.every((f) => !f.off) && first.skills.every((k) => !k.off));

  const r = await applyLoadout(path, { offContext: [GLOBAL], offSkills: ["beta-skill"] });
  assert.equal(r.ok, true);
  assert.deepEqual(loadoutEntries(path).map((e) => e.data), [{ v: 1, offContext: [GLOBAL], offSkills: ["beta-skill"] }]);

  const after = heldChat(path)!;
  assert.notEqual(after, before, "the runtime was rebuilt");
  assert.doesNotMatch(after.session.systemPrompt, /GLOBAL-RULES-MARKER/);
  assert.match(after.session.systemPrompt, /LOCAL-RULES-MARKER/);
  assert.doesNotMatch(after.session.systemPrompt, /beta-skill/);
  assert.match(after.session.systemPrompt, /alpha-skill/);

  const card = ok((r as { setup: Parameters<typeof ok>[0] }).setup as Awaited<ReturnType<typeof getSessionSetup>>);
  assert.deepEqual(card.context.map((f) => [f.path, !!f.off]), [[GLOBAL, true], [LOCAL, false]]);
  assert.deepEqual(card.skills.map((k) => [k.name, !!k.off]).sort(), [["alpha-skill", false], ["beta-skill", true]]);
  assert.equal(card.toggleable, true);

  // The entry draws no row and the session is still before its first message.
  // (The open-time thinking entry is a settings row, which the empty state already ignores.)
  const rows = normalizeEntries(await readActiveBranch(path));
  assert.deepEqual(rows.filter((r) => (entryOf(r) as { type?: string } | undefined)?.type === "custom"), []);
  assert.ok(rows.every((r) => (entryOf(r) as { type?: string } | undefined)?.type === "thinking_level_change" || (entryOf(r) as { type?: string } | undefined)?.type === "model_change"));
  assert.equal(after.pristine, true);

  // Every chat gone (a restart): the reopened runtime reads the same entry.
  await disposeAllChats();
  clearSetupCache();
  const reopened = await acquireChat(path);
  assert.doesNotMatch(reopened.session.systemPrompt, /GLOBAL-RULES-MARKER/);
  assert.doesNotMatch(reopened.session.systemPrompt, /beta-skill/);

  // Back on: a later entry with nothing off brings both back.
  const back = await applyLoadout(path, { offContext: [], offSkills: [] });
  assert.equal(back.ok, true);
  assert.match(heldChat(path)!.session.systemPrompt, /GLOBAL-RULES-MARKER/);
  assert.match(heldChat(path)!.session.systemPrompt, /beta-skill/);
});

test("an unchanged set writes nothing and keeps the runtime", async () => {
  const path = makeSession();
  const chat = await acquireChat(path);
  const r = await applyLoadout(path, { offContext: [], offSkills: [] });
  assert.equal(r.ok, true);
  assert.equal(loadoutEntries(path).length, 0);
  assert.equal(heldChat(path), chat);
});

test("refused once a message is on the branch: 409, nothing written, no switches on the card", async () => {
  const path = makeSession(true);
  await acquireChat(path);
  const r = await applyLoadout(path, { offContext: [GLOBAL], offSkills: [] });
  assert.deepEqual(r, { ok: false, status: 409, error: "Context files and skills are fixed once a message is sent." });
  assert.equal(loadoutEntries(path).length, 0);
  assert.equal(ok(await getSessionSetup(path, { fresh: true })).toggleable, false);
});

test("a malformed body is a 400 and writes nothing", async () => {
  const path = makeSession();
  for (const body of [{ offContext: ["relative.md"], offSkills: [] }, { offContext: [] }, null]) {
    const r = await applyLoadout(path, body);
    assert.equal(r.ok, false);
    assert.equal((r as { status: number }).status, 400);
  }
  assert.equal(loadoutEntries(path).length, 0);
});
