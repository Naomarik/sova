// Run: pnpm test:int -- server/project-skills-processes.integration.test.ts. A project's skill defaults
// reaching a new chat that runs in a process of its own: the whole server on an ephemeral port in a
// throwaway PI_CODING_AGENT_DIR (~/.pi is never read or written), a registered project, and a raw chat
// socket that opens the chat. The chat's very first build already leaves out the project's disallowed
// skill (the server hands the list over with the open: the build can't ask it mid-open), and a save of
// the defaults answers only once that not-yet-started chat was rebuilt, so the card's next read shows it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import type { SessionSetup } from "../shared/protocol";

for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-psk-proc-")));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const agentDir = join(tmp, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PORT = "0";
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const dist = join(tmp, "dist");
mkdirSync(dist);
writeFileSync(join(dist, "index.html"), "<!doctype html><title>stub</title>");
const root = join(tmp, "proj");
for (const name of ["keep-skill", "block-skill"]) {
  mkdirSync(join(root, ".agents", "skills", name), { recursive: true });
  writeFileSync(join(root, ".agents", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} recipe.\n---\n\nbody\n`);
}

const { server } = await import("./index");
const { sovaToken, TOKEN_HEADER } = await import("./auth");
const { canonicalPath } = await import("./paths");

let host = "";
const headers = () => ({ [TOKEN_HEADER]: sovaToken(), "content-type": "application/json" });
const sockets: WebSocket[] = [];

before(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  host = `127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  for (const ws of sockets) ws.close();
  server.close();
});

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://${host}${path}`, { method, headers: headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  assert.ok(res.ok, `${method} ${path}: ${res.status} ${text}`);
  return JSON.parse(text);
};

/** A new session's file in the project: its header only, as New Session makes it. */
let sessions = 0;
function newSession(cwd = root): string {
  const dir = join(agentDir, "sessions", "--proj--");
  mkdirSync(dir, { recursive: true });
  const n = ++sessions;
  const id = `01a5c222-0000-7000-8000-${String(n).padStart(12, "0")}`;
  const file = join(dir, `2026-11-11T00-00-${String(n).padStart(2, "0")}-000Z_${id}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-11T00:00:00.000Z", cwd })}\n`);
  return canonicalPath(file);
}

/** Opens the chat (its process, its runtime) and resolves at its hello. */
function openChat(path: string): Promise<void> {
  const ws = new WebSocket(`ws://${host}/ws/chat?path=${encodeURIComponent(path)}&force=1`, { headers: { [TOKEN_HEADER]: sovaToken() } });
  sockets.push(ws);
  return new Promise((done, fail) => {
    const t = setTimeout(() => fail(new Error("no hello")), 60_000);
    ws.on("message", (d) => {
      if (JSON.parse(String(d)).type === "hello") {
        clearTimeout(t);
        done();
      }
    });
    ws.on("error", fail);
  });
}

const offOf = async (path: string) => {
  const s = (await api("GET", `/api/sessions/context?path=${encodeURIComponent(path)}&fresh=1`)) as SessionSetup;
  assert.equal(s.state, "ok", JSON.stringify(s));
  const ok = s as Extract<SessionSetup, { state: "ok" }>;
  assert.equal(ok.fromRuntime, true, "read from the chat's own runtime");
  return Object.fromEntries(ok.skills.filter((k) => k.name.endsWith("-skill")).map((k) => [k.name, { off: !!k.off, project: k.approval?.state }]));
};

test("a new chat in its own process starts without the project's disallowed skill, and a save answers after its rebuild", async () => {
  const { project } = await api("POST", "/api/projects", { root });
  await api("PUT", `/api/projects/${project.id}/skills`, { skills: { "block-skill": "disallowed" } });
  const path = newSession();
  await openChat(path);
  assert.deepEqual(await offOf(path), { "block-skill": { off: true, project: "disallowed" }, "keep-skill": { off: false, project: "waiting" } }, "its first build");
  await api("PUT", `/api/projects/${project.id}/skills`, { skills: { "keep-skill": "disallowed" } });
  assert.deepEqual(await offOf(path), { "block-skill": { off: true, project: "disallowed" }, "keep-skill": { off: true, project: "disallowed" } }, "the read right after the save");
});

/** The `sova-loadout` entries in a session file, oldest first. */
const loadoutEntries = async (path: string) => {
  const { LOADOUT_ENTRY } = await import("./session-loadout");
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "custom" && e.customType === LOADOUT_ENTRY)
    .map((e) => e.data as { asking?: true; onlySkills?: string[] });
};
const stampOf = async (path: string) => {
  for (let i = 0; i < 1500; i++) {
    const e = (await loadoutEntries(path)).at(-1);
    if (e) return e;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail("no stamp: the first message never went in");
};

/** A page's socket on a new chat; its frames as they come, and its hello. */
async function pageSocket(path: string) {
  const { pageHeaders } = await import("./testing/page");
  const page = new WebSocket(`ws://${host}/ws/chat?path=${encodeURIComponent(path)}&force=1`, { headers: pageHeaders() });
  sockets.push(page);
  const frames: Record<string, unknown>[] = [];
  page.on("message", (d) => void frames.push(JSON.parse(String(d)) as Record<string, unknown>));
  return { page, frames };
}

test("asking first: nothing waits, and a page's first message into a chat built on an older list rebuilds it in its own process first", async () => {
  const { setAllowWithoutAsking } = await import("./context-approval-setting");
  const { notifySetupChanged } = await import("./projects/skills-chats");
  const store = await import("./project-skills-store");
  setAllowWithoutAsking(false);
  await notifySetupChanged(null);
  try {
    // A folder that isn't a project, nothing decided in it.
    const folder = join(tmp, "adhoc");
    const skill = join(folder, ".agents", "skills", "wait-skill", "SKILL.md");
    mkdirSync(dirname(skill), { recursive: true });
    writeFileSync(skill, "---\nname: wait-skill\ndescription: Waits.\n---\n\nbody\n");
    writeFileSync(join(folder, "AGENTS.md"), "RULES\n");
    const path = newSession(folder);
    const { page, frames } = await pageSocket(path);
    await new Promise<void>((done, fail) => {
      const t = setTimeout(() => fail(new Error("no hello")), 60_000);
      const look = () => (frames.some((f) => f.type === "hello") ? (clearTimeout(t), done()) : setTimeout(look, 20));
      look();
    });
    // Turned on after the chat was built, with no rebuild of it (the quick first send's window).
    store.setDecisions(`d:${folder}`, "skills", { ".agents/skills/wait-skill/SKILL.md": { state: "approved", sha256: "0".repeat(64), name: "wait-skill" } });
    page.send(JSON.stringify({ type: "prompt", text: "hello", clientId: "c1" }));
    const stamp = await stampOf(path);
    assert.equal(stamp.asking, true);
    assert.deepEqual(stamp.onlySkills, [skill], "it went in on the list as saved, not the one it was built with");
    assert.equal(frames.find((f) => f.type === "error" && (f as { decide?: unknown }).decide !== undefined), undefined, "nothing held it");
  } finally {
    setAllowWithoutAsking(true);
    await notifySetupChanged(null);
  }
});

test("asking first: a page's first message sent before the chat has opened goes in, with the waiting skill off", async () => {
  const { setAllowWithoutAsking } = await import("./context-approval-setting");
  const { notifySetupChanged } = await import("./projects/skills-chats");
  setAllowWithoutAsking(false);
  await notifySetupChanged(null);
  try {
    const folder = join(tmp, "adhoc-early");
    mkdirSync(join(folder, ".agents", "skills", "early-skill"), { recursive: true });
    writeFileSync(join(folder, ".agents", "skills", "early-skill", "SKILL.md"), "---\nname: early-skill\ndescription: Waits.\n---\n\nbody\n");
    const path = newSession(folder);
    const { page } = await pageSocket(path);
    // Sent the moment the socket opens: the chat's process is still starting (send-while-starting).
    await new Promise<void>((done, fail) => {
      page.once("open", () => {
        page.send(JSON.stringify({ type: "prompt", text: "early", clientId: "e1" }));
        done();
      });
      page.once("error", fail);
    });
    const stamp = await stampOf(path);
    assert.deepEqual([stamp.asking, stamp.onlySkills], [true, []]);
  } finally {
    setAllowWithoutAsking(true);
    await notifySetupChanged(null);
  }
});
