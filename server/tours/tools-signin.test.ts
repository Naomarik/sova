import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ToolCtx } from "../../shared/harness";
import { normalizeTourEdition, normalizeTourJob, normalizeTourScript, redactTourToolArgs, TOUR_HIDDEN, type TourCredentials, type TourJob, type TourScriptRequest } from "../../shared/tour";
import { tourManifestFixture, tourScriptFixture } from "../../shared/tour-fixtures";
import { stateView } from "../harness/state-view";
import { setTourToolRuntime, tourTools, type TourToolJob, type TourToolRuntime } from "./tools";

// A canary login: none of its values may reach the runtime's script, a result or an error.
const USER = "canary-user-7f3a";
const PASSWORD = "fake-pw-23";
const CODE = "canary-code-4b2d";
const ORIGIN = "https://example.test";
const AT = "2026-01-02T03:04:05.000Z";
const job = (over: Partial<TourJob> = {}): TourJob => ({ v: 1, id: "job-demo", tourId: "tour-demo", sessionId: "session-demo", title: "Drafts", phase: "dry-run", completed: 0, total: 2, createdAt: AT, updatedAt: AT, ...over });
const context = (): ToolCtx => ({ sessionId: "session-demo", cwd: "/projects/demo", leafId: () => null, branch: () => [], state: () => stateView([]) });
const invoke = (params: unknown) => tourTools("session-demo", "/sessions/demo.jsonl")[0]!.execute("call-demo", params, undefined, undefined, context());
const signIn = () => ({ route: "/login", username: { kind: "role", role: "textbox", name: "Email" }, password: { kind: "testId", testId: "password" }, submit: { kind: "role", role: "button", name: "Sign in" }, signedIn: { kind: "role", role: "link", name: "Sign out" } });
const script = (over: Record<string, unknown> = {}) => ({ ...tourScriptFixture(), signIn: signIn(), ...over }) as unknown as TourScriptRequest;
const credentials = (): TourCredentials => ({ [ORIGIN]: { username: ` ${USER} `, password: PASSWORD, code: CODE } });
interface Seen { script?: unknown; credentials?: TourCredentials; calls: number }
function runtime(seen: Seen, reply: () => Promise<TourToolJob> = async () => ({ job: job(), steps: 1 })): TourToolRuntime {
  return {
    dryRun: async (_c, s, _t, c) => { seen.calls++; seen.script = s; seen.credentials = c; return reply(); },
    record: async (_c, _d, c) => { seen.calls++; seen.credentials = c; return reply(); },
    status: reply, cancel: reply, check: reply,
    inspect: async () => ({ result: await reply(), content: [] }),
    show: async () => tourManifestFixture(),
  };
}
const carries = (v: unknown) => [USER, PASSWORD, CODE].some(x => (typeof v === "string" ? v : JSON.stringify(v)).includes(x));
afterEach(() => setTourToolRuntime(undefined));

test("a script's signIn names its login boxes by role or test id only, refused by name before the runtime", async () => {
  const seen: Seen = { calls: 0 }; setTourToolRuntime(runtime(seen));
  await assert.rejects(invoke({ op: "dry-run", script: script({ signIn: { ...signIn(), password: { kind: "text", text: PASSWORD } } }) }), (e: Error) => {
    assert.equal(e.message, "signIn.password must name the box by role or testId, never by text.");
    return true;
  });
  const { submit: _submit, ...noSubmit } = signIn();
  await assert.rejects(invoke({ op: "dry-run", script: script({ signIn: noSubmit }) }), /^Error: signIn needs submit\./);
  await assert.rejects(invoke({ op: "dry-run", script: script({ signIn: { ...signIn(), value: PASSWORD } }) }), (e: Error) => {
    assert.match(e.message, /^signIn has a field it doesn't take: value\./);
    assert.ok(!carries(e.message));
    return true;
  });
  await assert.rejects(invoke({ op: "dry-run", script: script({ signIn: { ...signIn(), route: "https://example.test/login" } }) }), /signIn\.route must be/);
  assert.equal(seen.calls, 0);
  // Control: the same script with role and test-id boxes reaches the runtime.
  await invoke({ op: "dry-run", script: script() });
  assert.equal(seen.calls, 1);
  assert.deepEqual((seen.script as { signIn: unknown }).signIn, signIn());
  assert.ok(normalizeTourScript(script()), "a stored script keeps its signIn");
  assert.equal(normalizeTourScript(script({ signIn: { ...signIn(), username: { kind: "text", text: "Email" } } })), undefined);
});

test("supplied credentials reach the runtime beside the script, never inside it, and never come back", async () => {
  const seen: Seen = { calls: 0 }; setTourToolRuntime(runtime(seen));
  const result = await invoke({ op: "dry-run", script: script(), credentials: credentials() });
  assert.deepEqual(seen.credentials, { [ORIGIN]: { username: USER, password: PASSWORD, code: CODE } }, "usernames are trimmed");
  assert.ok(!carries(seen.script), "the script the runtime gets carries no login");
  assert.ok(!carries(result), "the tool result carries no login");
  await invoke({ op: "record", dryRunId: "job-demo", credentials: credentials() });
  assert.equal(seen.credentials?.[ORIGIN]?.password, PASSWORD);
});

test("malformed credentials are refused by field and origin, never by value, before the runtime", async () => {
  const seen: Seen = { calls: 0 }; setTourToolRuntime(runtime(seen));
  const refusals: [unknown, Record<string, unknown>, RegExp][] = [
    [tourScriptFixture(), credentials(), /^credentials need a signIn in the script/],
    [script(), { "https://other.test": { username: USER, password: PASSWORD } }, /^credentials for https:\/\/other\.test: that isn't one of this script's sign-in origins \(https:\/\/example\.test\)\.$/],
    [script(), { [ORIGIN]: { username: USER, password: "" } }, /need a password of 1 to 4096 characters/],
    [script(), { [ORIGIN]: { username: "   ", password: PASSWORD } }, /need a username of 1 to 512 characters/],
    [script(), { [ORIGIN]: { username: USER, password: PASSWORD, token: PASSWORD } }, /take only account, username, password and code/],
    [script(), { [PASSWORD]: { username: USER, password: PASSWORD } }, /keyed by exact http\(s\) origins/],
  ];
  for (const [s, c, pattern] of refusals) {
    await assert.rejects(invoke({ op: "dry-run", script: s, credentials: c }), (e: Error) => {
      assert.match(e.message, pattern);
      assert.ok(!carries(e.message), e.message);
      return true;
    });
  }
  await assert.rejects(invoke({ op: "record", dryRunId: "job-demo", credentials: { [ORIGIN]: { username: USER } } }), /need a password/);
  assert.equal(seen.calls, 0);
});

test("a login value inside the tour itself is refused before anything is written or run", async () => {
  const seen: Seen = { calls: 0 }; setTourToolRuntime(runtime(seen));
  const leaky = script({ summary: `Sign in as ${USER} first.` });
  await assert.rejects(invoke({ op: "dry-run", script: leaky, credentials: credentials() }), (e: Error) => {
    assert.equal(e.message, "A sign-in detail appears in the tour itself (a username that also appears in a route counts). Keep logins only in credentials.");
    return true;
  });
  assert.equal(seen.calls, 0);
  // Control: the same summary with no credentials supplied isn't scanned for anything.
  await invoke({ op: "dry-run", script: leaky });
  assert.equal(seen.calls, 1);
});

test("an answer or failure that mentions a supplied login is replaced, never shown", async () => {
  const seen: Seen = { calls: 0 };
  setTourToolRuntime(runtime(seen, async () => ({ job: job({ title: `Signed in as ${USER}` }), steps: 1 })));
  await assert.rejects(invoke({ op: "dry-run", script: script(), credentials: credentials() }), (e: Error) => {
    assert.match(e.message, /mentioned a sign-in detail, so it isn't shown/);
    assert.ok(!carries(e.message));
    return true;
  });
  setTourToolRuntime(runtime(seen, async () => { throw new Error(`Login ${PASSWORD} was refused`); }));
  await assert.rejects(invoke({ op: "record", dryRunId: "job-demo", credentials: credentials() }), (e: Error) => {
    assert.ok(!carries(e.message), e.message);
    return true;
  });
  // Control: without supplied credentials an ordinary failure keeps its message.
  setTourToolRuntime(runtime(seen, async () => { throw new Error("The copy is stopped."); }));
  await assert.rejects(invoke({ op: "record", dryRunId: "job-demo" }), /^Error: The copy is stopped\.$/);
});

test("record_tour's arguments are shown with credentials hidden, and nothing else changes", () => {
  const args = { op: "dry-run", script: { title: "T" }, credentials: credentials() };
  const shown = redactTourToolArgs("record_tour", args);
  assert.deepEqual(shown, { op: "dry-run", script: { title: "T" }, credentials: TOUR_HIDDEN });
  assert.ok(!carries(shown));
  assert.ok(carries(args), "the original arguments are not mutated");
  const plain = { op: "status", jobId: "j" };
  assert.equal(redactTourToolArgs("record_tour", plain), plain, "arguments without credentials pass as they are");
  const other = { credentials: "x" };
  assert.equal(redactTourToolArgs("bash", other), other, "other tools' arguments are untouched");
});

test("a needs-sign-in job carries exactly its sign-in requirement, and a signed-in edition says so", () => {
  const signInReq = { origin: ORIGIN, kind: "form", fields: ["username", "password"] };
  assert.ok(normalizeTourJob(job({ phase: "needs-sign-in", requirements: { signIn: signInReq as any } })));
  assert.ok(normalizeTourJob(job({ phase: "needs-sign-in", requirements: { signIn: { ...signInReq, fields: ["code"] } as any } })));
  assert.equal(normalizeTourJob(job({ phase: "needs-sign-in" })), undefined, "the phase needs its requirement");
  assert.equal(normalizeTourJob(job({ phase: "dry-run", requirements: { signIn: signInReq as any } })), undefined, "the requirement needs its phase");
  assert.equal(normalizeTourJob(job({ phase: "needs-sign-in", requirements: { signIn: { ...signInReq, fields: ["password"] } as any } })), undefined);
  assert.equal(normalizeTourJob(job({ phase: "needs-sign-in", requirements: { signIn: { ...signInReq, password: PASSWORD } as any } })), undefined, "no value field");
  assert.equal(normalizeTourJob(job({ phase: "needs-sign-in", requirements: { signIn: signInReq as any, testAccount: { origin: ORIGIN, kind: "http-basic" } } })), undefined);
  assert.equal(normalizeTourJob(job({ quietAborts: 3 }))?.quietAborts, 3);
  assert.equal(normalizeTourJob(job({ quietAborts: -1 })), undefined);
  const edition = { v: 1, sessionId: "session-demo", source: { kind: "site", origin: ORIGIN }, manifest: tourManifestFixture(), provenance: { origin: ORIGIN, recordedAt: AT } };
  assert.ok(normalizeTourEdition(edition));
  assert.equal(normalizeTourEdition({ ...edition, provenance: { ...edition.provenance, signedIn: true } })?.provenance.signedIn, true);
  assert.equal(normalizeTourEdition({ ...edition, provenance: { ...edition.provenance, signedIn: false } }), undefined);
});

test("the guide's signIn example is a valid signIn, checked by the same validator", async () => {
  const { readFileSync } = await import("node:fs");
  const { tourSignInProblem } = await import("../../shared/tour");
  const guide = readFileSync(new URL("../../pi-config/extensions/mode/vis/tour-signin.md", import.meta.url), "utf8");
  const examples = [...guide.matchAll(/`"signIn":(\{.*\})`/g)].map(m => JSON.parse(m[1]!));
  assert.equal(examples.length, 2, "the guide shows two signIn examples: plain, and with an account box");
  for (const example of examples) {
    assert.equal(tourSignInProblem(example), null);
    assert.ok(normalizeTourScript({ ...tourScriptFixture(), signIn: example }));
  }
  assert.equal(examples.filter(e => e.account !== undefined).length, 1, "one example declares an account box");
});
