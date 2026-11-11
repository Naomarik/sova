// Run: pnpm test:int -- server/project-skills-processes.integration.test.ts. A project's skill defaults
// reaching a new chat that runs in a process of its own: the whole server on an ephemeral port in a
// throwaway PI_CODING_AGENT_DIR (~/.pi is never read or written), a registered project, and a raw chat
// socket that opens the chat. The chat's very first build already leaves out the project's disallowed
// skill (the server hands the list over with the open: the build can't ask it mid-open), and a save of
// the defaults answers only once that not-yet-started chat was rebuilt, so the card's next read shows it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
function newSession(): string {
  const dir = join(agentDir, "sessions", "--proj--");
  mkdirSync(dir, { recursive: true });
  const id = "01a5c222-0000-7000-8000-000000000001";
  const file = join(dir, `2026-11-11T00-00-01-000Z_${id}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-11T00:00:00.000Z", cwd: root })}\n`);
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
  return Object.fromEntries(ok.skills.filter((k) => k.name.endsWith("-skill")).map((k) => [k.name, { off: !!k.off, project: k.project }]));
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
