// Run: pnpm test -- server/harness/pi/special-model-view.test.ts. What the model sees of each special
// loadout (§app.harness/session-special): the Overseer's, a project overseer's and a baton session's first
// request, its system prompt and its tools (name, description, prompt snippet and guidelines,
// parameters), compared with a recording made before the loadouts became data (al_3 stage 3 S1,
// recorded at 6aef2368). The session goldens record neither. SOVA_GOLDEN_RECORD=1 records it again.
// A throwaway PI_CODING_AGENT_DIR and workspace; the scripted model only.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { piSession } from "./testing/handle";
import { ScriptedModel, scriptedModelsJson } from "./testing/scripted-model";

for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];
const REPO = resolve(import.meta.dirname, "../../..");
const FIXTURE = join(import.meta.dirname, "golden", "special-model-view.json");
const piDir = realpathSync(join(REPO, "node_modules/@earendil-works/pi-coding-agent"));
const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-special-view-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
writeFileSync(join(agentDir, "models.json"), JSON.stringify(scriptedModelsJson()));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "scripted", defaultModel: "scripted", retry: { baseDelayMs: 1 } }));

await import("../../testing/in-process-chats"); // chats open in this process (the server hosts none)
const { acquireChat, disposeAllChats } = await import("../../chat-manager");
const overseer = await import("../../overseer");
const po = await import("../../project-overseer");
const orgs = await import("../../orgs");
const baton = await import("../../baton");

after(async () => {
  await disposeAllChats();
});

/** Every run-dependent string made fixed: paths, ids, dates and times. */
function fixed(text: string, ids: Record<string, string>): string {
  let t = text;
  for (const [id, name] of Object.entries(ids)) t = t.split(id).join(name);
  return t
    .split(piDir)
    .join("<PI>")
    .split(root)
    .join("<ROOT>")
    .split(REPO)
    .join("<REPO>")
    .split(homedir())
    .join("<HOME>")
    .replace(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g, "<DATE>")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?\b/g, "<TIME>")
    .replace(/\b(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\b/g, "<DAY>")
    // Date#toString: "Mon Oct 12 2026 <TIME> GMT+0000 (Coordinated Universal Time)", any day and zone.
    .replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2} \d{4}\b/g, "<DATE>")
    .replace(/\bGMT[+-]\d{4}(?: \([^)]*\))?/g, "<ZONE>");
}

async function firstRequest(path: string, ids: Record<string, string>): Promise<unknown> {
  const model = new ScriptedModel();
  const chat = await acquireChat(path);
  model.attach(piSession(chat));
  await chat.acceptPrompt("hello", undefined, "server").turn;
  const st = (piSession(chat) as unknown as { agent: { state: Record<string, unknown> } }).agent.state;
  const ctx = { systemPrompt: st.systemPrompt as string | undefined, tools: st.tools as { name: string; description?: string; promptSnippet?: string; promptGuidelines?: string[]; parameters?: unknown }[] | undefined };
  void model.calls;
  return JSON.parse(
    fixed(
      JSON.stringify({
        systemPrompt: ctx.systemPrompt ?? null,
        tools: (ctx.tools ?? []).map((t) => ({ name: t.name, description: t.description, promptSnippet: t.promptSnippet, promptGuidelines: t.promptGuidelines, parameters: t.parameters })),
      }),
      ids,
    ),
  );
}

test("the special loadouts show the model the same system prompt and tools as before they became data", async () => {
  const org = await orgs.createOrg({ name: "View", dir: join(root, "ws") });
  mkdirSync(join(root, "proj"));
  const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
  const tony = await orgs.addPerson(org.id, { name: "Tony", role: "IT" });
  const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Hosting", goal: "Find the server" });
  // The recording predates memory on by default: both overseers run it off here, so the
  // view stays the loadouts' own; with memory on they add `zoom` and `date` (overseer-memory.integration.test.ts).
  const { overseerMemoryOff, projectOverseerMemoryOff } = await import("../../testing/overseer-memory");
  overseerMemoryOff();
  projectOverseerMemoryOff(project.id);
  const ov = await overseer.ensureOverseer();
  const p = await po.ensureProjectOverseer(project.id);
  const ids = { [org.id]: "<ORG>", [project.id]: "<PROJECT>", [tony.id]: "<TONY>", [c.sessionId]: "<BATON>", [ov.id]: "<OVERSEER>", [p.id]: "<PO>" };
  const got = {
    overseer: await firstRequest(ov.path, ids),
    projectOverseer: await firstRequest(p.path, ids),
    baton: await firstRequest(c.path, ids),
  };
  if (process.env.SOVA_GOLDEN_RECORD === "1" || !existsSync(FIXTURE)) {
    writeFileSync(FIXTURE, `${JSON.stringify(got, null, 1)}\n`);
    if (process.env.SOVA_GOLDEN_RECORD !== "1") assert.fail(`recorded ${FIXTURE}: none was there`);
    return;
  }
  const want = JSON.parse(readFileSync(FIXTURE, "utf8"));
  // A difference is written beside the fixture, for a diff by hand.
  if (JSON.stringify(got) !== JSON.stringify(want)) writeFileSync(`${FIXTURE}.actual`, `${JSON.stringify(got, null, 1)}\n`);
  assert.deepEqual(got, want);
});
