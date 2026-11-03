// Run: pnpm test -- server/chat-host-login-context.test.ts
// A project's Claude login as the router hands it to each chat process it launches (§app.claude-logins/project-login):
// the launch's env carries SOVA_CLAUDE_LOGIN_CONTEXT worked out from that process's own folder. One launch serves
// every kind (a chat, the overseer and the Project Assistant open as chats; workers, team members and hidden chats
// start as workers), so this drives the two doors: a chat (in the project, in its worktree, in no project, and
// started again after its process ended) and a worker (in the project, and in no project). A router over a fake
// driver whose units answer as chat-runtime hosts in this process (the harness of server/chat-host-caller-key.test.ts).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { after, test } from "node:test";
import { Hono } from "hono";
import { CHAT_WIRE_MIN_PROTO, CHAT_WIRE_PROTO } from "../shared/chat-runtime-wire";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-chat-host-login-")));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const agentDir = join(tmp, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-chathost-login--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { ChatHostRouter } = await import("./chat-host");
const { ChatRuntimeHost } = await import("./chat-runtime/host");
const { Link } = await import("./chat-runtime/link");
const { FakeDriver } = await import("./chat-runtime/fake-driver");
const { disposeAllChats } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
const { procStart, setProcStartForTest } = await import("./chat-runtime/writer-lock");
const { CallerKeys } = await import("./caller-keys");
const { registerProjectRoutes } = await import("./projects/routes");
const { closeAllOrgHosts } = await import("./org-engine");
const { writeAccounts, loginContextFromEnv, LOGIN_CONTEXT_ENV } = await import("../pi-config/extensions/claude-code/accounts.ts");
setProcStartForTest((pid) => procStart(pid, "linux"));

const hosts: InstanceType<typeof ChatRuntimeHost>[] = [];
after(async () => {
  await Promise.all(hosts.map((h) => h.close("operator", { dispose: true }).catch(() => {})));
  await disposeAllChats();
  closeAllOrgHosts();
});

const A = "l-0000000a", B = "l-0000000b";
const rec = (id: string) => ({ id, addedAt: 1, enabled: true, device: "local", identity: { accountUuid: `acct-${id}`, email: `${id}@example.com` } });
writeAccounts(agentDir, { version: 1, logins: [rec(A), rec(B)], devices: { local: { order: [A, B, "default"] } } });

// Project Acme, with B as its own login (A is first in this device's order, so B is never chosen by accident).
const app = new Hono();
registerProjectRoutes(app);
const acme = join(tmp, "code", "acme");
mkdirSync(acme, { recursive: true });
const elsewhere = join(tmp, "elsewhere");
mkdirSync(elsewhere, { recursive: true });
// A real linked worktree of the project's checkout, where Sova cuts them.
const worktree = join(tmp, "code", ".worktrees", "acme-feat");
const git = (...args: string[]) => execFileSync("git", args, { cwd: acme, stdio: "pipe" });
git("init", "-q", "-b", "main");
writeFileSync(join(acme, "README.md"), "acme\n");
git("add", "README.md");
git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
git("worktree", "add", "-q", worktree, "-b", "feat");
const send = async (method: string, url: string, body?: unknown) => {
  const res = await app.request(url, { method, headers: { "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: (await res.json()) as any };
};
const made = await send("POST", "/api/projects", { root: acme, name: "Acme" });
assert.equal(made.status, 201, JSON.stringify(made.body));
const put = await send("PUT", `/api/projects/${made.body.project.id}/claude-login`, { login: B });
assert.equal(put.status, 200, JSON.stringify(put.body));

let n = 0;
function session(cwd: string): { path: string; id: string } {
  const id = `01a0-login${n}`;
  const path = join(sessionsDir, `2026-10-12T00-00-0${n}-000Z_${id}.jsonl`);
  n++;
  const lines = [
    { type: "session", version: 3, id, timestamp: "2026-10-12T00:00:00.000Z", cwd },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-10-12T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "ask" }] } },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(path, old, old);
  return { path: canonicalPath(path), id };
}

function pair(): [Duplex, Duplex] {
  const ends: Duplex[] = [];
  for (let i = 0; i < 2; i++)
    ends.push(
      new Duplex({
        allowHalfOpen: false,
        read() {},
        write(chunk, _enc, cb) {
          setImmediate(() => ends[1 - i]!.push(chunk));
          cb();
        },
        final(cb) {
          setImmediate(() => ends[1 - i]!.push(null));
          cb();
        },
      }),
    );
  return [ends[0]!, ends[1]!];
}

function setup() {
  const driver = new FakeDriver();
  const dir = mkdtempSync(join(tmp, "sup-"));
  const supervisor = { registryDir: () => join(dir, "registry"), deathsFile: () => join(dir, "deaths.jsonl"), socketPath: (id: string, suffix?: string) => join(dir, `${id}${suffix ?? ""}.sock`), isChatProcess: () => false };
  const bySock = new Map<string, InstanceType<typeof ChatRuntimeHost>>();
  const connect = (async (sock: string, opts: { epoch: number; build: string; since: number | null; settings: never }) => {
    const spec = [...driver.started].reverse().find((s) => s.env.SOVA_CHAT_SOCK === sock);
    if (!spec || !driver.table.has(spec.unit)) throw new Error(`nothing listens on ${sock}`);
    let host = bySock.get(sock);
    if (!host) {
      host = new ChatRuntimeHost({ path: spec.env.SOVA_CHAT_PATH!, sessionId: spec.env.SOVA_CHAT_ID!, unit: spec.unit, build: opts.build, startedAt: 1, exit: () => driver.table.delete(spec.unit), log: () => {}, tickMs: 60_000 });
      bySock.set(sock, host);
      hosts.push(host);
    }
    const [a, b] = pair();
    const runtimeEnd = new Link(a as never, { log: () => {} });
    const link = new Link(b as never, { log: () => {} });
    const hello = { t: "hello" as const, proto: CHAT_WIRE_PROTO, minProto: CHAT_WIRE_MIN_PROTO, epoch: 0, ...host.hello() };
    const h = host;
    setImmediate(() => h.onControl(runtimeEnd, { t: "control", proto: CHAT_WIRE_PROTO, epoch: opts.epoch, serverPid: 1, serverStartedAt: 1, build: opts.build, since: opts.since, settings: opts.settings }));
    return { link, hello };
  }) as never;
  const keys = new CallerKeys(() => join(dir, "caller-keys"));
  const router = new ChatHostRouter(Date.now(), "b1", { driver, connect, supervisor, bun: () => process.execPath, resumeCrashed: () => {}, callerKeys: keys, sweepChildren: async () => [] });
  router.start();
  return { router, driver };
}

/** The context the launch of the chat with id `chatId` (its newest) handed over, as the chat process reads it. */
function handed(driver: InstanceType<typeof FakeDriver>, chatId: string) {
  const spec = [...driver.started].reverse().find((s) => s.env.SOVA_CHAT_ID === chatId);
  assert.ok(spec, `a launch for ${chatId}`);
  return { raw: spec.env[LOGIN_CONTEXT_ENV], ctx: loginContextFromEnv(spec.env) };
}

async function until(ok: () => boolean | Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    if (await ok()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return ok();
}

test("a chat's process gets its project's login from its folder, its worktree's too; a chat in no project gets it only as saved", async () => {
  const t = setup();
  await t.router.ready();
  const inAcme = session(join(acme, "src"));
  mkdirSync(join(acme, "src"), { recursive: true });
  await t.router.acquire(inAcme.path, false);
  assert.deepEqual(handed(t.driver, inAcme.id).ctx, { prefer: { login: B, source: "project", name: "Acme" } });

  const inWorktree = session(worktree);
  await t.router.acquire(inWorktree.path, false);
  assert.equal(handed(t.driver, inWorktree.id).ctx?.prefer?.login, B, "a worktree beside the project is the project's");

  const outside = session(elsewhere);
  await t.router.acquire(outside.path, false);
  assert.deepEqual(handed(t.driver, outside.id).ctx, { saved: [B] }, "no preference; B kept for Acme, a last resort");
  t.router.detach();
});

test("a chat started again after its process ended is handed the project's login again", async () => {
  const t = setup();
  await t.router.ready();
  const s = session(acme);
  await t.router.acquire(s.path, false);
  const first = t.driver.started.filter((x) => x.env.SOVA_CHAT_ID === s.id).length;
  assert.equal(handed(t.driver, s.id).ctx?.prefer?.login, B);
  assert.equal(await t.router.close(s.path, "archived"), true);
  assert.ok(
    await until(async () => {
      await t.router.acquire(s.path, false).catch(() => undefined);
      return t.driver.started.filter((x) => x.env.SOVA_CHAT_ID === s.id).length > first;
    }),
    "a new process for the same chat",
  );
  assert.equal(handed(t.driver, s.id).ctx?.prefer?.login, B, "the new launch carries it too, worked out again");
  t.router.detach();
});

test("a worker's process (workers, team members, hidden chats) gets the login of its own folder; its spec env can't choose one", async () => {
  const t = setup();
  const parent = session(elsewhere);
  const spec = (cwd: string, env: Record<string, string> = {}) => ({ kind: "pi", parent: { sessionId: parent.id, path: parent.path, workerId: `ag_${n}` }, cwd, model: null, thinking: null, builtins: null, extensions: [], flags: {}, appendSystemPrompt: null, env, agentDir: null, lowered: true as const });
  await t.router.workers.start({ key: "key:w1", spec: spec(worktree) as never, session: { new: { dir: join(agentDir, "sessions", "--w1--") } }, task: null });
  const w1 = t.driver.started.at(-1)!;
  assert.deepEqual(loginContextFromEnv(w1.env), { prefer: { login: B, source: "project", name: "Acme" } }, "a worker in the project's worktree");

  await t.router.workers.start({ key: "key:w2", spec: spec(elsewhere, { [LOGIN_CONTEXT_ENV]: JSON.stringify({ prefer: { login: A, source: "project", name: "Forged" } }) }) as never, session: { new: { dir: join(agentDir, "sessions", "--w2--") } }, task: null });
  const w2 = t.driver.started.at(-1)!;
  assert.notEqual(w2.env.SOVA_CHAT_ID, w1.env.SOVA_CHAT_ID);
  assert.deepEqual(loginContextFromEnv(w2.env), { saved: [B] }, "a worker in no project: the router's word, not its loadout's");

  // With no assignment anywhere the router hands nothing over, and a loadout's own variable is dropped all the same.
  assert.equal((await send("PUT", `/api/projects/${made.body.project.id}/claude-login`, { login: "none" })).status, 200);
  try {
    await t.router.workers.start({ key: "key:w3", spec: spec(acme, { [LOGIN_CONTEXT_ENV]: JSON.stringify({ prefer: { login: A, source: "project", name: "Forged" } }) }) as never, session: { new: { dir: join(agentDir, "sessions", "--w3--") } }, task: null });
    const w3 = t.driver.started.at(-1)!;
    assert.notEqual(w3.env.SOVA_CHAT_ID, w2.env.SOVA_CHAT_ID);
    assert.equal(w3.env[LOGIN_CONTEXT_ENV], undefined, "this computer's order");
  } finally {
    assert.equal((await send("PUT", `/api/projects/${made.body.project.id}/claude-login`, { login: B })).status, 200);
  }
  t.router.detach();
});
