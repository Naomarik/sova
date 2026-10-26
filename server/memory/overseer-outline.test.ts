// GET /api/memory for an overseer's conversation no one holds (the cold outline): its memory is its own switch, not a
// mode it never has. No saved choice reads on, UniiChat at Settings' size (128 KB); a saved off reads off. Nothing is opened.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import type { DelegateSources } from "../delegate";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-overseer-outline-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

await import("../testing/in-process-chats"); // chats would open in this process; none is opened here
const orgs = await import("../orgs");
const po = await import("../project-overseer");
const store = await import("../project-overseer-store");
const overseer = await import("../overseer");
const { readOverseerSettings, writeOverseerSettings } = await import("../overseer-store");
const { readBranch } = await import("../harness/pi/reader");
const { registerMemoryRoutes } = await import("./routes");
const { settled } = await import("../workspace-git");

after(async () => {
  await settled(join(root, "ws"));
  rmSync(root, { recursive: true, force: true });
});

const sources: DelegateSources = { piModels: async () => [], claudeModels: async () => [], policy: () => ({ disabledProviders: [], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: [] }) };
const app = new Hono();
registerMemoryRoutes(app, { resolvePath: (raw) => raw ?? null, held: () => undefined, overseer: () => undefined, readBranch, sources });
const outline = async (path: string) => {
  const r = await app.request(`/api/memory?path=${encodeURIComponent(path)}`);
  assert.equal(r.status, 200);
  return (await r.json()) as { on: boolean; type: string; size: number; status: { state: string } };
};

describe("an overseer's outline, nothing holding it", async () => {
  const org = await orgs.createOrg({ name: "Outline", dir: join(root, "ws") });
  mkdirSync(join(root, "proj"));
  const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });

  test("a project overseer with no saved memory: on, UniiChat at 128 KB; saved off: off", async () => {
    const p = store.projectOverseerPaths(project.id);
    assert.equal(store.readPoSettings(p).memory, undefined, "no saved choice");
    const { path } = await po.ensureProjectOverseer(project.id);
    const on = await outline(path);
    assert.deepEqual([on.on, on.type, on.size], [true, "uniichat", 128]);
    assert.notEqual(on.status.state, "off");
    store.writePoSettings(p, { ...store.readPoSettings(p), memory: { on: false, type: "zoomable", size: 64 } });
    const off = await outline(path);
    assert.deepEqual([off.on, off.type, off.size, off.status.state], [false, "zoomable", 32, "off"], "the stored 64 is ignored: Settings' zoomable size");
  });

  test("the main Overseer with no saved memory: on", async () => {
    const { memory: _m, ...rest } = readOverseerSettings();
    writeOverseerSettings(rest);
    const { path } = await overseer.ensureOverseer();
    const r = await outline(path);
    assert.deepEqual([r.on, r.type, r.size], [true, "uniichat", 128]);
  });
});
