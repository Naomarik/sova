// Tests: outreach's world for outreach.test.ts and outreach.integration.test.ts. A throwaway
// PI_CODING_AGENT_DIR, an organisation with a project and three people (Ann on WhatsApp, Bob with
// no number, Gil whose number isn't on WhatsApp), and the org and outreach routes on one app.
// Import it first: it sets the environment before the server's modules read it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

export const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-outreach-")));
export const agent = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agent;
delete process.env.SOVA_WA_SOCKET;
delete process.env.SOVA_WA_HOME;
process.env.SOVA_SHARE_PUBLIC_URL = "https://share.example.com";
process.env.SOVA_SHARE_PREVIEW_URL = "https://*.preview.example.com";
mkdirSync(join(agent, "sessions"), { recursive: true });

const orgs = await import("./orgs");
const { registerOrgRoutes } = await import("./org-routes");
const { mountOutreach } = await import("./outreach/routes");
const { readSendLog } = await import("./outreach/log");
const { disposeAllChats } = await import("./chat-manager");
const { setSystemctlForTest } = await import("./outreach/unit");

/** No systemd here: an unreachable sender offers no Start Sender, and nothing is spawned. */
export const noSystemd = () => setSystemctlForTest(async () => ({ code: 1, stdout: "" }));
noSystemd();

/** Gil's number: the sender says it isn't on WhatsApp. */
export const ABSENT = "15550000999";
/** The sender's socket where the setting { local: {} } looks for it. */
export const socket = join(agent, "sova", "whatsapp", "sender.sock");

export const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
export const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
export const ann = await orgs.addPerson(org.id, { name: "Ann", role: "Staff", contact: { whatsapp: "+1 555 000 0100" } });
export const bob = await orgs.addPerson(org.id, { name: "Bob", role: "Staff" });
export const gone = await orgs.addPerson(org.id, { name: "Gil", role: "Staff", contact: { whatsapp: "+1 555 000 0999" } });

export const app = new Hono();
registerOrgRoutes(app);
mountOutreach(app);
const req = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
export const json = async (method: string, path: string, body?: unknown) => {
  const r = await req(method, path, body);
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

export async function gathering(to: string): Promise<string> {
  const r = await json("POST", "/api/baton", { orgId: org.id, projectId: project.id, to, publicTitle: "Office hours", goal: "g" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.sessionId as string;
}
export const sendLink = (sid: string, person?: string) => json("POST", `/api/baton/${sid}/send-link`, person ? { person } : {});
export const logOf = () => readSendLog(org.id);

/** Polls the outreach status until the sender reads open; the limit is only a hang guard. */
export async function senderOpen(ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  let info = await json("GET", "/api/outreach");
  while (info.body.sender.state !== "open" && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 20));
    info = await json("GET", "/api/outreach");
  }
  assert.equal(info.body.sender.state, "open", JSON.stringify(info.body.sender));
}

/** For after(): the chats the overseer started, and the throwaway directory. */
export async function cleanup(): Promise<void> {
  await disposeAllChats();
  rmSync(root, { recursive: true, force: true });
}
