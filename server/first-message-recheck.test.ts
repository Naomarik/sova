// Run: pnpm test server/first-message-recheck.test.ts. Its folders are in the runner's throwaway home.
//
// Just before a new chat's first message goes in, its folder's decisions are read again: a chat built on an older
// list is rebuilt with the new one first (recheckBeforeFirst, server/session-setup.ts).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const base = realpathSync(mkdtempSync(join(homedir(), "first-recheck-")));
const agent = join(base, "agent");
mkdirSync(join(agent, "sova"), { recursive: true });
const prevAgent = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agent;
after(() => {
  if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgent;
  rmSync(base, { recursive: true, force: true });
});

const { recheckBeforeFirst } = await import("./session-setup");
const { folderRuleForSession } = await import("./projects/folder-rule");
const { pristineLoadout } = await import("./session-loadout");
const A = await import("./approvals");
const setting = await import("./context-approval-setting");
type Rule = import("../shared/folder-rule").FolderRule;

const repo = join(base, "repo");
mkdirSync(join(repo, ".git"), { recursive: true });
writeFileSync(join(repo, "AGENTS.md"), "# repo\n");
const sessionDir = join(agent, "sessions", "--repo--");
mkdirSync(sessionDir, { recursive: true });
const session = join(sessionDir, "2026-11-17T00-00-00-000Z_01a5c444-0000-7000-8000-000000000001.jsonl");
writeFileSync(session, `${JSON.stringify({ type: "session", version: 3, id: "01a5c444-0000-7000-8000-000000000001", timestamp: "2026-11-17T00:00:00.000Z", cwd: repo })}\n`);

/** A chat built with the folder's rule as it is now, and what it was asked to reopen with. */
async function chatBuiltNow(over: { pristine?: boolean; special?: unknown } = {}) {
  const reopened: Rule[] = [];
  const rule = await folderRuleForSession(session);
  return {
    reopened,
    path: session,
    mirror: { pristine: over.pristine ?? true, special: over.special, loadout: { off: pristineLoadout(null, rule) } },
    reopenHere: async (args: { folderRule?: Rule }) => void reopened.push(args.folderRule!),
  };
}

test("a chat built on the list as it is goes as it is; one whose folder's decisions changed since is rebuilt with them, once", async () => {
  setting.setAllowWithoutAsking(false);
  try {
    const h = await chatBuiltNow();
    assert.equal(await recheckBeforeFirst(h), false);
    assert.deepEqual(h.reopened, []);
    // A flip saved after the chat was built (the quick first send).
    await A.writeFolderApprovals(A.folderForCwd(repo), { context: { "AGENTS.md": "approved" }, skills: {} });
    assert.equal(await recheckBeforeFirst(h), true);
    assert.deepEqual((h.reopened as Rule[]).map((r) => r.context.approved.includes(join(repo, "AGENTS.md"))), [true]);
    // Its mirror hasn't said so yet: the next message isn't rebuilt again for the same list.
    assert.equal(await recheckBeforeFirst(h), false);
    assert.equal(h.reopened.length, 1);
    // A New item left off (disallowed while asking first) changes nothing a chat loads: no rebuild.
    mkdirSync(join(repo, "sub"), { recursive: true });
    writeFileSync(join(repo, "sub", "AGENTS.md"), "# sub\n");
    const g = await chatBuiltNow();
    await A.writeFolderApprovals(A.folderForCwd(repo), { context: { "sub/AGENTS.md": "disallowed" }, skills: {} });
    assert.ok((await folderRuleForSession(session)).context.disallowed.includes(join(repo, "sub", "AGENTS.md")), "the rule did change");
    assert.equal(await recheckBeforeFirst(g), false);
    assert.deepEqual(g.reopened, []);
  } finally {
    setting.setAllowWithoutAsking(true);
  }
});

test("only a new ordinary chat is checked: a started one, or a special one, never", async () => {
  const started = await chatBuiltNow({ pristine: false });
  const special = await chatBuiltNow({ special: { kind: "overseer" } });
  await A.writeFolderApprovals(A.folderForCwd(repo), { context: { "AGENTS.md": "disallowed" }, skills: {} });
  assert.equal(await recheckBeforeFirst(started), false);
  assert.equal(await recheckBeforeFirst(special), false);
  assert.deepEqual([started.reopened, special.reopened], [[], []]);
});
