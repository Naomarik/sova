// Run: pnpm test:int server/draft-carry.integration.test.ts
// A decision agreed in a conversation becomes official with its branch (§app.requirements/draft-approval): Build
// cuts the coding session's worktree and carries the conversation's spec draft into it before the session
// starts, so the real draft tool's `status` run IN THE WORKTREE shows the decision; Approve and the
// reconciler's promotion then leave it to that branch, and the project root's spec stays as it was. A
// decision whose build never gets a branch (a project folder outside Git) is still published directly.
// REAL hosted runtimes in a throwaway PI_CODING_AGENT_DIR, a real git client project, the real spec tools;
// the build's model is a scripted provider whose endpoint is never answered, so no model is called.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { scriptedModelsJson } from "./harness/pi/testing/scripted-model";
import { scratchRoot } from "./test-scratch";

for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];
const tmp = realpathSync(scratchRoot("sova-draft-carry-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const agentDir = join(tmp, "agent");
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
writeFileSync(join(agentDir, "models.json"), JSON.stringify(scriptedModelsJson()));
writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({ extensions: [resolve(import.meta.dirname, "../pi-config/extensions/mode")], defaultProvider: "scripted", defaultModel: "scripted", retry: { enabled: false } }),
);
writeFileSync(join(agentDir, "mode.json"), JSON.stringify({ version: 1, mode: "normal", strict: false, minorModes: [] }));
process.env.PI_CODING_AGENT_DIR = agentDir;
await import("./testing/in-process-chats");
const { buildApp } = await import("./app");
buildApp({ extensionEntriesOf: async () => [] });
const orgs = await import("./orgs");
const tools = await import("./conversation-draft-tools");
const routes = await import("./conversation-draft-routes");
const store = await import("./conversation-draft-store");
const { readBuild, withWorktreePath } = await import("./build-loadout");
const { disposeAllChats } = await import("./chat-manager");
const { settled } = await import("./workspace-git");

after(async () => {
  await disposeAllChats();
  await settled(join(tmp, "ws"));
  rmSync(tmp, { recursive: true, force: true });
});

const DRAFT_TOOL = resolve(import.meta.dirname, "../pi-config/extensions/spec/core/sova-spec-draft.mjs");
const ID = ["-c", "user.email=t@example.invalid", "-c", "user.name=T", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const put = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
/** A client project's folder with a small committed spec; its drafts folder is local only, as Sova writes it. */
function client(dir: string, inGit: boolean): string {
  put(dir, ".sova/spec/manifest.json", `${JSON.stringify({ formatVersion: 1, claims: { "§site/pages": { kind: "surface", authority: "accepted" } } }, null, 2)}\n`);
  put(dir, ".sova/spec/claims/site/pages.md", "# §site/pages — Pages\n\nThe website's pages.\n");
  put(dir, ".sova/spec/.gitignore", "drafts/\nreviews/\npilot/\n");
  if (inGit) {
    git(dir, "init", "-q", "-b", "master");
    git(dir, "add", ".");
    git(dir, ...ID, "commit", "-q", "-m", "spec");
  }
  return dir;
}
/** Every file of the root's current spec (drafts left out), by path. */
const currentSpec = (root: string) => {
  const m = readFileSync(join(root, ".sova/spec/manifest.json"), "utf8");
  return { manifest: m, pages: readFileSync(join(root, ".sova/spec/claims/site/pages.md"), "utf8") };
};
const draftStatus = (root: string, name: string) => JSON.parse(execFileSync(process.execPath, [DRAFT_TOOL, "status", name, "--root", root, "--json"], { encoding: "utf8" })) as { exit: number; ids: { id: string; change: string }[] };

let n = 0;
/** "Agree in an alignment": the conversation records a decision, and its draft is caught up on the main line. */
async function agreeIn(projectId: string, statement: string) {
  const sessionId = `0000000${++n}-aaaa-4bbb-8ccc-0123456789ab`;
  const ref = { sessionId, projectId, kind: "gathering" as const, title: "Your archery website", person: { id: "p_alperen", name: "Alperen" } };
  await tools.agreeRequirement(ref, { decisionId: `${sessionId}:d1`, area: "Content editing", areaKey: "content-editing", statement, quote: `I'd like ${statement.toLowerCase()}`, by: "p_alperen", name: "Alperen", at: "2026-10-26T10:00:00Z", entryId: "e1" });
  await tools.catchUpConversationDraft(sessionId, projectId, ref);
  const rec = () => store.readRecord(tools.placeOf(projectId).workspace, projectId, sessionId)!;
  return { sessionId, rec };
}

describe("a conversation's decision goes to its build's branch, and is official when that branch lands", async () => {
  const org = await orgs.createOrg({ name: "Carry", dir: join(tmp, "ws") });
  const root = client(join(tmp, "src", "site"), true);
  const project = await orgs.addProject(org.id, { name: "Archery website", root });

  test("Build carries the draft into the worktree: sova-spec-draft status there shows the decision", async () => {
    const c = await agreeIn(project.id, "The founder edits class dates himself.");
    const item = c.rec().items[0]!;
    assert.ok(item.recordId, "the decision has its note record in the conversation's draft");
    const before = currentSpec(root);
    const out = await routes.buildDraft(project.id, c.sessionId);
    assert.match(out.branch ?? "", /^sova\//, `the build got a branch: ${JSON.stringify(out)}`);
    const row = readBuild(project.id, out.sessionId)!;
    const wt = (await withWorktreePath(row, root))!.worktree;
    assert.equal(wt.branch, out.branch);
    assert.notEqual(realpathSync(wt.path), realpathSync(root));
    // The real draft tool, run in the worktree, sees the conversation's draft and its decision record.
    const st = draftStatus(wt.path, c.rec().draft);
    assert.notEqual(st.exit, 2, JSON.stringify(st));
    assert.ok(st.ids.some((i) => i.id === item.recordId), `status in the worktree lists ${item.recordId}: ${JSON.stringify(st.ids)}`);
    // The control: the project root has the draft too (the conversation's own), so the worktree's copy is the carry.
    assert.ok(existsSync(join(root, ".sova/spec/drafts", c.rec().draft, "draft.json")));
    assert.equal(git(wt.path, "status", "--porcelain"), "", "the carried draft is local only: the worktree stays clean");
    assert.equal(c.rec().items[0]!.buildBranch, out.branch);
    assert.deepEqual(currentSpec(root), before, "nothing reached the project root's spec");
  });

  test("Approve and the reconciler leave a carried decision to its branch; the root's spec is unchanged", async () => {
    const c = await agreeIn(project.id, "Archers book lanes online.");
    const out = await routes.buildDraft(project.id, c.sessionId);
    assert.ok(out.branch);
    const before = currentSpec(root);
    const approved = await routes.approveDraft(project.id, c.sessionId);
    assert.deepEqual([approved.promoted, approved.waitingForBuild], [[], ["r1"]]);
    assert.equal(approved.commit, undefined, "no promotion commit on the main line");
    assert.deepEqual(currentSpec(root), before);
    assert.equal(routes.decisionsHeldForBranch(project.id).get(`${c.sessionId}:d1`), out.branch);
    // Once the branch's promotion is in the main line's spec (it landed), nothing holds it any more.
    const m = JSON.parse(before.manifest);
    m.claims[c.rec().items[0]!.recordId!] = { kind: "note", authority: "accepted" };
    writeFileSync(join(root, ".sova/spec/manifest.json"), `${JSON.stringify(m, null, 2)}\n`);
    assert.equal(routes.decisionsHeldForBranch(project.id).has(`${c.sessionId}:d1`), false);
    writeFileSync(join(root, ".sova/spec/manifest.json"), before.manifest);
  });
});

describe("a decision whose build gets no branch is still published directly", async () => {
  const org = await orgs.createOrg({ name: "NoGit", dir: join(tmp, "ws2") });
  const root = client(join(tmp, "src", "plain"), false);
  const project = await orgs.addProject(org.id, { name: "Plain folder", root });

  test("Build runs in the folder itself: no carry, no branch; Approve promotes into the spec at once", async () => {
    const c = await agreeIn(project.id, "Prices show in riyals.");
    const out = await routes.buildDraft(project.id, c.sessionId);
    assert.equal(out.branch, undefined);
    assert.equal(c.rec().items[0]!.buildBranch, undefined);
    const approved = await routes.approveDraft(project.id, c.sessionId);
    assert.deepEqual(approved.promoted, ["r1"]);
    const rid = c.rec().items[0]!.recordId!;
    assert.ok(rid in JSON.parse(readFileSync(join(root, ".sova/spec/manifest.json"), "utf8")).claims, "published directly into the folder's spec");
  });
});
