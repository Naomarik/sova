// Run: pnpm test:int -- server/extension-loader.integration.test.ts
// §app.extensions/loader and /program, end to end: a whole server as a child process in a throwaway state root,
// a stand-in extension in a plain folder, and the page's cookie. Through both drivers where the host has both:
// install, the key, logging that never asks again, a crash, Turn Off and On, changed code, a restart of the
// server with its program still running, Waiting for You, Remove and an entry leaving by hand.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { authCookieName } from "./auth";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sova-ext-loader-int-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

const PROGRAM = `
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
setInterval(() => { console.log("tick"); appendFileSync(new URL("./running.log", import.meta.url), "tick\\n"); appendFileSync(process.env.SOVA_EXTENSION_DATA_DIR + "/data.txt", "tick\\n"); }, 200);
createServer((req, res) => {
  if (req.url === "/api/health") return res.end("{}");
  if (req.url === "/api/env") return res.end(JSON.stringify({ pid: process.pid, keyFile: process.env.SOVA_EXTENSION_KEY_FILE, data: process.env.SOVA_EXTENSION_DATA_DIR, url: process.env.SOVA_URL, token: process.env.SOVA_TOKEN ?? null }));
  if (req.url === "/api/die") { res.end("{}"); setTimeout(() => process.exit(3), 20); return; }
  res.statusCode = 404; res.end("{}");
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

const until = async <T>(what: string, fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 30_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve().then(fn).catch((e: unknown) => e as T);
    if (ok(v)) return v;
    if (Date.now() > end) assert.fail(`${what}: never; last ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

const available = (() => {
  try {
    execFileSync("systemctl", ["--user", "show", "--property=Version"], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
})();

function rig(name: string, driverEnv: Record<string, string>) {
  const dir = join(scratch, name);
  const agent = join(dir, "agent");
  mkdirSync(join(agent, "sessions", "live"), { recursive: true });
  let child: ChildProcess | null = null;
  let base = "";
  const boot = async () => {
    const out: string[] = [];
    const { SOVA_EXTENSIONS_FILE: _f, SOVA_TOKEN: _t, SOVA_CALLER_KEY: _c, ...env } = process.env;
    child = spawn(process.execPath, [join(ROOT, "server/index.ts")], { cwd: dir, env: { ...env, PI_CODING_AGENT_DIR: agent, PORT: base ? new URL(base).port : "0", ...driverEnv }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", (d) => out.push(String(d)));
    child.stderr!.on("data", (d) => out.push(String(d)));
    const end = Date.now() + 60_000;
    for (;;) {
      const m = /sova server on (http:\/\/[^ ]+)/.exec(out.join(""));
      if (m) {
        base = m[1]!.replace(/\/$/, "").replace("0.0.0.0", "127.0.0.1");
        return;
      }
      if (Date.now() > end) assert.fail(`server never started: ${out.join("").slice(-800)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const down = async () => {
    const c = child!;
    child = null;
    const gone = new Promise((r) => c.once("exit", r));
    c.kill("SIGTERM");
    await gone;
  };
  const cookie = () => `${authCookieName(agent)}=${readFileSync(join(agent, "sova", "auth-token"), "utf8").trim()}`;
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method, headers: { cookie: cookie(), "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = async (method: string, path: string, body?: unknown) => (await call(method, path, body)).json() as Promise<Record<string, any>>;
  const row = async (id: string) => ((await json("GET", "/api/extensions/installed")).rows as Record<string, any>[]).find((r) => r.id === id);
  const stateIs = (id: string, state: string, ms?: number) => until(`${id} reads ${state}`, () => row(id), (r) => r?.state === state, ms);
  const env = async (id: string) => (await json("GET", `/ext/${id}/api/env`)) as { pid: number; keyFile: string; data: string; url: string; token: string | null };
  const pidAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const install = async (folder: string) => {
    const r = await json("POST", "/api/extensions/inspect", { folder });
    assert.equal(r.ok, true, JSON.stringify(r));
    const done = await json("POST", "/api/extensions/install", { folder, version: r.review.version });
    assert.ok(done.id, JSON.stringify(done));
    return done.id as string;
  };
  return { dir, agent, boot, down, call, json, row, stateIs, env, pidAlive, install, list: join(agent, "sova", "extensions.json"), trust: join(agent, "sova", "extension-trust.json") };
}

function standIn(dir: string, id: string): string {
  const folder = join(dir, `ext-${id}`);
  mkdirSync(join(folder, "dist"), { recursive: true });
  mkdirSync(join(folder, "backend"), { recursive: true });
  writeFileSync(join(folder, "sova-extension.json"), JSON.stringify({ version: 1, id, title: id.toUpperCase(), needsContract: "1.20", page: "dist", backend: { run: ["node", "backend/server.mjs"], folder: "backend" } }));
  writeFileSync(join(folder, "dist", "index.html"), "<h1>page</h1>");
  writeFileSync(join(folder, "backend", "server.mjs"), PROGRAM);
  return folder;
}

async function theWholeLife(r: ReturnType<typeof rig>) {
  await r.boot();
  try {
    // Nothing listed: the trust file is written, nothing else moves.
    assert.deepEqual((await r.json("GET", "/api/extensions/installed")).rows, []);
    assert.deepEqual(JSON.parse(readFileSync(r.trust, "utf8")).approved, {});
    assert.ok(!existsSync(r.list), "no list until something is added");
    assert.ok(!existsSync(join(r.agent, "sova", "extension-programs", "procs")));

    const folder = standIn(r.dir, "standin");
    // Nothing runs before Install.
    const seen = await r.json("POST", "/api/extensions/inspect", { folder });
    assert.equal(seen.review.asks.program.join(" "), "node backend/server.mjs");
    assert.deepEqual((await r.json("GET", "/api/extensions")), []);
    assert.equal((await r.json("POST", "/api/extensions/install", { folder, version: "stale" })).code, "changed");

    await r.install(folder);
    await r.stateIs("standin", "running");
    const first = await r.env("standin");
    assert.equal(first.token, null, "Sova's token is not in its environment");
    assert.ok(existsSync(first.keyFile), "its key is written");
    assert.ok(existsSync(first.data), "its data folder is made");
    assert.equal((await r.call("GET", "/ext/standin/")).status, 200);
    assert.ok((await r.json("GET", "/api/commands")).server, "the list works");

    // Its key is refused at the door.
    const key = readFileSync(first.keyFile, "utf8").trim();
    assert.equal((await fetch(`${first.url}/api/extensions/inspect`, { method: "POST", headers: { "x-sova-token": key, "content-type": "application/json" }, body: `{"folder":"${folder}"}` })).status, 403);
    // A page under /ext/ is refused too, and says where to go.
    const fromPage = await r.call("POST", "/api/extensions/standin/off", {}, { referer: `${first.url}/ext/standin/` });
    assert.equal(fromPage.status, 403);
    assert.match(((await fromPage.json()) as { error: string }).error, /An extension's page can't change extensions/);

    // A program writing its log and its data never asks again; the requests that follow don't wait on anything.
    await new Promise((d) => setTimeout(d, 7_000)); // two passes of the 3 s pass over a program writing every 200 ms
    const after7 = await r.row("standin");
    assert.equal(after7?.state, "running", JSON.stringify(after7));
    assert.equal((await r.env("standin")).pid, first.pid, "and it wasn't restarted");
    assert.ok(readFileSync(join(folder, "backend", "running.log"), "utf8").length > 0);

    // A crash comes back through Sova's pass.
    await r.call("GET", "/ext/standin/api/die");
    const back = await until("a new program", () => r.env("standin"), (e) => typeof e?.pid === "number" && e.pid !== first.pid);
    assert.ok((await r.json("GET", "/api/extensions/standin/log")).lines.length > 0, "View Log has lines");

    // A restart of Sova: the program keeps running, and Turn Off still finds it.
    await r.down();
    assert.ok(r.pidAlive(back.pid), "it outlives the server");
    await r.boot();
    await r.stateIs("standin", "running");
    assert.equal((await r.env("standin")).pid, back.pid, "the same process");

    // Turn Off: stopped, refused, off the list of what acts; data and approval stay.
    assert.equal((await r.json("POST", "/api/extensions/standin/off", {})).ok, true);
    await until("its program stopped", () => r.pidAlive(back.pid), (a) => !a);
    await r.stateIs("standin", "off");
    assert.equal((await r.call("GET", "/ext/standin/")).status, 404);
    assert.deepEqual(await r.json("GET", "/api/extensions"), []);
    assert.equal((await fetch(`${first.url}/api/sessions`, { headers: { "x-sova-token": key } })).status, 401, "its key is refused at once");
    assert.ok(existsSync(join(first.data, "data.txt")), "its data stays");

    // Turn On: no review, running again.
    assert.equal((await r.json("POST", "/api/extensions/standin/on", {})).ok, true);
    await r.stateIs("standin", "running");
    const on = await r.env("standin");

    // Changed: its page stops within a pass, the old program goes on, and a crash doesn't bring new code back.
    writeFileSync(join(folder, "backend", "server.mjs"), `${PROGRAM}\n// edited\n`);
    await r.stateIs("standin", "changed");
    assert.equal((await r.call("GET", "/ext/standin/")).status, 404);
    assert.equal(await (await r.call("GET", "/ext/standin/")).text(), "This extension changed and is waiting for your approval.");
    assert.equal((await r.env("standin")).pid, on.pid, "the running program keeps running");
    assert.equal((await (await r.call("POST", "/api/extensions/standin/program", { action: "restart" })).json() as { error: string }).error.length > 0, true, "and can't be restarted");
    assert.equal((await r.env("standin")).pid, on.pid);
    await r.call("GET", "/ext/standin/api/die");
    await until("its program ended", () => r.pidAlive(on.pid), (a) => !a);
    await new Promise((d) => setTimeout(d, 4_000)); // a pass or two would have started it again
    assert.equal(((await r.call("GET", "/ext/standin/api/env")).status), 502, "it stays down until approved");
    const review = await r.json("POST", "/api/extensions/inspect", { id: "standin" });
    assert.equal((await r.json("POST", "/api/extensions/standin/approve", { version: "stale" })).code, "changed");
    const approving = await r.json("POST", "/api/extensions/standin/approve", { version: review.review.version });
    assert.equal(approving.ok, true, JSON.stringify(approving));
    await r.stateIs("standin", "running");
    const approved = await r.env("standin");

    // Added outside this screen: waiting, nothing live.
    const doc = JSON.parse(readFileSync(r.list, "utf8"));
    doc.extensions.push({ id: "byhand", title: "By Hand", dist: join(folder, "dist"), api: "http://127.0.0.1:9" });
    writeFileSync(r.list, JSON.stringify(doc));
    await r.stateIs("byhand", "waiting");
    assert.equal((await r.call("GET", "/ext/byhand/")).status, 404);
    assert.equal(((await r.json("GET", "/api/extensions")) as unknown as { id: string }[]).some((e) => e.id === "byhand"), false);
    const handReview = await r.json("POST", "/api/extensions/inspect", { id: "byhand" });
    assert.equal((await r.json("POST", "/api/extensions/byhand/approve", { version: handReview.review.version })).ok, true);
    assert.equal((await r.call("GET", "/ext/byhand/")).status, 200);
    // Off the list by hand: Remove's clean-up.
    const left = JSON.parse(readFileSync(r.list, "utf8"));
    left.extensions = left.extensions.filter((e: { id: string }) => e.id !== "byhand");
    writeFileSync(r.list, JSON.stringify(left));
    await until("its approval forgotten", () => JSON.parse(readFileSync(r.trust, "utf8")).approved.byhand, (a) => a === undefined);

    // Remove: stopped, off the list; the folder stays, and its data unless asked.
    assert.equal((await r.json("DELETE", "/api/extensions/standin", { deleteData: false })).ok, true);
    await until("its program stopped", () => r.pidAlive(approved.pid), (a) => !a);
    assert.equal(await r.row("standin"), undefined);
    assert.equal(JSON.parse(readFileSync(r.trust, "utf8")).approved.standin, undefined);
    assert.ok(existsSync(folder));
    assert.ok(existsSync(first.data));
    await until("its key file gone", () => existsSync(first.keyFile), (a) => !a);

    // Added again by hand after Remove: waits again.
    const again = JSON.parse(readFileSync(r.list, "utf8"));
    again.extensions.push({ id: "standin", title: "X", folder, run: ["node", "backend/server.mjs"] });
    writeFileSync(r.list, JSON.stringify(again));
    await r.stateIs("standin", "waiting");
    const removed = await r.json("DELETE", "/api/extensions/standin", { deleteData: true });
    assert.equal(removed.ok, true);
    assert.ok(!existsSync(first.data), "ticked: its data goes");
  } finally {
    await r.down();
  }
}

test("an extension's whole life, on the detached driver", { timeout: 200_000 }, () => theWholeLife(rig("detached", { SOVA_PROJECT_NO_SYSTEMD: "1" })));
test("an extension's whole life, on systemd", { timeout: 200_000, skip: available ? false : "no systemd user manager" }, () => theWholeLife(rig("systemd", {})));

test("every other caller is refused, and says where to click; a too-new or wrong folder reads as the deck says", { timeout: 90_000 }, async () => {
  const r = rig("doors", { SOVA_PROJECT_NO_SYSTEMD: "1" });
  await r.boot();
  try {
    const folder = standIn(r.dir, "doors");
    const token = readFileSync(join(r.agent, "sova", "auth-token"), "utf8").trim();
    const base = (await r.call("GET", "/api/health")).url.replace("/api/health", "");
    const raw = (headers: Record<string, string>) => fetch(`${base}/api/extensions/inspect`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ folder }) });
    for (const [who, headers] of [["a script", { "x-sova-token": token }], ["a chat", { "x-sova-token": token, "x-sova-caller": "a-chat" }]] as const) {
      const a = await raw(headers);
      assert.equal(a.status, 403, who);
      assert.equal(((await a.json()) as { error: string }).error, "Only the user changes extensions. Ask them to do it in Settings → Extensions. Nothing was changed.", who);
    }
    assert.equal(((await r.json("POST", "/api/extensions/inspect", { folder: join(r.dir, "agent") })) as { reason: string }).reason, "This folder has no extension description (sova-extension.json), so it can't be added.");
    writeFileSync(join(folder, "sova-extension.json"), JSON.stringify({ version: 1, id: "x", title: "X", needsContract: "1.99" }));
    assert.match(((await r.json("POST", "/api/extensions/inspect", { folder })) as { reason: string }).reason, /needs a newer Sova/);
    assert.equal(existsSync(r.list), false, "nothing was added");
  } finally {
    await r.down();
  }
});
