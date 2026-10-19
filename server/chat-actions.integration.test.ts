// Run: pnpm test:int -- server/chat-actions.integration.test.ts
// In-chat actions from a script (§app/chat-actions) on a whole hermetic server with the stand-in model
// (server/testing/hermetic-server.ts), through `node scripts/sova.mjs run chat.*` where the exit class
// matters. Stop ends a running reply as the button does; Compact's refusal is the socket's own
// sentence; Rewind returns the composer text; a terminal-held session gets the 409 every action gets;
// wait 0 hands the frame over once; Stop on a chat that isn't open starts nothing; an action stamps no
// seen mark while a chat socket does; and a chat or server restart mid-wait is exit 5, never a retry.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startHermeticServer, type HermeticServer } from "./testing/hermetic-server";

const CLI = join(import.meta.dirname, "..", "scripts", "sova.mjs");
let s: HermeticServer;

before(async () => {
  s = await startHermeticServer();
  // Compaction keeps almost nothing recent, so a short session has something to summarize; never on its own.
  const sp = join(s.agentDir, "settings.json");
  writeFileSync(sp, JSON.stringify({ ...JSON.parse(readFileSync(sp, "utf8")), compaction: { enabled: false, keepRecentTokens: 1 } }));
});
after(async () => {
  await s?.stop();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const headers = () => ({ "x-sova-token": s.token, "content-type": "application/json" });
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${s.base}${path}`, { method, headers: headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  try {
    return { status: r.status, body: JSON.parse(text) };
  } catch {
    return { status: r.status, body: text };
  }
}
/** `node scripts/sova.mjs <args>` against the server: exit, stdout parsed when JSON, stderr. */
function sova(args: string[]): Promise<{ code: number; json: any; err: string; ms: number }> {
  const t0 = performance.now();
  return new Promise((done) => {
    const p = spawn("node", [CLI, ...args], { env: { PATH: process.env.PATH ?? "", HOME: s.home, LANG: "C.UTF-8", SOVA_URL: s.base, SOVA_TOKEN: s.token, PI_CODING_AGENT_DIR: s.agentDir }, cwd: s.work, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      let json: unknown;
      try {
        json = JSON.parse(out);
      } catch {
        json = undefined;
      }
      done({ code: code ?? -1, json, err, ms: performance.now() - t0 });
    });
  });
}
async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

interface Session { id: string; path: string }
const newSession = async (): Promise<Session> => (await api("POST", "/api/sessions", { cwd: s.work })).body;
const items = async (ses: Session): Promise<any[]> => (await api("GET", `/api/transcript?path=${encodeURIComponent(ses.path)}`)).body.items;
const send = (ses: Session, text: string) => api("POST", "/api/sessions/prompt", { path: ses.path, text });
const answered = (ses: Session, n = 1) => until(`reply ${n}`, async () => (await items(ses)).filter((i) => i.kind === "assistant-text" && i.text === "The package name is in package.json.").length >= n);
/** A session with one whole exchange. */
async function oneExchange(): Promise<Session> {
  const ses = await newSession();
  await send(ses, "hello there");
  await answered(ses);
  return ses;
}
/** A reply that is streaming now (the stand-in's `[[slow]]`: half a minute). */
async function streaming(ses: Session): Promise<void> {
  await send(ses, "[[slow]] go on");
  await until("the slow reply streaming", async () => (await items(ses)).some((i) => i.kind === "assistant-text" && String(i.text).startsWith("part")) || (await api("GET", `/api/sessions/summary?id=${ses.id}`)).body.busy);
  await sleep(600);
}
/** A chat socket of the web app's own: its frames, and a way to send. */
async function chatSocket(ses: Session) {
  const ws = new WebSocket(`${s.base.replace("http", "ws")}/ws/chat?path=${encodeURIComponent(ses.path)}&tail=rest&wire=2`, { headers: { "x-sova-token": s.token } } as never);
  const frames: any[] = [];
  ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data))));
  await until("the socket's hello", async () => frames.some((f) => f.type === "hello"));
  return { frames, send: (m: unknown) => ws.send(JSON.stringify(m)), close: () => ws.close() };
}
/** Processes that run with this server's agent dir, but the server's own: its chats. */
function chatPids(): number[] {
  const want = `PI_CODING_AGENT_DIR=${s.agentDir}`;
  return readdirSync("/proc")
    .filter((d) => /^\d+$/.test(d) && Number(d) !== s.pid && Number(d) !== process.pid)
    .filter((d) => {
      try {
        return readFileSync(`/proc/${d}/environ`, "utf8").split("\0").includes(want) && !readFileSync(`/proc/${d}/cmdline`, "utf8").includes("sova.mjs");
      } catch {
        return false;
      }
    })
    .map(Number);
}
/** Entries of a type in the session file. */
const entries = (ses: Session, pred: (e: any) => boolean) => readFileSync(ses.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter(pred);

test("Rewind answers with the composer text, and the branch moved", async () => {
  const ses = await oneExchange();
  const user = (await items(ses)).find((i) => i.kind === "user");
  const r = await sova(["run", "chat.rewind", "--session", ses.path, "--entry", user.id]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.outcome, "done");
  assert.equal(r.json.reply.editorText, "hello there");
  assert.equal((await items(ses)).some((i) => i.kind === "user"), false);
});

test("Compact on a tiny session: the socket's own refusal, word for word (exit 2)", async () => {
  // A session with nothing in it yet: too little to summarize.
  const tiny = await newSession();
  const r = await sova(["run", "chat.compact", "--session", tiny.path]);
  const sock = await chatSocket(tiny);
  sock.send({ type: "compact", id: "w1" });
  const refused = await until("the socket's refusal", async () => sock.frames.find((f) => f.type === "compact_refused" && f.id === "w1"));
  sock.close();
  assert.equal(r.code, 2, r.err);
  assert.equal(r.json.error, refused.message);
  assert.equal(r.json.reason, refused.reason);
});

test("a session a terminal holds: the same 409 sentence as any action on it, at any wait (exit 2)", async () => {
  const ses = await oneExchange();
  writeFileSync(join(s.agentDir, "sessions", "live", `test-${ses.id}.json`), JSON.stringify({ session: { pid: process.pid, sessionFile: ses.path, mode: "tui" }, presence: { status: "idle" } }));
  try {
    const mode = await api("POST", `/api/mode?path=${encodeURIComponent(ses.path)}`, { mode: "normal" });
    assert.equal(mode.status, 409);
    assert.match(mode.body.error, /^Session is open in another pi process/);
    for (const args of [["chat.rewind", "--entry", "x", "--wait", "0"], ["chat.compact"], ["chat.stop"]]) {
      const r = await sova(["run", args[0]!, "--session", ses.path, ...args.slice(1)]);
      assert.equal(r.code, 2, `${args[0]}: ${r.err}`);
      assert.equal(r.json.error, mode.body.error);
    }
  } finally {
    rmSync(join(s.agentDir, "sessions", "live", `test-${ses.id}.json`), { force: true });
  }
});

test("wait 0: handed over and unknown at once (exit 5); it ran exactly once", async () => {
  const ses = await oneExchange();
  const user = (await items(ses)).find((i) => i.kind === "user");
  const r = await sova(["run", "chat.rewind", "--session", ses.path, "--entry", user.id, "--wait", "0"]);
  assert.equal(r.code, 5, r.err);
  assert.equal(r.json.outcome, "unknown");
  assert.match(r.err, /Sova may have acted/);
  await until("the rewind", async () => !(await items(ses)).some((i) => i.kind === "user"));
  await sleep(500);
  assert.equal(entries(ses, (e) => e.type === "custom" && e.customType === "sova-rewind").length, 1);
});

test("Stop mid-reply ends it as the button does, within a second", async () => {
  const viaCli = await oneExchange();
  const viaSocket = await oneExchange();
  await streaming(viaCli);
  const r = await sova(["run", "chat.stop", "--session", viaCli.path]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.json.outcome, r.json.wasRunning], ["stopped", true]);
  assert.ok(r.ms < 3000, `the CLI's whole stop, process start included: ${Math.round(r.ms)} ms`);
  await streaming(viaSocket);
  const sock = await chatSocket(viaSocket);
  sock.send({ type: "abort" });
  await until("the socket's run end", async () => sock.frames.some((f) => f.type === "event" && f.event?.type === "run.settled"));
  sock.close();
  const tail = async (ses: Session) => (await items(ses)).slice(-2).map((i) => [i.kind, i.kind === "info" ? i.text : "…"]);
  assert.deepEqual(await tail(viaCli), await tail(viaSocket));
  assert.deepEqual((await tail(viaCli))[1], ["info", "Aborted: Request was aborted"]);
});

test("Stop on a chat that isn't open starts nothing", async () => {
  const ses = await newSession();
  const before = chatPids().length;
  const r = await sova(["run", "chat.stop", "--session", ses.path]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.json.outcome, r.json.wasRunning], ["stopped", false]);
  await sleep(500);
  assert.equal(chatPids().length, before);
});

test("an action stamps no seen mark; the web app's chat socket does", async () => {
  const ses = await oneExchange();
  const seen = () => {
    const f = join(s.agentDir, "sova", "seen.json");
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record<string, number>)[ses.id] : undefined;
  };
  const was = seen();
  const r = await sova(["run", "chat.compact", "--session", ses.path, "--wait", "0"]);
  assert.equal(r.code, 5, r.err);
  await sleep(300);
  assert.equal(seen(), was, "a script's action is not the user looking");
  const sock = await chatSocket(ses);
  await until("the seen stamp", async () => seen() !== was);
  sock.close();
});

test("right after a server restart, Stop on a reply that ran on through it stops it (never \"nothing was running\")", async () => {
  const ses = await oneExchange();
  await streaming(ses);
  // The chat process can't answer the new server's take-back until it is let go, so the Stop below
  // surely arrives while the take-back is under way.
  const pids = chatPids();
  const signal = (sig: NodeJS.Signals) => {
    for (const pid of pids) {
      try {
        process.kill(pid, sig);
      } catch {
        // gone meanwhile
      }
    }
  };
  signal("SIGSTOP");
  try {
    await s.restart();
    const stop = api("POST", `/api/chat/action?path=${encodeURIComponent(ses.path)}`, { type: "abort" });
    await sleep(1500);
    signal("SIGCONT");
    const r = await stop;
    assert.ok(r.status === 200 || r.status === 202, JSON.stringify(r.body));
    if (r.status === 200) assert.deepEqual([r.body.outcome, r.body.wasRunning], ["stopped", true]);
  } finally {
    signal("SIGCONT");
  }
  await until("the reply ends aborted", async () => (await items(ses)).at(-1)?.text === "Aborted: Request was aborted", 20_000);
});

/** A compaction whose summary streams for half a minute: the history holds the stand-in's `[[slow]]`. */
async function slowCompaction(): Promise<Session> {
  const ses = await oneExchange();
  await streaming(ses);
  assert.equal((await sova(["run", "chat.stop", "--session", ses.path])).code, 0);
  await send(ses, "and once more");
  await answered(ses, 2);
  return ses;
}

/** The first compaction is under way: a second one is refused for it (the first went over 1.5 s ago). */
async function compacting(ses: Session): Promise<void> {
  await sleep(1500);
  const r = await sova(["run", "chat.compact", "--session", ses.path, "--wait", "5000"]);
  assert.equal(r.json?.reason, "compacting", JSON.stringify(r.json));
}

test("the chat restarting mid-wait: 202 unknown (exit 5), never sent again", async () => {
  const ses = await slowCompaction();
  const pending = sova(["run", "chat.compact", "--session", ses.path, "--wait", "60000"]);
  await compacting(ses);
  for (const pid of chatPids()) process.kill(pid, "SIGKILL");
  const r = await pending;
  assert.equal(r.code, 5, r.err);
  assert.equal(r.json.outcome, "unknown");
  assert.ok(r.ms < 30_000, `answered at once when the chat went, not at the wait: ${Math.round(r.ms)} ms`);
});

test("the server restarting mid-wait: exit 5 with the line, and the action is not run again", async () => {
  const ses = await slowCompaction();
  const pending = sova(["run", "chat.compact", "--session", ses.path, "--wait", "60000"]);
  await compacting(ses);
  await s.restart();
  const r = await pending;
  assert.equal(r.code, 5, r.err);
  assert.match(r.err, /Sova may have acted\. Check the chat before you run it again/);
  // The chat ran through the restart with the one compaction it was handed: still that one, never a second start.
  const again = await sova(["run", "chat.compact", "--session", ses.path]);
  assert.equal(again.code, 2, again.err);
  assert.equal(again.json.reason, "compacting");
});
