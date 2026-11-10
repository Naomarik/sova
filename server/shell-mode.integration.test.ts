// Run: pnpm test:int -- server/shell-mode.integration.test.ts
// Shell mode end to end (§chat.shell-mode/card, /lifecycle, /who) on a whole hermetic server with the stand-in
// model (server/testing/hermetic-server.ts) and real chat processes: a command run while the model replies
// ends before the reply and a second client that attaches then sees its card in the hello (t18), and it is
// saved below the reply once the reply ends; a command still running shows with its output so far to a
// client that attaches; archiving a chat stops its running command and saves it as stopped by the close
// (t19); a page's handed-over frames never run one; and a script's or a chat's socket is refused one while the
// page's runs it. Every wait is on a frame or the file, never a sleep.
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { authCookieName } from "./auth";
import { SHELL_NOT_PAGE_TEXT } from "./chat-shell";
import { startHermeticServer, type HermeticServer } from "./testing/hermetic-server";

let s: HermeticServer;
before(async () => {
  s = await startHermeticServer();
});
after(async () => {
  await s?.stop();
});

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
/** Poll a condition (a frame, the file) until it holds. */
async function until<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface Session { id: string; path: string }
const newSession = async (): Promise<Session> => (await api("POST", "/api/sessions", { cwd: s.work })).body;
/** The session file's entries. */
const entries = (ses: Session): any[] => readFileSync(ses.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const bashEntries = (ses: Session) => entries(ses).filter((e) => e.type === "message" && e.message?.role === "bashExecution");
/** What each kind of socket shows (server/page-only.ts): the page its sign-in cookie, a script the token, a chat its key. */
const shows = {
  page: () => ({ cookie: `${authCookieName(s.agentDir)}=${s.token}` }),
  script: () => ({ "x-sova-token": s.token }),
  chat: () => ({ "x-sova-token": s.token, "x-sova-caller": "a-chat-key" }),
};
/** A chat socket (wire 2), the web app's own unless `who` says otherwise: its frames, and a way to send. */
async function chatSocket(ses: Session, who: keyof typeof shows = "page") {
  const ws = new WebSocket(`${s.base.replace("http", "ws")}/ws/chat?path=${encodeURIComponent(ses.path)}&tail=rest&wire=2`, { headers: shows[who]() } as never);
  const frames: any[] = [];
  ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data))));
  const hello = await until("the socket's hello", () => frames.find((f) => f.type === "hello"));
  return { frames, hello, send: (m: unknown) => ws.send(JSON.stringify(m)), close: () => ws.close(), find: (what: string, pred: (f: any) => boolean) => until(what, () => frames.find(pred)) };
}

test("a command run mid-reply: a client that attaches after it ended sees its card, and it is saved below the reply (t18)", async () => {
  const ses = await newSession();
  const a = await chatSocket(ses);
  a.send({ type: "prompt", text: "[[slow]] tell me a long story", clientId: "p1" });
  await a.find("the reply streaming", (f) => f.type === "event" && f.event?.type === "part.delta");
  a.send({ type: "shell", command: "echo hi", clientId: "s1" });
  const start = await a.find("the command's start", (f) => f.type === "shell_start");
  assert.equal(start.clientId, "s1");
  assert.equal(start.run.command, "echo hi");
  assert.equal(start.run.underReply, true);
  const end = await a.find("the command's end", (f) => f.type === "shell_end" && f.id === start.run.id);
  assert.equal(end.output.trim(), "hi");
  assert.equal(end.exitCode, 0);
  assert.equal(end.underReply, true, "pi saves it after the reply");
  assert.equal(bashEntries(ses).length, 0, "not saved while the reply streams");

  const b = await chatSocket(ses);
  assert.equal(b.hello.isStreaming, true, "the reply is still going");
  assert.equal(b.hello.shell?.length, 1, "the second client's hello carries the run");
  assert.deepEqual(
    { id: b.hello.shell[0].id, command: b.hello.shell[0].command, state: b.hello.shell[0].state, output: b.hello.shell[0].output.trim(), exitCode: b.hello.shell[0].exitCode, underReply: b.hello.shell[0].underReply },
    { id: start.run.id, command: "echo hi", state: "ended", output: "hi", exitCode: 0, underReply: true },
  );

  a.send({ type: "abort" });
  for (const c of [a, b]) await c.find("the run saved", (f) => f.type === "shell_saved" && f.id === start.run.id);
  const saved = a.frames.find((f) => f.type === "shell_saved");
  const appended = a.frames.find((f) => f.type === "append" && f.items.some((i: any) => i.id === saved.entryId));
  assert.equal(appended.items.find((i: any) => i.id === saved.entryId).kind, "shell");
  const file = entries(ses).filter((e) => e.type === "message");
  const at = file.findIndex((e) => e.id === saved.entryId);
  assert.ok(at > 0 && file.slice(0, at).some((e) => e.message.role === "assistant"), "the record is below the reply");
  const rows = (await api("GET", `/api/transcript?path=${encodeURIComponent(ses.path)}&wire=2`)).body.items as any[];
  const { durationMs, ...shellRow } = rows.find((r) => r.id === saved.entryId)?.shell ?? {};
  assert.deepEqual(shellRow, { command: "echo hi", output: "hi\n", exitCode: 0 });
  assert.equal(durationMs, end.durationMs, "the saved row says how long it ran, as its end did");
  const legacy = (await api("GET", `/api/transcript?path=${encodeURIComponent(ses.path)}`)).body.items as any[];
  assert.equal(legacy.find((r) => r.id === saved.entryId)?.kind, "info", "wire 1 keeps the plain row");
  const c = await chatSocket(ses);
  assert.equal(c.hello.shell, undefined, "saved: no longer a live run");
  for (const x of [a, b, c]) x.close();
});

test("a command still running shows to a client that attaches, with its output so far; a second runs beside it, and Stop stops only its own", async () => {
  const ses = await newSession();
  const gate = join(s.work, `gate-${Date.now()}`);
  const a = await chatSocket(ses);
  a.send({ type: "shell", command: `printf start; while [ ! -f ${gate} ]; do sleep 0.05; done; printf end`, clientId: "s1" });
  const start = await a.find("the command's start", (f) => f.type === "shell_start");
  await a.find("its first output", (f) => f.type === "shell_output" && f.id === start.run.id);
  a.send({ type: "shell", command: "sleep 60", clientId: "s2" });
  const second = await a.find("the second's start", (f) => f.type === "shell_start" && f.clientId === "s2");
  const b = await chatSocket(ses);
  assert.deepEqual(b.hello.shell?.map((r: any) => [r.id, r.state]), [[start.run.id, "running"], [second.run.id, "running"]], "both in the hello");
  assert.equal(b.hello.shell[0].output, "start");
  a.send({ type: "shell_stop", id: second.run.id });
  const stopped = await a.find("the second stopped", (f) => f.type === "shell_end" && f.id === second.run.id);
  assert.deepEqual([stopped.cancelled, stopped.cancelReason], [true, "user"]);
  assert.ok(!a.frames.some((f) => f.type === "shell_end" && f.id === start.run.id), "the first still runs");
  writeFileSync(gate, "");
  const saved = await b.find("the run saved", (f) => f.type === "shell_saved" && f.id === start.run.id);
  const row = b.frames.find((f) => f.type === "append" && f.items.some((i: any) => i.id === saved.entryId)).items.find((i: any) => i.id === saved.entryId);
  const { durationMs: took, ...rest } = row.shell;
  assert.deepEqual(rest, { command: start.run.command, output: "startend", exitCode: 0 });
  assert.equal(typeof took, "number");
  await b.find("the second saved", (f) => f.type === "shell_saved" && f.id === second.run.id);
  assert.deepEqual(bashEntries(ses).map((e) => [e.message.command, e.message.cancelled]), [["sleep 60", true], [start.run.command, false]]);
  a.close();
  b.close();
});

test("archiving a chat stops its running command and saves it as stopped when the chat closed (t19)", async () => {
  const ses = await newSession();
  const a = await chatSocket(ses);
  a.send({ type: "shell", command: "sleep 60", clientId: "s1" });
  await a.find("the command's start", (f) => f.type === "shell_start");
  const r = await api("POST", "/api/sessions/archive", { path: ses.path, archived: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [entry] = await until("the stopped command's record", () => (bashEntries(ses).length ? bashEntries(ses) : false));
  assert.equal(entry.message.command, "sleep 60");
  assert.equal(entry.message.cancelled, true);
  const marker = await until("its close marker", () => entries(ses).find((e) => e.type === "custom" && e.customType === "sova-shell-closed"));
  assert.equal(marker.data.targetId, entry.id);
  await api("POST", "/api/sessions/archive", { path: ses.path, archived: false });
  const rows = (await api("GET", `/api/transcript?path=${encodeURIComponent(ses.path)}&wire=2`)).body.items as any[];
  const { durationMs: _d, ...closedRow } = rows.find((x) => x.id === entry.id)?.shell ?? {};
  assert.deepEqual(closedRow, { command: "sleep 60", output: "", cancelled: true, cancelReason: "closed" });
  a.close();
});

test("a cut command's whole output reads back in pages; archiving deletes its file, and then it's gone (§chat.shell-mode/card, /lifecycle)", async () => {
  const ses = await newSession();
  const a = await chatSocket(ses);
  // 30,000 lines: past pi's 2,000-line cut, so the whole output is in its own file.
  a.send({ type: "shell", command: "seq 1 30000", clientId: "s1" });
  const start = await a.find("the command's start", (f) => f.type === "shell_start");
  const saved = await a.find("the run saved", (f) => f.type === "shell_saved" && f.id === start.run.id);
  const [entry] = bashEntries(ses);
  assert.equal(entry.message.truncated, true);
  const file = entry.message.fullOutputPath as string;
  assert.ok(existsSync(file));
  const page = (await api("GET", `/api/sessions/shell-output?path=${encodeURIComponent(ses.path)}&entry=${saved.entryId}`)).body;
  const whole = Array.from({ length: 30000 }, (_, i) => `${i + 1}\n`).join("");
  assert.deepEqual([page.output, page.next, page.bytes], [whole, null, whole.length], "every line, from the first");
  // List Commands and Stop Command from a script: a running one listed and stopped, the chat freed.
  a.send({ type: "shell", command: "sleep 60", clientId: "s2" });
  const held = await a.find("the second's start", (f) => f.type === "shell_start" && f.clientId === "s2");
  const listed = await api("POST", `/api/chat/action?path=${encodeURIComponent(ses.path)}`, { type: "shell_list" });
  assert.deepEqual(listed.body.commands.map((c: any) => [c.id, c.command]), [[held.run.id, "sleep 60"]]);
  const stopped = await api("POST", `/api/chat/action?path=${encodeURIComponent(ses.path)}`, { type: "shell_stop", id: held.run.id });
  assert.deepEqual([stopped.status, stopped.body.outcome, stopped.body.cancelReason], [200, "stopped", "other"], "a script's stop is no one's at the page");
  await a.find("the stopped one saved", (f) => f.type === "shell_saved" && f.id === held.run.id);
  const r = await api("POST", "/api/sessions/archive", { path: ses.path, archived: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(existsSync(file), false, "archiving deleted the full output");
  await api("POST", "/api/sessions/archive", { path: ses.path, archived: false });
  const gone = await api("GET", `/api/sessions/shell-output?path=${encodeURIComponent(ses.path)}&entry=${saved.entryId}`);
  assert.deepEqual([gone.status, gone.body.code], [404, "gone"]);
  a.close();
});

test("a ! command in a chat with its sandbox On runs confined: its folder is writable, the home folder and the network are not (§chat.shell-mode/running)", async (t) => {
  // Its own server, whose chats load the sandbox extension (this file's other server loads none).
  const sb = await startHermeticServer({ extensions: ["sandbox"] });
  const prev = s;
  s = sb;
  try {
    const skipped = await sandboxed();
    // A computer whose sandbox can't be proven (its probe fails, as inside another sandbox): the command is refused,
    // fail-closed, and this check can't run. Reported as skipped, never as passed.
    if (skipped) t.skip(`the sandbox's probe can't run here: ${skipped}`);
  } finally {
    s = prev;
    await sb.stop();
  }
});
/** The sandboxed run, after the same checks with the sandbox Off show they can tell the two apart. Returns why
    it couldn't run, when the sandbox's own probe refused, else nothing. */
async function sandboxed(): Promise<string | undefined> {
  const ses = await newSession();
  const a = await chatSocket(ses);
  const run = async (command: string, clientId: string) => {
    a.send({ type: "shell", command, clientId });
    const got = await a.find(`${clientId}'s end or refusal`, (f) => (f.type === "shell_refused" && f.clientId === clientId) || (f.type === "shell_start" && f.clientId === clientId));
    if (got.type === "shell_refused") return { refused: got.message as string };
    return a.find(`${clientId}'s end`, (f) => f.type === "shell_end" && f.id === got.run.id);
  };
  // Dial this server's own port: reachable whatever the machine's network, unless the sandbox cuts it off. In bash
  // (/dev/tcp is bash's), whatever the login shell the command runs in.
  const dial = `bash -c 'exec 3<>/dev/tcp/127.0.0.1/${new URL(s.base).port}' 2>/dev/null && echo reached || echo blocked`;
  const homeOff = join(s.home, `shell-off-${Date.now()}`);
  const homeOn = join(s.home, `shell-on-${Date.now()}`);
  // Off: the same lines write the home folder and reach the port.
  assert.equal(((await run(`touch ${homeOff} && echo wrote`, "off-home")) as any).output?.trim(), "wrote");
  assert.ok(existsSync(homeOff), "with the sandbox Off the home folder is writable: the check below can fail");
  rmSync(homeOff, { force: true });
  assert.equal(((await run(dial, "off-net")) as any).output?.trim(), "reached", "with the sandbox Off the port is reached");
  const on = await api("POST", `/api/sandbox?path=${encodeURIComponent(ses.path)}`, { state: "on" });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.notEqual(on.body.outcome, "unsupported", JSON.stringify(on.body));
  const inside = await run("touch ./inside-ok && echo wrote", "in");
  if ("refused" in inside && /sandbox probe failed/.test(inside.refused)) {
    a.close();
    return inside.refused;
  }
  assert.equal((inside as any).output?.trim(), "wrote", JSON.stringify(inside));
  assert.ok(existsSync(join(s.work, "inside-ok")), "the chat's folder is writable");
  const home = await run(`touch ${homeOn}; echo rc=$?`, "home");
  assert.ok(!existsSync(homeOn), `the home folder is not: ${JSON.stringify(home)}`);
  const net = await run(dial, "net");
  assert.equal((net as any).output?.trim(), "blocked", JSON.stringify(net));
  a.close();
  return undefined;
}

test("a command whose output passes the limit is stopped and saved as stopped at the limit (SOVA_SHELL_OUTPUT_MAX_BYTES, a test's small one)", async () => {
  const small = await startHermeticServer({ env: { SOVA_SHELL_OUTPUT_MAX_BYTES: "20000" } });
  const prev = s;
  s = small;
  try {
    const ses = await newSession();
    const a = await chatSocket(ses);
    a.send({ type: "shell", command: "yes limit-line", clientId: "y" });
    const start = await a.find("the command's start", (f) => f.type === "shell_start");
    const end = await a.find("its end", (f) => f.type === "shell_end" && f.id === start.run.id);
    assert.deepEqual([end.cancelled, end.cancelReason], [true, "limit"]);
    const saved = await a.find("the run saved", (f) => f.type === "shell_saved" && f.id === start.run.id);
    const rows = (await api("GET", `/api/transcript?path=${encodeURIComponent(ses.path)}&wire=2`)).body.items as any[];
    assert.equal(rows.find((r) => r.id === saved.entryId)?.shell?.cancelReason, "limit", "the saved row says so after a reload");
    const whole = (await api("GET", `/api/sessions/shell-output?path=${encodeURIComponent(ses.path)}&entry=${saved.entryId}`)).body;
    // The whole output is the command's first 20,000 bytes: no gap, nothing past the limit.
    assert.equal(whole.bytes, 20000, "nothing past the limit");
    assert.equal(whole.output, "limit-line\n".repeat(2000).slice(0, 20000), "the output's head, whole");
    a.close();
  } finally {
    s = prev;
    await small.stop();
  }
});

test("the hello says which chats have shell mode: an ordinary chat does, the Overseer doesn't and refuses a command (§chat.shell-mode/box)", async () => {
  const ses = await newSession();
  const a = await chatSocket(ses);
  assert.equal(a.hello.shellMode, true);
  a.close();
  const overseer = (await api("GET", "/api/overseer")).body as { id: string; path: string };
  const o = await chatSocket({ id: overseer.id, path: overseer.path });
  assert.equal(o.hello.shellMode, undefined, "a special kind's agent has no shell");
  o.send({ type: "shell", command: "echo nope", clientId: "o1" });
  const refused = await o.find("the refusal", (f) => f.type === "shell_refused" && f.clientId === "o1");
  assert.equal(refused.reason, "unavailable");
  assert.equal(o.frames.some((f) => f.type === "shell_start"), false);
  o.close();
});

test("a page's handed-over frames never run a command (POST /api/chat/frames)", async () => {
  const ses = await newSession();
  const marker = join(s.work, `ran-${Date.now()}`);
  const r = await api("POST", `/api/chat/frames?path=${encodeURIComponent(ses.path)}`, { frames: [{ type: "shell", command: `touch ${marker}`, clientId: "f1" }] });
  assert.equal(r.status, 202);
  assert.equal(r.body.accepted, 0);
  // A live socket's command afterwards runs: had the dropped one been queued, it would have run first.
  const a = await chatSocket(ses);
  a.send({ type: "shell", command: "echo after", clientId: "s1" });
  await a.find("the live command saved", (f) => f.type === "shell_saved");
  assert.equal(existsSync(marker), false);
  assert.deepEqual(bashEntries(ses).map((e) => e.message.command), ["echo after"]);
  a.close();
});

test("only the message box runs a command: a script's or a chat's socket is refused, the page's runs (§chat.shell-mode/who)", async () => {
  const ses = await newSession();
  const marker = join(s.work, `ran-${Date.now()}`);
  for (const who of ["script", "chat"] as const) {
    const x = await chatSocket(ses, who);
    x.send({ type: "shell", command: `touch ${marker}`, clientId: who });
    const refused = await x.find(`the ${who}'s refusal`, (f) => f.type === "shell_refused" && f.clientId === who);
    assert.deepEqual({ reason: refused.reason, message: refused.message }, { reason: "unavailable", message: SHELL_NOT_PAGE_TEXT }, who);
    x.close();
  }
  // The page's command afterwards runs and is the only one saved: had a refused one run, its record would be first.
  const a = await chatSocket(ses);
  a.send({ type: "shell", command: "echo page", clientId: "p1" });
  await a.find("the page's command saved", (f) => f.type === "shell_saved");
  assert.equal(existsSync(marker), false);
  assert.deepEqual(bashEntries(ses).map((e) => e.message.command), ["echo page"]);
  assert.equal(a.frames.some((f) => f.type === "shell_start" && f.run.command !== "echo page"), false);
  a.close();
});
