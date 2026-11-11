// Run: pnpm test:int -- server/project-skills-start.integration.test.ts. A to-do's Start into a folder that asks
// first (the Sova-wide "Allow context files and skills without asking" off): from the operator's page, with a skill
// still to decide, its message waits as the new chat's draft and nothing is sent; from no page it goes at once,
// with the waiting skill off. Real build statecharts and runtimes in this process, with this repo's mode extension
// (a build sends its first prompt only once its mode is set); no model auth, so a sent turn fails after its send.
// A throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { scratchRoot } from "./test-scratch";

for (const k of Object.keys(process.env)) if (/^(SPEC_AGREE_|SOVA_SPEC_|PI_SPEC_)/.test(k) || /_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];
const here = dirname(fileURLToPath(import.meta.url));
const tmp = scratchRoot("sova-skills-start-");
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const agentDir = join(tmp, "agent");
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, extensions: [resolve(here, "../pi-config/extensions/mode")] }));
writeFileSync(join(agentDir, "mode.json"), JSON.stringify({ version: 1, mode: "normal", strict: false, minorModes: [] }));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.HOME = join(tmp, "home");
process.env.CLAUDE_CONFIG_DIR = join(tmp, "home", ".claude");

const root = join(tmp, "proj");
mkdirSync(join(root, ".agents", "skills", "wait-skill"), { recursive: true });
writeFileSync(join(root, ".agents", "skills", "wait-skill", "SKILL.md"), "---\nname: wait-skill\ndescription: The wait-skill recipe.\n---\n\nbody\n");

await import("./testing/in-process-chats");
const { buildApp } = await import("./app");
buildApp({ extensionEntriesOf: async () => [] });
const cm = await import("./chat-manager");
const po = await import("./project-overseer");
const { registerProjectIn } = await import("./projects/spaces");
const { projectOverseerPaths } = await import("./project-overseer-store");
const { addTodo } = await import("./overseer-todos");
const { getDraft } = await import("./drafts");
const { LOADOUT_ENTRY } = await import("./session-loadout");
const { setAllowWithoutAsking } = await import("./context-approval-setting");

const { project } = await registerProjectIn("standalone", root, { name: "Start Project", origin: "folder" });
setAllowWithoutAsking(false);

after(async () => {
  setAllowWithoutAsking(true);
  await cm.disposeAllChats();
});

const loadoutEntries = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "custom" && e.customType === LOADOUT_ENTRY)
    .map((e) => e.data);
const userMessages = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "message" && e.message?.role === "user");

test("asking: a to-do's Start from the page waits as the new chat's draft while anything is left to decide; an unwatched start never waits", async () => {
  const todos = projectOverseerPaths(project.id).todos;
  const page = await po.codeItem(project.id, { todoId: addTodo({ text: "Fix the held start" }, todos).id }, undefined, true);
  assert.equal(page.notPrompted, undefined, JSON.stringify(page));
  assert.ok((page.decideFirst ?? 0) > 0, `the page's start is held (${JSON.stringify(page)})`);
  assert.equal(getDraft(page.sessionId)?.text, "Fix the held start", "its message is the chat's draft");
  assert.deepEqual(userMessages(page.path), [], "nothing was sent");
  assert.deepEqual(loadoutEntries(page.path), [], "nothing was stamped");

  // The same start from no page sends at once, with the waiting skill off.
  const prog = await po.codeItem(project.id, { todoId: addTodo({ text: "Unwatched start" }, todos).id });
  assert.equal(prog.decideFirst, undefined);
  assert.equal(getDraft(prog.sessionId), null);
  // Sent, not answered: the stamp goes in with the send (no model auth here, so the turn itself fails).
  for (let i = 0; i < 200 && !loadoutEntries(prog.path).length; i++) await new Promise((r) => setTimeout(r, 25));
  const stamp = loadoutEntries(prog.path).at(-1);
  assert.equal(stamp?.asking, true);
  assert.deepEqual(stamp?.onlySkills, [], "its waiting skill stays off");
});
