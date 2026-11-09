// Run: pnpm test -- server/modes/personal-worker-root.integration.test.ts. What a personal mode's program is told as
// SOVA_PROJECT_ROOT (§chat.mode-menu/personal-modes: "still the chat's checkout"), in a chat and in its worker, from
// real chats in this process on a scripted model, running the real program. A chat process's own working directory
// is Sova's code (supervisor.ts, `workdir ?? REPO_ROOT`), never the chat's: here too, this process runs in this
// repository and the chats run in a checkout of their own, a subfolder of it, so the right root, the wrong one and
// the program's cwd are three different paths. Programs run, hence this tier.
// A throwaway agent dir (harness.fixture); ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Recorded as RecordedChat } from "./tests/harness.fixture";

const { agentDir, beginCase, cm, Recorded, sessionFile, setOwner, workspace } = await import("./tests/harness.fixture");
const { checkoutRootOf } = await import("../../pi-config/extensions/mode/project-discovery.ts");
const { discoverPersonalModes } = await import("./personal");
const { recordApproval } = await import("../project-mode-approvals");
const { discoverProjectModes } = await import("../../pi-config/extensions/mode/project-discovery.ts");

after(async () => {
  await cm.disposeAllChats();
});

const WHERE = 'console.log("root=" + process.env.SOVA_PROJECT_ROOT + " cwd=" + process.cwd());\n';
const modeFile = (id: string) =>
  `---\ndescription: Where am I\nworkers: yes\ntools: [{"name": "where", "description": "Print the project root.", "params": {"type": "object", "properties": {}}, "command": ["node", "./where.mjs"]}]\n---\nUse ${id}__where.\n`;

// A personal mode, approved once for every project.
const personal = join(agentDir, "sova", "minor-modes", "tidy");
mkdirSync(personal, { recursive: true });
writeFileSync(join(personal, "MODE.md"), modeFile("tidy"));
writeFileSync(join(personal, "where.mjs"), WHERE);
const listed = discoverPersonalModes();
assert.deepEqual(listed.problems, [], "the personal mode reads");
recordApproval(listed.root!, "tidy", listed.modes.find((m) => m.id === "tidy")!.toolsHash, "user");

interface Start {
  spec: { cwd: string; env: Record<string, string> };
  session: { new?: { dir: string } };
  task: string | null;
}
const starts: Start[] = [];
cm.setWorkerHostSource(
  () =>
    ({
      async start(req: Start) {
        starts.push(req);
        const n = starts.length;
        return { chatId: `w${n}`, sessionId: `w${n}`, sessionFile: "", workerId: `ag_0${n}`, kind: "worker", pid: null, state: "open" };
      },
      async send() {
        return { queued: false };
      },
      async abort() {},
      async stop() {},
      watch: () => () => {},
      async list() {
        return [];
      },
    }) as never,
);

/** A checkout of its own with a project mode, and the subfolder its chats run in. */
function checkout(name: string): { root: string; cwd: string; dir: string } {
  const w = workspace(name, { git: true, files: { "sub/keep.txt": "x\n", ".sova/minor-modes/rel/MODE.md": modeFile("rel"), ".sova/minor-modes/rel/where.mjs": WHERE } });
  const cwd = join(w.cwd, "sub");
  assert.equal(checkoutRootOf(cwd), w.cwd, "the chat's folder sits in the checkout");
  assert.notEqual(checkoutRootOf(process.cwd()), w.cwd, "the process's checkout and the chat's differ: the right and wrong roots collide with nothing");
  return { root: w.cwd, cwd, dir: w.dir };
}

const toolOutput = (r: RecordedChat): string => {
  const messages = (r.model.calls.at(-1)!.context as { messages: { role?: string; content?: { text?: string }[] }[] }).messages;
  const result = messages.filter((m) => m.role === "toolResult").at(-1);
  assert.ok(result, "the tool ran and its result reached the model");
  return (result.content ?? []).map((c) => c.text ?? "").join("");
};
const callWhere = async (r: RecordedChat, tool: string): Promise<string> => {
  await r.prompt("where", { toolCall: { name: tool, arguments: {} } }, { text: "ok" });
  return toolOutput(r);
};
const said = (output: string, field: "root" | "cwd"): string => new RegExp(`${field}=(\\S+)`).exec(output)?.[1] ?? `(no ${field} in ${JSON.stringify(output)})`;

/** The parent's own call of `tool`, then the same tool in a worker it spawns, in the worker's own session. */
async function parentAndWorker(tag: string, c: { cwd: string; dir: string }, modeId: string): Promise<{ parent: string; worker: string }> {
  const tool = `${modeId}__where`;
  const from = starts.length;
  const r = await Recorded.open(sessionFile({ cwd: c.cwd, dir: c.dir }));
  let parent: string;
  try {
    await r.switch({ projectModes: [modeId] });
    parent = await callWhere(r, tool);
    await r.prompt("spawn", { toolCall: { name: "agent_spawn", arguments: { prompt: "do the task", name: `w-${tag}`, model: "scripted/scripted" } } }, { text: "ok" });
  } finally {
    await r.dispose();
  }
  assert.equal(starts.length, from + 1, `one worker start (${toolOutput(r)})`);
  const start = starts.at(-1)!;
  assert.equal(start.spec.cwd, c.cwd, "the worker runs where its parent does");
  const dir = start.session.new!.dir;
  mkdirSync(dir, { recursive: true });
  const path = sessionFile({ cwd: start.spec.cwd, dir });
  cm.setWorkerSpec(path, start.spec as never);
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(start.spec.env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const w = await Recorded.open(path, { worker: true });
    try {
      return { parent, worker: await callWhere(w, tool) };
    } finally {
      await w.dispose();
      cm.setWorkerSpec(path, null);
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("a personal mode's tool is told the chat's checkout, in the chat and in its worker, whatever the process's own folder", async () => {
  setOwner("sova");
  beginCase("personal-on");
  const c = checkout("personal");
  const { parent, worker } = await parentAndWorker("personal", c, "tidy");
  assert.equal(said(parent, "cwd"), c.cwd, "the chat's program runs in the chat's folder");
  assert.equal(said(parent, "root"), c.root, "the chat's program is told the chat's checkout");
  assert.equal(said(worker, "cwd"), c.cwd, "the worker's program runs in the worker's folder");
  assert.equal(said(worker, "root"), c.root, "the worker's program is told the worker's checkout, as its parent's is");
});

for (const owner of ["sova", "extension"] as const) {
  test(`a project mode's tool is told the checkout it sits in, in the chat and in its worker (the switch ${owner === "sova" ? "on" : "off"})`, async () => {
    setOwner(owner);
    beginCase(`project-${owner}`);
    const c = checkout("project");
    const listing = discoverProjectModes(c.cwd);
    recordApproval(listing.root!, "rel", listing.modes.find((m) => m.id === "rel")!.toolsHash, "user");
    const { parent, worker } = await parentAndWorker(`project-${owner}`, c, "rel");
    assert.equal(said(parent, "root"), c.root);
    assert.equal(said(worker, "root"), c.root);
    assert.equal(said(worker, "cwd"), c.cwd);
  });
}
