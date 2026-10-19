// A sign-in with an account box before the username (a site's pre-filled code box, for example): the box is named by
// role or test id only, the account travels in credentials exactly when the script declares the box, and its value is
// as secret as the username (§app.tours/authoring, §app.tours/sites).
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ToolCtx } from "../../shared/harness";
import { normalizeTourJob, redactTourToolArgs, TOUR_CREDENTIALS_IN_SCRIPT, TOUR_HIDDEN, type TourCredentials, type TourJob, type TourScriptRequest } from "../../shared/tour";
import { tourManifestFixture, tourScriptFixture } from "../../shared/tour-fixtures";
import { stateView } from "../harness/state-view";
import { setTourToolRuntime, tourTools, type TourToolJob, type TourToolRuntime } from "./tools";

const ACCOUNT = "canary-acct-6d0e";
const USER = "canary-user-1b8c";
const PASSWORD = "fake-pw-22";
const ORIGIN = "https://app.example.test";
const AT = "2026-01-02T03:04:05.000Z";
const job = (over: Partial<TourJob> = {}): TourJob => ({ v: 1, id: "job-demo", tourId: "tour-demo", sessionId: "session-demo", title: "Drafts", phase: "dry-run", completed: 0, total: 2, createdAt: AT, updatedAt: AT, ...over });
const context = (): ToolCtx => ({ sessionId: "session-demo", cwd: "/projects/demo", leafId: () => null, branch: () => [], state: () => stateView([]) });
const invoke = (params: unknown) => tourTools("session-demo", "/sessions/demo.jsonl")[0]!.execute("call-demo", params, undefined, undefined, context());
const plain = () => ({ route: "/login", username: { kind: "role", role: "textbox", name: "Username" }, password: { kind: "testId", testId: "password" }, submit: { kind: "role", role: "button", name: "Sign in" }, signedIn: { kind: "role", role: "heading", name: "Dashboard" } });
const withAccount = () => ({ ...plain(), account: { kind: "role", role: "textbox", name: "Company code" } });
const script = (signIn: unknown) => ({ ...tourScriptFixture(), source: { kind: "site", origin: ORIGIN }, signIn }) as unknown as TourScriptRequest;
const login = (over: Record<string, unknown> = {}) => ({ [ORIGIN]: { account: ` ${ACCOUNT} `, username: USER, password: PASSWORD, ...over } });
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
const carries = (v: unknown) => [ACCOUNT, USER, PASSWORD].some(x => (typeof v === "string" ? v : JSON.stringify(v) ?? "").includes(x));
afterEach(() => setTourToolRuntime(undefined));

test("signIn.account names its box by role or test id only, refused by name before the runtime", async () => {
  const seen: Seen = { calls: 0 }; setTourToolRuntime(runtime(seen));
  await assert.rejects(invoke({ op: "dry-run", script: script({ ...withAccount(), account: { kind: "text", text: ACCOUNT } }), credentials: login() }), (e: Error) => {
    assert.equal(e.message, "signIn.account must name the box by role or testId, never by text.");
    return true;
  });
  await assert.rejects(invoke({ op: "dry-run", script: script({ ...withAccount(), account: "Company code" }) }), /^Error: signIn\.account must be a target/);
  assert.equal(seen.calls, 0);
  // Control: a role box reaches the runtime, with the account trimmed beside the script and never in it.
  await invoke({ op: "dry-run", script: script(withAccount()), credentials: login() });
  assert.equal(seen.calls, 1);
  assert.deepEqual((seen.script as { signIn: unknown }).signIn, withAccount());
  assert.deepEqual(seen.credentials, { [ORIGIN]: { account: ACCOUNT, username: USER, password: PASSWORD } });
  assert.ok(!carries(seen.script));
});

test("an account goes in credentials exactly when the script declares the box: a missing or extra one is refused by name", async () => {
  const seen: Seen = { calls: 0 }; setTourToolRuntime(runtime(seen));
  const refusals: [unknown, unknown, string | RegExp][] = [
    [withAccount(), { [ORIGIN]: { username: USER, password: PASSWORD } }, `credentials for ${ORIGIN} need an account: the script's signIn declares an account box.`],
    [plain(), login(), `credentials for ${ORIGIN} carry an account, but the script's signIn declares no account box.`],
    [withAccount(), login({ account: "   " }), /account must be 1 to 512 characters/],
    [withAccount(), login({ account: "x".repeat(513) }), /account must be 1 to 512 characters/],
    [withAccount(), login({ account: `${ACCOUNT}\u0007` }), /account must be 1 to 512 characters/],
  ];
  for (const [signIn, credentials, expected] of refusals) {
    await assert.rejects(invoke({ op: "dry-run", script: script(signIn), credentials }), (e: Error) => {
      if (typeof expected === "string") assert.equal(e.message, expected); else assert.match(e.message, expected);
      assert.ok(!carries(e.message), e.message);
      return true;
    });
  }
  assert.equal(seen.calls, 0, "nothing ran");
  // Control: no account and no box still records as before.
  await invoke({ op: "dry-run", script: script(plain()), credentials: { [ORIGIN]: { username: USER, password: PASSWORD } } });
  assert.equal(seen.calls, 1);
});

test("an account value inside the tour itself is refused before anything runs, and a failure naming it is replaced", async () => {
  const seen: Seen = { calls: 0 }; setTourToolRuntime(runtime(seen));
  const leaky = { ...script(withAccount()), summary: `Use the code ${ACCOUNT} first.` };
  await assert.rejects(invoke({ op: "dry-run", script: leaky, credentials: login() }), (e: Error) => {
    assert.equal(e.message, TOUR_CREDENTIALS_IN_SCRIPT);
    return true;
  });
  const inRoute = { ...script(withAccount()), steps: [{ ...tourScriptFixture().steps[0]!, views: tourScriptFixture().steps[0]!.views.map(v => ({ ...v, route: `/places/${encodeURIComponent(ACCOUNT)}` })) }] };
  await assert.rejects(invoke({ op: "dry-run", script: inRoute, credentials: login() }), (e: Error) => e.message === TOUR_CREDENTIALS_IN_SCRIPT);
  assert.equal(seen.calls, 0);
  // Control: the same leaky summary with no credentials isn't scanned.
  await invoke({ op: "dry-run", script: leaky });
  assert.equal(seen.calls, 1);
  setTourToolRuntime(runtime(seen, async () => { throw new Error(`Company ${ACCOUNT} not found`); }));
  await assert.rejects(invoke({ op: "dry-run", script: script(withAccount()), credentials: login() }), (e: Error) => {
    assert.ok(!carries(e.message), e.message);
    return true;
  });
});

test("the account form of a sign-in requirement, and the account hidden in record_tour's shown arguments", () => {
  const req = (fields: unknown) => normalizeTourJob(job({ phase: "needs-sign-in", requirements: { signIn: { origin: ORIGIN, kind: "form", fields } as any } }));
  assert.deepEqual(req(["account", "username", "password"])?.requirements?.signIn?.fields, ["account", "username", "password"]);
  assert.ok(req(["username", "password"]), "control: the plain form still holds");
  for (const bad of [["account", "password"], ["username", "password", "account"], ["account,username", "password"], ["account"]]) assert.equal(req(bad), undefined, JSON.stringify(bad));
  const args = { op: "dry-run", script: { title: "T" }, credentials: login() };
  const shown = redactTourToolArgs("record_tour", args);
  assert.equal((shown as { credentials: unknown }).credentials, TOUR_HIDDEN);
  assert.ok(!carries(shown));
});
