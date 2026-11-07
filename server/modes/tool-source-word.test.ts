// Run: pnpm test -- server/modes/tool-source-word.test.ts. The word the setup card's Tools group draws beside a tool
// (GET /api/sessions/tools through src/lib/session-tools.ts sourceWord), read from real chats and a real worker on a
// scripted model with the switch off and on (§chat.mode-menu/sova-runs-modes: who runs the modes is not the user's
// tool list's business). Which module fills the mode slot never shows: the same tools, the same words.
// A throwaway agent dir (harness.fixture); ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { after, test } from "node:test";

const { beginCase, cm, Recorded, sessionFile, setOwner, workspace } = await import("./tests/harness.fixture");
const { getSessionTools } = await import("../session-tools");
const { sourceWord } = await import("../../src/lib/session-tools");
const { discoverProjectModes } = await import("../../pi-config/extensions/mode/project-discovery.ts");
const { recordApproval } = await import("../project-mode-approvals");

after(async () => {
  await cm.disposeAllChats();
});

interface Start {
  spec: { cwd: string; env: Record<string, string> };
  session: { new?: { dir: string } };
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

const MODE = '---\ndescription: Release status\nworkers: yes\ntools: [{"name": "status", "description": "Print the status.", "params": {"type": "object", "properties": {}}, "command": ["node", "./status.mjs"]}]\n---\nUse rel__status.\n';

/** Every declared tool's word, from what the page is handed. */
async function words(path: string): Promise<Record<string, string>> {
  const answer = await getSessionTools(path, { summary: async () => ({}) as never });
  assert.equal(answer.state, "ok", JSON.stringify(answer));
  if (answer.state !== "ok") return {};
  return Object.fromEntries(answer.tools.map((t) => [t.name, sourceWord(t)]));
}

/** What one owner's chat, across the modes that bring tools, and its worker show. */
async function shown(owner: "extension" | "sova"): Promise<{ chat: Record<string, string>; worker: Record<string, string> }> {
  setOwner(owner);
  beginCase(`words-${owner}`);
  const w = workspace("rel", { git: true, files: { ".sova/minor-modes/rel/MODE.md": MODE, ".sova/minor-modes/rel/status.mjs": "console.log(1);\n" } });
  const listing = discoverProjectModes(w.cwd);
  recordApproval(listing.root!, "rel", listing.modes.find((m) => m.id === "rel")!.toolsHash, "user");
  const chat: Record<string, string> = {};
  const r = await Recorded.open(sessionFile(w));
  let worker: Record<string, string> = {};
  try {
    await r.switch({ minorModes: ["align", "vis"], projectModes: ["rel"] });
    Object.assign(chat, await words(r.path));
    await r.switch({ mode: "create" });
    Object.assign(chat, await words(r.path));
    await r.switch({ mode: "normal" });
    await r.prompt("spawn", { toolCall: { name: "agent_spawn", arguments: { prompt: "t", name: `w-${owner}`, model: "scripted/scripted" } } }, { text: "ok" });
  } finally {
    await r.dispose();
  }
  const start = starts.at(-1)!;
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
    const wr = await Recorded.open(path, { worker: true });
    try {
      worker = await words(path);
    } finally {
      await wr.dispose();
      cm.setWorkerSpec(path, null);
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return { chat, worker };
}

test("a mode's tools carry the same word with the switch on as off, in a chat and in its worker", async () => {
  const off = await shown("extension");
  const on = await shown("sova");
  for (const name of ["align", "vis_guide", "create_guide", "rel__status"]) assert.ok(name in off.chat, `${name} is listed with the switch off (${Object.keys(off.chat).join(", ")})`);
  assert.equal(on.chat.align, "mode", "the word the mode's tool has always had");
  assert.deepEqual(on.chat, off.chat);
  assert.ok("rel__status" in off.worker, `the worker's project tool is listed (${Object.keys(off.worker).join(", ")})`);
  assert.deepEqual(on.worker, off.worker);
});
