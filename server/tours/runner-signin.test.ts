import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { tourScriptFixture } from "../../shared/tour-fixtures";
import type { TourScript } from "../../shared/tour";
import { runTourAttempt, TOUR_SOVA_SIGN_IN_REFUSAL, type TourAttemptOptions } from "./runner";
import type { TourParentMessage, TourStorageState } from "./runner-protocol";
import type { TourRecordingContext } from "./sandbox";

// The recorder's sign-in seam, with a stand-in child (nothing launches): the attempt's busy-time budget
// pauses while a sign-in waits for its answer, the answer reaches the child and nothing else, and a
// managed Sova copy refuses a form sign-in before any launch.
const ORIGIN = "https://public.example";
const context: TourRecordingContext = { sessionId: "signin-seam", sessionFile: "/server/chat.jsonl", cwd: "/server/checkout", agentDir: "/server/agent", sandbox: { on: false } };
const signed = (): TourScript => {
  const s = tourScriptFixture();
  s.source = { kind: "site", origin: ORIGIN };
  s.signIn = { route: "/login", username: { kind: "role", role: "textbox", name: "Username" }, password: { kind: "testId", testId: "password" }, submit: { kind: "role", role: "button", name: "Sign in" }, signedIn: { kind: "role", role: "heading", name: "Your account" } };
  return s;
};
const STORAGE: TourStorageState = { cookies: [{ name: "sid", value: "stored-session", domain: "public.example", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }], origins: [] };

/** A stand-in child: `script` drives it from the start message, then it reports a result and exits. */
function standIn(script: (start: Extract<TourParentMessage, { type: "start" }>, said: (m: object) => void, next: () => Promise<TourParentMessage>) => Promise<void>) {
  const stdin = new PassThrough(), stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), pid: undefined, exitCode: null, signalCode: null, kill: () => { setTimeout(() => proc.emit("close", null), 5); return true; } }) as unknown as ChildProcess;
  const received: TourParentMessage[] = [];
  const waiting: ((m: TourParentMessage) => void)[] = [];
  createInterface({ input: stdin }).on("line", line => { const m = JSON.parse(line) as TourParentMessage; received.push(m); const w = waiting.shift(); if (w) w(m); else queued.push(m); });
  const queued: TourParentMessage[] = [];
  const next = () => queued.length ? Promise.resolve(queued.shift()!) : new Promise<TourParentMessage>(r => waiting.push(r));
  const said = (m: object) => { stdout.write(`${JSON.stringify(m)}\n`); };
  void next().then(async start => {
    await script(start as Extract<TourParentMessage, { type: "start" }>, said, next);
    said({ type: "result", steps: [], contactSheets: [], suspicious: [], publicOrigins: [], sovaServer: false, quietAborts: 2, signedIn: true });
    setTimeout(() => proc.emit("close", 0), 5);
  });
  return { proc, received };
}
const attempt = (proc: ChildProcess, extra: Partial<TourAttemptOptions> = {}) => runTourAttempt({
  context, script: signed(), tourId: "seam-tour", editionId: "seam-edition", dryRun: true, beforeContact: async () => {},
  target: async () => ({ origin: ORIGIN, generation: 1, assertCurrent: async () => {} }),
  startProxy: async () => ({ url: "http://127.0.0.1:1", closed: new Promise<void>(() => {}), close: async () => {} }),
  spawn: async () => ({ process: proc, dispose: async () => {} }),
  ...extra,
});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test("a wait for a sign-in longer than the attempt's limit doesn't count against it; the answer reaches the child", async () => {
  const child = standIn(async (_start, said, next) => {
    said({ type: "sign-in-needed", id: 1, origin: ORIGIN, fields: ["username", "password"] });
    const answer = await next();
    assert.deepEqual(answer, { type: "sign-in", id: 1, username: "made-up-user", password: "made-up-pass-1" });
    said({ type: "signed-in", origin: ORIGIN, storage: STORAGE });
  });
  const saved: unknown[] = [];
  const result = await attempt(child.proc, {
    limitMs: 150,
    onSignIn: async need => { assert.deepEqual(need, { origin: ORIGIN, fields: ["username", "password"] }); await sleep(400); return { username: "made-up-user", password: "made-up-pass-1" }; },
    onSignedIn: (origin, storage) => { saved.push([origin, storage]); },
  });
  assert.equal(result.signedIn, true);
  assert.equal(result.quietAborts, 2);
  assert.deepEqual(saved, [[ORIGIN, STORAGE]]);
  // Control: the same busy time with no sign-in to wait for exceeds the limit.
  const busy = standIn(async () => { await sleep(400); });
  await assert.rejects(attempt(busy.proc, { limitMs: 150 }), /exceeded its 5-minute limit/);
});

test("the start message carries the tour's stored session and the sign-in origins, never a login", async () => {
  const child = standIn(async () => {});
  await attempt(child.proc, { signInStorage: STORAGE, onSignIn: async () => ({}) });
  const start = child.received[0] as Extract<TourParentMessage, { type: "start" }>;
  assert.deepEqual(start.input.signIn, { origins: [ORIGIN], storage: STORAGE });
  assert.ok(start.input.declared?.includes(ORIGIN));
});

test("a sign-in the server refuses (too many waiting, cancelled, an hour up) stops the attempt with that reason", async () => {
  const child = standIn(async (_start, said) => { said({ type: "sign-in-needed", id: 1, origin: ORIGIN, fields: ["username", "password"] }); await new Promise(() => {}); });
  const refusal = new Error("Too many recordings are waiting for a sign-in.");
  setTimeout(() => child.proc.emit("close", null), 100); // the stopped stand-in exits
  await assert.rejects(attempt(child.proc, { onSignIn: async () => { throw refusal; } }), (e: unknown) => e === refusal);
});

test("a sign-in request for an origin outside the script's sign-in origins stops the attempt", async () => {
  const child = standIn(async (_start, said) => { said({ type: "sign-in-needed", id: 1, origin: "https://elsewhere.example", fields: ["username", "password"] }); await new Promise(() => {}); });
  let asked = false;
  setTimeout(() => child.proc.emit("close", null), 100); // the stopped stand-in exits
  await assert.rejects(attempt(child.proc, { onSignIn: async () => { asked = true; return {}; } }), /Invalid recording sign-in request/);
  assert.equal(asked, false);
});

test("a managed Sova copy refuses a form sign-in before anything launches", async () => {
  let launched = false;
  await assert.rejects(runTourAttempt({
    context, script: signed(), tourId: "seam-tour", editionId: "seam-edition", dryRun: true, beforeContact: async () => {},
    target: async () => ({ origin: ORIGIN, generation: 1, assertCurrent: async () => {}, sova: { agentDir: "/server/copy-agent" } }) as never,
    startProxy: async () => ({ url: "http://127.0.0.1:1", closed: new Promise<void>(() => {}), close: async () => {} }),
    spawn: async () => { launched = true; throw new Error("launch"); },
  }), { message: TOUR_SOVA_SIGN_IN_REFUSAL });
  assert.equal(launched, false);
});
