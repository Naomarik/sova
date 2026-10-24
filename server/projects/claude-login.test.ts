// Run: pnpm test -- server/projects/claude-login.test.ts. A project's, or an organization's, own Claude login
// (§app.claude-logins/project-login): the routes, the host-local store, what a chat in a folder is handed, who uses
// which login, and a removed login's assignments going back to No preference. A throwaway PI_CODING_AGENT_DIR.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";
import { linkPiConfigExtensions } from "../testing/agent-dir";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-project-login-")));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const agentDir = join(tmp, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
linkPiConfigExtensions(agentDir);

const { registerProjectRoutes } = await import("./routes");
const { registerOrgRoutes } = await import("../org-routes");
const { closeAllOrgHosts } = await import("../org-engine");
const { createOrg, addProject } = await import("../orgs");
const { loginContextForCwd } = await import("./claude-login");
const { assignmentsPath, loginUsedBy } = await import("../claude-login-store");
const { writeAccounts, ClaudeLogins, LOGIN_CONTEXT_ENV, loginContextFromEnv } = await import("../../pi-config/extensions/claude-code/accounts.ts");
const { ClaudeAccountsService } = await import("../claude-accounts");
const { chatClaudeLogin } = await import("../claude-login-state");
const { loginContextEnv } = await import("../claude-login-context");
const { chatEnv, CHAT_PROCESS_ENV } = await import("../chat-runtime/supervisor");
after(() => closeAllOrgHosts());

const app = new Hono();
registerProjectRoutes(app);
registerOrgRoutes(app);
const send = async (method: string, url: string, body?: unknown) => {
  const res = await app.request(url, { method, headers: { "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const { options, ...answer } = (await res.json()) as Record<string, any>;
  return { status: res.status, body: answer as any, options: options as { id: string; name: string }[] | undefined };
};

const A = "l-0000000a", B = "l-0000000b", C = "l-0000000c";
const rec = (id: string) => ({ id, addedAt: 1, enabled: true, device: "local", identity: { accountUuid: `acct-${id}`, email: `${id}@example.com` } });
writeAccounts(agentDir, { version: 1, logins: [rec(A), rec(B), rec(C)], devices: { local: { order: [A, B, C, "default"] } } });

/** Every file under `dir` (its .git included) whose bytes name `text`. */
function filesNaming(dir: string, text: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesNaming(p, text));
    else if (readFileSync(p).includes(text)) out.push(p);
  }
  return out;
}

async function standalone(name: string): Promise<{ id: string; root: string }> {
  const root = join(tmp, "code", name);
  mkdirSync(root, { recursive: true });
  const r = await send("POST", "/api/projects", { root, name });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { id: r.body.project.id, root: r.body.project.root };
}

test("a standalone project: No preference by default, its own login saved host-local, handed to chats in its folder and worktrees", async () => {
  const acme = await standalone("acme");
  const other = await standalone("other");
  const first = await send("GET", `/api/projects/${acme.id}/claude-login`);
  assert.deepEqual(first.body, { setting: "none", placed: false, resolved: null });
  assert.deepEqual(first.options, [{ id: "default", name: "This computer's own login" }, { id: A, name: `${A}@example.com` }, { id: B, name: `${B}@example.com` }, { id: C, name: `${C}@example.com` }], "the logins of the host that holds it");
  assert.equal(loginContextForCwd(acme.root), undefined, "no assignment anywhere: nothing is handed over");
  assert.deepEqual(loginContextEnv(acme.root), {});

  assert.equal((await send("PUT", `/api/projects/${acme.id}/claude-login`, { login: "org" })).status, 400, "Same as organization only while placed");
  assert.equal((await send("PUT", `/api/projects/${acme.id}/claude-login`, { login: "l-0000dead" })).status, 400, "a login not on this computer");
  assert.equal((await send("PUT", `/api/projects/${acme.id}/claude-login`, {})).status, 400);
  const put = await send("PUT", `/api/projects/${acme.id}/claude-login`, { login: A });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body, { setting: A, placed: false, resolved: { login: A, source: "project", name: "acme" } });
  assert.ok(existsSync(assignmentsPath()), "kept in the state root");
  assert.deepEqual(JSON.parse(readFileSync(assignmentsPath(), "utf8")).projects, { [acme.id]: A });

  const inside = join(acme.root, "src");
  mkdirSync(inside, { recursive: true });
  assert.deepEqual(loginContextForCwd(inside), { prefer: { login: A, source: "project", name: "acme" } });
  // A worktree folder as Sova names them, beside the root (gone or not yet made): the project's too.
  assert.equal(loginContextForCwd(join(tmp, "code", ".worktrees", "acme-feat"))?.prefer?.login, A);
  assert.deepEqual(loginContextForCwd(other.root), { saved: [A] }, "another project's chat leaves A as a last resort");
  assert.deepEqual(loginContextForCwd(join(tmp, "elsewhere")), { saved: [A] }, "so does a chat in no project");

  // The chat process gets it through its own variable, which a server never passes on.
  const env = loginContextEnv(inside);
  assert.deepEqual(loginContextFromEnv(env), { prefer: { login: A, source: "project", name: "acme" } });
  assert.ok((CHAT_PROCESS_ENV as readonly string[]).includes(LOGIN_CONTEXT_ENV));
  assert.equal(chatEnv({ serverEnv: { ...env, PATH: "/usr/bin" }, bun: "/x/bun", home: "/h", agentDir })[LOGIN_CONTEXT_ENV], undefined, "an inherited one is dropped");

  // The composer's label before the first record: the project's login, and where it comes from.
  const logins = new ClaudeLogins({ agentDir, env: { PI_CODING_AGENT_DIR: agentDir } });
  const shown = chatClaudeLogin([], logins, { cwd: inside, poolOthers: () => 0 });
  assert.equal(shown?.id, A);
  assert.equal(shown?.source, "project");
  assert.equal(shown?.recorded, false);
  const elsewhere = chatClaudeLogin([], logins, { cwd: join(tmp, "elsewhere"), poolOthers: () => 0 });
  assert.equal(elsewhere?.id, B, "outside the project A is saved: the next login shows");
  assert.equal(elsewhere?.source, undefined);
  const recorded = chatClaudeLogin([{ type: "custom", customType: "claude-login", data: { v: 1, login: C } }], logins, { cwd: inside, poolOthers: () => 0 });
  assert.equal(recorded?.id, C, "an open chat keeps its recorded login");
  assert.equal(recorded?.source, undefined);

  assert.deepEqual(loginUsedBy()[A], ["Project acme"]);
  // Back to No preference: the entry goes.
  await send("PUT", `/api/projects/${acme.id}/claude-login`, { login: "none" });
  assert.equal(loginContextForCwd(inside), undefined);
});

test("a placed project follows its organization unless it picks its own; archived projects claim nothing", async () => {
  const org = await createOrg({ name: "Fold", dir: join(tmp, "orgs", "fold") });
  const root = join(tmp, "code", "placed");
  mkdirSync(root, { recursive: true });
  const p = await addProject(org.id, { name: "Placed", root });
  assert.deepEqual((await send("GET", `/api/projects/${p.id}/claude-login`)).body, { setting: "org", placed: true, orgLogin: null, resolved: null });
  assert.deepEqual((await send("GET", `/api/orgs/${org.id}/claude-login`)).body, { setting: "none" });
  assert.equal((await send("PUT", `/api/orgs/${org.id}/claude-login`, { login: "org" })).status, 400);
  assert.equal((await send("PUT", `/api/orgs/no-such-org/claude-login`, { login: B })).status, 404);
  assert.deepEqual((await send("PUT", `/api/orgs/${org.id}/claude-login`, { login: B })).body, { setting: B });
  assert.deepEqual((await send("GET", `/api/projects/${p.id}/claude-login`)).body.resolved, { login: B, source: "org", name: "Fold" });
  assert.deepEqual(loginContextForCwd(root)?.prefer, { login: B, source: "org", name: "Fold" });
  assert.deepEqual(filesNaming(join(tmp, "orgs", "fold"), B), [], "never in the workspace repo");
  assert.deepEqual(loginUsedBy()[B], ["Organization Fold"]);

  // Its own pick wins; "none" is kept explicitly (it would otherwise follow the org).
  await send("PUT", `/api/projects/${p.id}/claude-login`, { login: C });
  assert.deepEqual(loginContextForCwd(root)?.prefer, { login: C, source: "project", name: "Placed" });
  await send("PUT", `/api/projects/${p.id}/claude-login`, { login: "none" });
  assert.equal((await send("GET", `/api/projects/${p.id}/claude-login`)).body.setting, "none");
  assert.equal(loginContextForCwd(root)?.prefer, undefined);
  await send("PUT", `/api/projects/${p.id}/claude-login`, { login: "org" });
  assert.equal(loginContextForCwd(root)?.prefer?.login, B);

  // This computer's own login can be a project's too.
  await send("PUT", `/api/projects/${p.id}/claude-login`, { login: "default" });
  assert.deepEqual(loginContextForCwd(root)?.prefer, { login: "default", source: "project", name: "Placed" });
  await send("PUT", `/api/projects/${p.id}/claude-login`, { login: "org" });

  const arch = await send("POST", `/api/projects/${p.id}/archive`, {});
  assert.equal(arch.status, 200, JSON.stringify(arch.body));
  assert.equal(loginContextForCwd(root), undefined, "an archived project: as today");
  await send("POST", `/api/projects/${p.id}/unarchive`, {});
});

test("removing a login warns through usedBy, and sends its projects and organizations back to No preference", async () => {
  const org = await createOrg({ name: "Tidy", dir: join(tmp, "orgs", "tidy") });
  const root = join(tmp, "code", "tidy-app");
  mkdirSync(root, { recursive: true });
  const p = await addProject(org.id, { name: "Tidy App", root });
  const solo = await standalone("solo");
  await send("PUT", `/api/orgs/${org.id}/claude-login`, { login: C });
  await send("PUT", `/api/projects/${solo.id}/claude-login`, { login: C });
  const service = new ClaudeAccountsService({ agentDir, executable: "/bin/false", pool: () => null });
  assert.deepEqual(service.info().usedBy?.[C]?.sort(), ["Organization Tidy", "Project solo"]);
  const removed = await service.remove(C);
  assert.equal(removed.status, 200);
  assert.equal((await send("GET", `/api/projects/${solo.id}/claude-login`)).body.setting, "none");
  assert.equal((await send("GET", `/api/orgs/${org.id}/claude-login`)).body.setting, "none");
  assert.equal((await send("GET", `/api/projects/${p.id}/claude-login`)).body.resolved, null);
  assert.equal(service.info().usedBy?.[C], undefined);
});
