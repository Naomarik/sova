import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { inspect } from "node:util";
import { join } from "node:path";
import { tourEditionAssetsFixture, tourManifestFixture, tourScriptFixture } from "../../shared/tour-fixtures";
import type { TourJob, TourScript } from "../../shared/tour";
import { stateView } from "../harness/state-view";
import { scratchRoot } from "../test-scratch";
import { tourScriptDigest } from "./checks";
import { TourCaptureFailure } from "./targets";
import { TourRuntime, TOUR_CREDENTIALS_IN_SCRIPT, TOUR_SIGN_IN_EXPIRED, type TourNeedsYou, type TourRuntimeOptions } from "./runtime";
import { TOUR_SOVA_SIGN_IN_REFUSAL } from "./runner";
import { TOUR_SIGN_IN_STALE, TOUR_SIGN_IN_WRONG, type TourStorageState } from "./runner-protocol";
import { TourSignInStore, type TourSignInTimers } from "./signin-store";
import type { TourToolCaller } from "./tools";

// al_6, the runtime's part of a form sign-in, with a stand-in recorder that behaves like the site: one
// prompt per tour (the record job reuses the dry run's session), the per-tour memory's lifecycle, the
// one-hour clock, the lock flag set only by a form sign-in, and no login value written anywhere.
const ORIGIN = "https://example.test";
const PASSWORD = "fake-pw-07";
const USERNAME = "made-up-canary-user";
const ACCOUNT = "made-up-canary-account";
const STORAGE: TourStorageState = { cookies: [{ name: "sid", value: "made-up-session", domain: "example.test", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }], origins: [] };
const verification = { overviewReviewed: true as const, suspiciousCapturesReviewed: ["phone.png"], notes: "Reviewed every overview cell and inspected the suspicious phone picture." };
const signed = (): TourScript => ({ ...tourScriptFixture(), signIn: { route: "/login", username: { kind: "role", role: "textbox", name: "Username" }, password: { kind: "testId", testId: "password" }, submit: { kind: "role", role: "button", name: "Sign in" }, signedIn: { kind: "role", role: "heading", name: "Saved drafts" } } });

function fakeTimers() {
  let clock = 1_000;
  const pending = new Set<{ at: number; fn: () => void }>();
  const timers: TourSignInTimers = { now: () => clock, set: (fn, ms) => { const h = { at: clock + ms, fn }; pending.add(h); return h; }, clear: h => { pending.delete(h as { at: number; fn: () => void }); } };
  return { timers, advance: (ms: number) => { clock += ms; for (const h of [...pending]) if (h.at <= clock) { pending.delete(h); h.fn(); } } };
}
function setup(site: { password?: string; code?: string; nearest?: string[]; sova?: boolean; hang?: boolean; account?: boolean; staleWhenHeld?: boolean } = {}) {
  const root = scratchRoot("tour-signin-");
  const state = () => stateView([{ kind: "state", id: "sandbox", parentId: null, key: "sandbox", data: { version: 1, on: false, level: "workspace-write", enforcement: "none", backend: "test" } }]);
  const caller: TourToolCaller = { sessionId: "chat-a", sessionFile: `${root}/chat.jsonl`, cwd: "/forged", state: state() };
  const clock = fakeTimers();
  const signIns = new TourSignInStore({ timers: clock.timers });
  const needsYou: TourNeedsYou[] = [];
  const launches: { dryRun: boolean; storage?: TourStorageState; account: boolean }[] = [];
  let posts = 0, aborted = 0;
  const runtime = new TourRuntime({ root, signIns, onNeedsYou: e => needsYou.push(e),
    context: { canonical: p => p, snapshot: async () => ({ sessionId: caller.sessionId, sessionFile: caller.sessionFile, cwd: root, agentDir: `${root}/agent`, state: state(), held: { on: false, enforcement: "none" } }) },
    target: async () => ({ origin: ORIGIN, assertCurrent: async () => {}, ...(site.sova ? { sova: { agentDir: `${root}/copy` } } : {}) }) as never,
    run: async input => {
      launches.push({ dryRun: input.dryRun, ...(input.signInStorage ? { storage: input.signInStorage } : {}), account: !!input.account });
      let signedIn = false;
      if (input.script.signIn) {
        if (input.signInStorage && site.staleWhenHeld) throw new TourCaptureFailure({ message: TOUR_SIGN_IN_STALE, guidance: "Nothing was typed.", blockedOrigin: ORIGIN, stepId: "find-draft", viewId: "overview", size: "desktop" });
        if (input.signInStorage) signedIn = true;
        else {
          const login = await input.onSignIn!({ origin: ORIGIN, fields: input.script.signIn.account ? ["account", "username", "password"] : ["username", "password"] });
          posts++;
          if (login.password !== (site.password ?? PASSWORD) || (input.script.signIn.account ? login.account !== ACCOUNT : login.account !== undefined)) throw new TourCaptureFailure({ message: TOUR_SIGN_IN_WRONG, guidance: "Check them.", blockedOrigin: ORIGIN });
          if (site.code) { const { code } = await input.onSignIn!({ origin: ORIGIN, fields: ["code"] }); if (code !== site.code) throw new TourCaptureFailure({ message: TOUR_SIGN_IN_WRONG, guidance: "Check them.", blockedOrigin: ORIGIN }); }
          input.onSignedIn!(ORIGIN, STORAGE); signedIn = true;
        }
      }
      // Mid-attempt until stopped: the hour running out must abort this runner.
      if (site.hang && !input.dryRun) { await new Promise<void>(r => input.signal!.addEventListener("abort", () => r(), { once: true })); aborted++; throw new Error("Recording cancelled."); }
      if (site.nearest) throw new TourCaptureFailure({ message: "Target matched 0 controls.", guidance: "Choose an exact name.", stepId: "find-draft", viewId: "overview", size: "desktop", nearest: site.nearest });
      await input.beforeContact(ORIGIN);
      const manifest = tourManifestFixture();
      return { steps: input.dryRun ? [] : manifest.steps, assets: input.dryRun ? new Map<string, Uint8Array>() : tourEditionAssetsFixture(), contactSheets: input.dryRun ? [] : manifest.check.contactSheets, suspicious: input.dryRun ? [] : ["phone.png"], provenance: { origin: ORIGIN, recordedAt: manifest.recordedAt, publicOrigins: [ORIGIN] }, scriptDigest: tourScriptDigest(input.script), quietAborts: 1, ...(signedIn ? { signedIn: true as const } : {}) };
    },
  } satisfies TourRuntimeOptions);
  runtime.approvals.approve(ORIGIN);
  return { runtime, caller, root, signIns, clock, needsYou, launches, posts: () => posts, aborted: () => aborted, close: () => { runtime.close(); rmSync(root, { recursive: true, force: true }); } };
}
type F = ReturnType<typeof setup>;
async function phase(f: F, id: string, wanted: TourJob["phase"][]): Promise<TourJob> {
  for (let i = 0; i < 400; i++) {
    const job = f.runtime.queue.get("chat-a", id)!;
    if (wanted.includes(job.phase)) return job;
    await new Promise(r => setTimeout(r, 1));
  }
  throw new Error(`job stayed ${f.runtime.queue.get("chat-a", id)?.phase}`);
}
async function publish(f: F, recordId: string) {
  await phase(f, recordId, ["checking"]);
  await f.runtime.inspect(f.caller, recordId); await f.runtime.inspect(f.caller, recordId, "phone.png");
  return f.runtime.check(f.caller, recordId, verification);
}
/** Every file under the state root, as text: a login value must be in none of them. */
function onDisk(root: string): string {
  let all = "";
  const walk = (dir: string) => { for (const name of readdirSync(dir)) { const p = join(dir, name); if (statSync(p).isDirectory()) walk(p); else all += readFileSync(p, "latin1"); } };
  if (existsSync(root)) walk(root);
  return all;
}

test("one prompt per tour: the record job reuses the dry run's sign-in, its edition is marked signed in, and the tour's memory ends with the recording", async () => {
  const f = setup();
  try {
    const dry = await f.runtime.dryRun(f.caller, signed(), "tour-demo");
    const waiting = await phase(f, dry.job.id, ["needs-sign-in"]);
    assert.deepEqual(waiting.requirements, { signIn: { origin: ORIGIN, kind: "form", fields: ["username", "password"] } });
    assert.deepEqual(f.needsYou.map(({ since: _since, title: _title, ...e }) => e), [{ sessionId: "chat-a", tourId: "tour-demo", jobId: dry.job.id, origin: ORIGIN, fields: ["username", "password"] }]);
    assert.deepEqual(f.runtime.waitingSignIns().map(w => w.jobId), [dry.job.id]);
    // The canary sits in the tour's memory and in the stand-in's child while the job is parked: never on disk.
    const answered = await f.runtime.signIn(f.caller, dry.job.id, { origin: ORIGIN, username: USERNAME, password: PASSWORD });
    assert.ok(!JSON.stringify(answered).includes(PASSWORD));
    assert.equal((await phase(f, dry.job.id, ["checking"])).quietAborts, 1);
    assert.deepEqual(f.runtime.waitingSignIns(), []);
    assert.equal(f.signIns.has("chat-a", "tour-demo"), true, "a dry run ending keeps the tour's sign-in");
    const rec = await f.runtime.record(f.caller, dry.job.id);
    const ready = await publish(f, rec.job.id);
    assert.equal(f.needsYou.length, 1, "the record job signed in from the stored session, with no second prompt");
    assert.equal(f.posts(), 1);
    assert.deepEqual(f.launches.filter(l => !l.dryRun).map(l => l.storage), [STORAGE], "the capture started from the stored session");
    assert.equal(f.runtime.store.latestEdition("chat-a", "tour-demo")?.provenance.signedIn, true);
    assert.equal(f.runtime.latest("chat-a", "tour-demo").signedIn, true);
    assert.equal(ready.job.phase, "ready");
    assert.equal(f.signIns.has("chat-a", "tour-demo"), false, "the recording's end clears the tour's sign-in");
    for (const v of [PASSWORD, USERNAME, "made-up-session"]) assert.ok(!onDisk(f.root).includes(v), `${v} on disk`);
    // Another tour asks again.
    const other = await f.runtime.dryRun(f.caller, signed(), "tour-two");
    await phase(f, other.job.id, ["needs-sign-in"]);
    assert.equal(f.needsYou.length, 2);
  } finally { f.close(); }
});

test("supplied credentials sign in silently, are written nowhere, and still mark the edition signed in", async () => {
  const f = setup();
  try {
    const credentials = { [ORIGIN]: { username: USERNAME, password: PASSWORD } };
    const dry = await f.runtime.dryRun(f.caller, signed(), "tour-demo", credentials);
    assert.ok(!JSON.stringify(dry).includes(PASSWORD) && !JSON.stringify(dry).includes(USERNAME));
    await phase(f, dry.job.id, ["checking"]);
    const rec = await f.runtime.record(f.caller, dry.job.id);
    await publish(f, rec.job.id);
    assert.equal(f.needsYou.length, 0);
    assert.equal(f.runtime.store.latestEdition("chat-a", "tour-demo")?.provenance.signedIn, true);
    for (const v of [PASSWORD, USERNAME, encodeURIComponent(PASSWORD)]) assert.ok(!onDisk(f.root).includes(v), `${v} on disk`);
  } finally { f.close(); }
});

test("an edition recorded with a stored HTTP Basic test account is not marked signed in; a form sign-in's is", async () => {
  const f = setup();
  try {
    f.runtime.accounts.save({ origin: ORIGIN, username: "made-up-tester", password: "fake-pw-16", testAccount: true });
    const dry = await f.runtime.dryRun(f.caller, tourScriptFixture(), "tour-basic");
    await phase(f, dry.job.id, ["checking"]);
    const rec = await f.runtime.record(f.caller, dry.job.id);
    await publish(f, rec.job.id);
    assert.ok(f.launches.every(l => l.account), "the stored Basic account answered");
    assert.equal(f.runtime.store.latestEdition("chat-a", "tour-basic")?.provenance.signedIn, undefined);
    assert.equal(f.runtime.latest("chat-a", "tour-basic").signedIn, undefined);
    // Control: the same recorder with a form sign-in.
    const form = await f.runtime.dryRun(f.caller, signed(), "tour-form", { [ORIGIN]: { username: USERNAME, password: PASSWORD } });
    await phase(f, form.job.id, ["checking"]);
    const formRec = await f.runtime.record(f.caller, form.job.id);
    await publish(f, formRec.job.id);
    assert.equal(f.runtime.store.latestEdition("chat-a", "tour-form")?.provenance.signedIn, true);
  } finally { f.close(); }
});

test("wrong details: one attempt, the fixed failure, and that login forgotten", async () => {
  const f = setup();
  try {
    const dry = await f.runtime.dryRun(f.caller, signed(), "tour-demo", { [ORIGIN]: { username: USERNAME, password: "fake-pw-08" } });
    const failed = await phase(f, dry.job.id, ["failed"]);
    assert.equal(failed.failure?.message, TOUR_SIGN_IN_WRONG);
    assert.equal(f.posts(), 1);
    assert.equal(f.signIns.login("chat-a", "tour-demo", ORIGIN), undefined);
  } finally { f.close(); }
});

test("a one-time code: asked on the card, handed to the waiting recording, never kept; a supplied code is used silently", async () => {
  const f = setup({ code: "482913" });
  try {
    const dry = await f.runtime.dryRun(f.caller, signed(), "tour-demo", { [ORIGIN]: { username: USERNAME, password: PASSWORD } });
    const waiting = await phase(f, dry.job.id, ["needs-sign-in"]);
    assert.deepEqual(waiting.requirements?.signIn?.fields, ["code"]);
    await assert.rejects(f.runtime.signIn(f.caller, dry.job.id, { origin: ORIGIN, username: USERNAME, password: PASSWORD }), /one-time code/);
    await f.runtime.signIn(f.caller, dry.job.id, { origin: ORIGIN, code: "482913" });
    await phase(f, dry.job.id, ["checking"]);
    assert.equal(f.signIns.takeCode("chat-a", "tour-demo", ORIGIN), undefined);
    const supplied = await f.runtime.dryRun(f.caller, signed(), "tour-two", { [ORIGIN]: { username: USERNAME, password: PASSWORD, code: "482913" } });
    await phase(f, supplied.job.id, ["checking"]);
    assert.equal(f.needsYou.length, 1, "only the first tour asked");
  } finally { f.close(); }
});

test("cancel while waiting for a sign-in stops it and clears the tour's sign-in; so does deleting the chat", async () => {
  const f = setup();
  try {
    f.signIns.setLogin("chat-a", "tour-demo", "https://other.example", { username: "x-made-up", password: "y-made-up" });
    const dry = await f.runtime.dryRun(f.caller, signed(), "tour-demo");
    await phase(f, dry.job.id, ["needs-sign-in"]);
    await f.runtime.cancel(f.caller, dry.job.id);
    assert.equal((await phase(f, dry.job.id, ["cancelled"])).requirements, undefined);
    assert.deepEqual(f.runtime.waitingSignIns(), []);
    assert.equal(f.signIns.has("chat-a", "tour-demo"), false);
    f.signIns.setLogin("chat-a", "tour-demo", ORIGIN, { username: USERNAME, password: PASSWORD });
    await f.runtime.removeSession("chat-a");
    assert.equal(f.signIns.has("chat-a", "tour-demo"), false);
  } finally { f.close(); }
});

test("after an hour the tour's sign-in is gone, and a recording still waiting on it stops", async () => {
  const f = setup();
  try {
    const dry = await f.runtime.dryRun(f.caller, signed(), "tour-demo", { [ORIGIN]: { username: USERNAME, password: PASSWORD } });
    await phase(f, dry.job.id, ["checking"]);
    const rec = await f.runtime.record(f.caller, dry.job.id);
    await phase(f, rec.job.id, ["checking"]);
    // A new tour waits for its sign-in; its hour starts with its first entry.
    const other = await f.runtime.dryRun(f.caller, signed(), "tour-two");
    await phase(f, other.job.id, ["needs-sign-in"]);
    f.signIns.setLogin("chat-a", "tour-two", "https://other.example", { username: "x-made-up", password: "y-made-up" });
    f.clock.advance(60 * 60_000);
    const failed = await phase(f, other.job.id, ["failed"]);
    assert.equal(failed.failure?.message, TOUR_SIGN_IN_EXPIRED);
    assert.deepEqual(f.runtime.waitingSignIns(), []);
    assert.equal(f.signIns.has("chat-a", "tour-two"), false);
  } finally { f.close(); }
});

test("a login value inside the script is refused before anything is written; credentials need a sign-in", async () => {
  const f = setup();
  try {
    const leaky = signed(); leaky.steps[0]!.views[0]!.note = `Type ${PASSWORD} here.`;
    await assert.rejects(f.runtime.dryRun(f.caller, leaky, "tour-demo", { [ORIGIN]: { username: USERNAME, password: PASSWORD } }), { message: TOUR_CREDENTIALS_IN_SCRIPT });
    const encoded = signed(); const view = encoded.steps[0]!.views[0]!; if (view.kind !== "page") throw new Error("fixture"); view.route = `/drafts?u=${encodeURIComponent("made up@user")}`;
    await assert.rejects(f.runtime.dryRun(f.caller, encoded, "tour-demo", { [ORIGIN]: { username: "made up@user", password: PASSWORD } }), { message: TOUR_CREDENTIALS_IN_SCRIPT });
    await assert.rejects(f.runtime.dryRun(f.caller, tourScriptFixture(), "tour-demo", { [ORIGIN]: { username: USERNAME, password: PASSWORD } }), /credentials need a signIn/);
    await assert.rejects(f.runtime.dryRun(f.caller, signed(), "tour-demo", { "https://elsewhere.example": { username: USERNAME, password: PASSWORD } }), /isn't one of this script's sign-in origins/);
    assert.equal(f.runtime.queue.list("chat-a").length, 0);
    assert.ok(!onDisk(f.root).includes(PASSWORD));
    // Control: the same login beside a clean script is accepted.
    const ok = await f.runtime.dryRun(f.caller, signed(), "tour-demo", { [ORIGIN]: { username: USERNAME, password: PASSWORD } });
    await phase(f, ok.job.id, ["checking"]);
  } finally { f.close(); }
});

test("a failure that would carry a login value (a page naming the user) is replaced before it is stored", async () => {
  const f = setup({ nearest: [`Signed in as ${USERNAME}`, "Saved drafts"] });
  try {
    const dry = await f.runtime.dryRun(f.caller, signed(), "tour-demo", { [ORIGIN]: { username: USERNAME, password: PASSWORD } });
    const failed = await phase(f, dry.job.id, ["failed"]);
    assert.ok(!JSON.stringify(failed).includes(USERNAME));
    assert.equal(failed.failure?.viewId, "overview");
    assert.ok(!onDisk(f.root).includes(USERNAME));
  } finally { f.close(); }
});

test("a managed Sova copy refuses a form sign-in at dry-run", async () => {
  const f = setup({ sova: true });
  try {
    await assert.rejects(f.runtime.dryRun(f.caller, signed(), "tour-demo"), { message: TOUR_SOVA_SIGN_IN_REFUSAL });
    assert.equal(f.runtime.queue.list("chat-a").length, 0);
  } finally { f.close(); }
});

test("Approve All approves exactly the requested sites, and nothing else", async () => {
  const f = setup();
  try {
    f.runtime.approvals.revoke(ORIGIN);
    const s = signed(); s.sites = ["https://cdn.example"];
    const dry = await f.runtime.dryRun(f.caller, s, "tour-demo", { [ORIGIN]: { username: USERNAME, password: PASSWORD } });
    const waiting = await phase(f, dry.job.id, ["needs-site-approval"]);
    const asked = waiting.requirements!.origins!;
    await assert.rejects(f.runtime.approveAll(f.caller, dry.job.id, [asked[0]!]), /exactly the sites/);
    await assert.rejects(f.runtime.approveAll(f.caller, dry.job.id, [...asked, "https://extra.example"]), /exactly the sites/);
    assert.equal(f.runtime.approvals.isApproved("https://extra.example"), false);
    await f.runtime.approveAll(f.caller, dry.job.id, [...asked].reverse());
    assert.ok(asked.every(o => f.runtime.approvals.isApproved(o)));
    await phase(f, dry.job.id, ["checking"]);
  } finally { f.close(); }
});

test("credentials first supplied at record are checked against the stored script: a value in it is refused before anything is written", async () => {
  const f = setup();
  try {
    const leaky = signed(); leaky.steps[0]!.views[0]!.note = `Type ${PASSWORD} here.`;
    const dry = await f.runtime.dryRun(f.caller, leaky, "tour-demo");
    await phase(f, dry.job.id, ["needs-sign-in"]);
    await f.runtime.signIn(f.caller, dry.job.id, { origin: ORIGIN, username: USERNAME, password: PASSWORD });
    await phase(f, dry.job.id, ["checking"]);
    const before = f.runtime.queue.list("chat-a").length;
    const disk = onDisk(f.root);
    await assert.rejects(f.runtime.record(f.caller, dry.job.id, { [ORIGIN]: { username: USERNAME, password: PASSWORD } }), { message: TOUR_CREDENTIALS_IN_SCRIPT });
    assert.equal(f.runtime.queue.list("chat-a").length, before, "no record job");
    assert.equal(onDisk(f.root), disk, "nothing written");
    // Control: a login whose values the stored script doesn't hold proceeds.
    const rec = await f.runtime.record(f.caller, dry.job.id, { [ORIGIN]: { username: USERNAME, password: "fake-pw-15" } });
    await phase(f, rec.job.id, ["checking"]);
  } finally { f.close(); }
});

test("after an hour a recording still running signed in is stopped: its runner is aborted and the job fails with the expiry", async () => {
  const f = setup({ hang: true });
  try {
    const dry = await f.runtime.dryRun(f.caller, signed(), "tour-demo", { [ORIGIN]: { username: USERNAME, password: PASSWORD } });
    await phase(f, dry.job.id, ["checking"]);
    const rec = await f.runtime.record(f.caller, dry.job.id);
    await phase(f, rec.job.id, ["recording"]);
    assert.equal(f.aborted(), 0);
    f.clock.advance(60 * 60_000);
    const failed = await phase(f, rec.job.id, ["failed"]);
    assert.equal(failed.failure?.message, TOUR_SIGN_IN_EXPIRED);
    assert.equal(f.aborted(), 1, "the running attempt's abort signal fired");
    assert.equal(f.signIns.has("chat-a", "tour-demo"), false);
  } finally { f.close(); }
});

const withAccount = (): TourScript => { const s = signed(); s.signIn!.account = { kind: "testId", testId: "account" }; return s; };

test("an account box: supplied with the login it signs in silently, the card must send it, and its value is written nowhere", async () => {
  const f = setup();
  try {
    const dry = await f.runtime.dryRun(f.caller, withAccount(), "tour-demo", { [ORIGIN]: { account: ACCOUNT, username: USERNAME, password: PASSWORD } });
    await phase(f, dry.job.id, ["checking"]);
    const rec = await f.runtime.record(f.caller, dry.job.id);
    await publish(f, rec.job.id);
    assert.equal(f.needsYou.length, 0);
    assert.equal(f.runtime.store.latestEdition("chat-a", "tour-demo")?.provenance.signedIn, true);
    // The card: the requirement lists the account, and an answer without it (or one with an account not asked for) is refused.
    const asked = await f.runtime.dryRun(f.caller, withAccount(), "tour-two");
    const waiting = await phase(f, asked.job.id, ["needs-sign-in"]);
    assert.deepEqual(waiting.requirements?.signIn?.fields, ["account", "username", "password"]);
    await assert.rejects(f.runtime.signIn(f.caller, asked.job.id, { origin: ORIGIN, username: USERNAME, password: PASSWORD }), { message: "This recording asks for an account, a username and a password." });
    await f.runtime.signIn(f.caller, asked.job.id, { origin: ORIGIN, account: ACCOUNT, username: USERNAME, password: PASSWORD });
    await phase(f, asked.job.id, ["checking"]);
    const plain = await f.runtime.dryRun(f.caller, signed(), "tour-three");
    await phase(f, plain.job.id, ["needs-sign-in"]);
    await assert.rejects(f.runtime.signIn(f.caller, plain.job.id, { origin: ORIGIN, account: ACCOUNT, username: USERNAME, password: PASSWORD }), { message: "This recording asks for a username and password." });
    for (const v of [ACCOUNT, encodeURIComponent(ACCOUNT)]) assert.ok(!onDisk(f.root).includes(v), `${v} on disk`);
  } finally { f.close(); }
});

test("an account value is kept out of the script, of stored failures, and of every printed form of the tour's memory", async () => {
  const f = setup({ nearest: [`Account ${ACCOUNT}`, "Saved drafts"] });
  try {
    const leaky = withAccount(); leaky.steps[0]!.views[0]!.note = `Use ${encodeURIComponent(ACCOUNT)} here.`;
    await assert.rejects(f.runtime.dryRun(f.caller, leaky, "tour-demo", { [ORIGIN]: { account: ACCOUNT, username: USERNAME, password: PASSWORD } }), { message: TOUR_CREDENTIALS_IN_SCRIPT });
    const dry = await f.runtime.dryRun(f.caller, withAccount(), "tour-demo", { [ORIGIN]: { account: ACCOUNT, username: USERNAME, password: PASSWORD } });
    assert.ok(JSON.stringify(f.signIns) === JSON.stringify("[sign-ins hidden]") && !inspect(f.signIns, { depth: 9 }).includes(ACCOUNT));
    assert.equal(f.signIns.login("chat-a", "tour-demo", ORIGIN)?.account, ACCOUNT);
    const failed = await phase(f, dry.job.id, ["failed"]);
    assert.ok(!JSON.stringify(failed).includes(ACCOUNT));
    assert.ok(!onDisk(f.root).includes(ACCOUNT));
  } finally { f.close(); }
});

test("credentials first supplied at record must match the stored script's account box, refused by name before anything is written", async () => {
  const f = setup();
  try {
    const withBox = await f.runtime.dryRun(f.caller, withAccount(), "tour-demo", { [ORIGIN]: { account: ACCOUNT, username: USERNAME, password: PASSWORD } });
    await phase(f, withBox.job.id, ["checking"]);
    const plain = await f.runtime.dryRun(f.caller, signed(), "tour-two", { [ORIGIN]: { username: USERNAME, password: PASSWORD } });
    await phase(f, plain.job.id, ["checking"]);
    const jobs = f.runtime.queue.list("chat-a").length, disk = onDisk(f.root);
    await assert.rejects(f.runtime.record(f.caller, withBox.job.id, { [ORIGIN]: { username: USERNAME, password: PASSWORD } }), { message: `credentials for ${ORIGIN} need an account: the script's signIn declares an account box.` });
    await assert.rejects(f.runtime.record(f.caller, plain.job.id, { [ORIGIN]: { account: ACCOUNT, username: USERNAME, password: PASSWORD } }), { message: `credentials for ${ORIGIN} carry an account, but the script's signIn declares no account box.` });
    assert.equal(f.runtime.queue.list("chat-a").length, jobs);
    assert.equal(onDisk(f.root), disk);
    // Control: matching credentials record.
    const rec = await f.runtime.record(f.caller, withBox.job.id, { [ORIGIN]: { account: ACCOUNT, username: USERNAME, password: PASSWORD } });
    await phase(f, rec.job.id, ["checking"]);
  } finally { f.close(); }
});

test("a held session the site ended stops the attempt; the tour forgets that session, keeps its login, and signs in fresh next time", async () => {
  const f = setup({ staleWhenHeld: true });
  try {
    f.signIns.setStorage("chat-a", "tour-demo", [ORIGIN], STORAGE);
    f.signIns.setLogin("chat-a", "tour-demo", ORIGIN, { username: USERNAME, password: PASSWORD });
    const dry = await f.runtime.dryRun(f.caller, signed(), "tour-demo");
    const failed = await phase(f, dry.job.id, ["failed"]);
    assert.equal(failed.failure?.message, TOUR_SIGN_IN_STALE);
    assert.equal(f.signIns.storage("chat-a", "tour-demo"), undefined, "the held session is gone");
    assert.equal(f.signIns.login("chat-a", "tour-demo", ORIGIN)?.password, PASSWORD, "the login is kept");
    const again = await f.runtime.dryRun(f.caller, signed(), "tour-demo");
    await phase(f, again.job.id, ["checking"]);
    assert.equal(f.posts(), 1, "the next attempt signed in fresh, silently, from the kept login");
    assert.equal(f.needsYou.length, 0);
  } finally { f.close(); }
});
