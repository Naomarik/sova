import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { ReleaseFixture, until } from "../../scripts/e2e-release/fixtures";
import { startReleaseServer, type ModelAction, type ReleaseServer } from "../../scripts/e2e-release/server-kit";

/**
 * Release end to end (al_1) on one hermetic Sova against scratch projects (scripts/e2e-release/): the operator
 * route, the release chat's own tool through the scripted stand-in model, and the facts read from git, never only
 * Sova's view. Scenario ids are E2E-PLAN.md's.
 */

let k: ReleaseServer;
const fixtures: ReleaseFixture[] = [];
const fixture = (o: ConstructorParameters<typeof ReleaseFixture>[0] = {}) => {
  const fx = new ReleaseFixture({ under: k.hs.scratch, ...o });
  fixtures.push(fx);
  return fx;
};

before(async () => {
  k = await startReleaseServer();
});
after(async () => {
  const changes = await k?.stop();
  for (const fx of fixtures) fx.dispose();
  assert.deepEqual(changes ?? [], [], "the sentinel home is untouched");
});

test("S1: a project with no release pointer reads not initialized, and Start is refused", async () => {
  const fx = fixture({ kind: "bare" });
  await k.register(fx.project, fx.name);
  const s = await k.verb("release.status", { project: fx.project });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  assert.equal(s.json.release?.view?.initialized, false, JSON.stringify(s.json));
  const before = fx.facts();
  const start = await k.verb("release.start", { project: fx.project });
  assert.notEqual(start.status, 200, JSON.stringify(start.json));
  assert.deepEqual(fx.facts(), before, "nothing moved");
});

test("S7: history from the numbered tags, newest first, stable badge and landings since", async () => {
  const fx = fixture({ versions: ["0.1.0", "0.2.0"] });
  fx.seedLandings(3);
  await k.register(fx.project, fx.name);
  const s = await k.verb("release.status", { project: fx.project });
  const view = s.json.release?.view;
  assert.equal(view?.initialized, true, JSON.stringify(s.json));
  assert.deepEqual(view.history.map((h: { tag: string }) => h.tag), ["v0.2.0", "v0.1.0"]);
  assert.deepEqual(view.history[0].channels, ["stable"]);
  assert.equal(view.history[0].sha, fx.tagAt("v0.2.0"));
  assert.match(view.history[0].notes ?? "", /release 0\.2\.0/);
  assert.equal(view.latest, "v0.2.0");
  assert.equal(view.landingsSince, 3);
  assert.equal(view.remote, true);
});

// ------------------------------------------------------------------ authority (t17, q3, q10)

interface Session { id: string; path: string }
const ROOT = new URL("../..", import.meta.url).pathname;

/** A coding chat in the project, whose model runs `actions` on the next prompt (tool results come back in the log). */
async function codingChatDoes(fx: ReleaseFixture, tag: string, actions: ModelAction[]): Promise<string[]> {
  const ses = (await k.http("POST", "/api/sessions", { cwd: fx.project })).json as Session;
  assert.ok(ses.path, `a coding session: ${JSON.stringify(ses)}`);
  const m = `[coding ${tag}]`;
  await k.model.script(m, [...actions, { text: "Done." }]);
  const sent = await k.http("POST", "/api/sessions/prompt", { path: ses.path, text: `${m} please` });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  await until(`coding chat ${tag} to finish`, async () => (await k.model.log()).some((e) => e.match === m && e.action?.text === "Done."), 120_000, 100);
  const log = (await k.model.log()).filter((e) => e.match === m);
  for (const e of log) assert.equal(e.missing, undefined, `the coding chat has the tool ${e.missing}`);
  // Each tool call's result is the newest tool message of the request after it.
  return log.slice(1).map((e) => e.toolResults.at(-1) ?? "");
}

test("S12/S32: a coding chat's project_verbs may read releases, never step, start, ask, publish or withdraw", async () => {
  const fx = fixture();
  await k.register(fx.project, fx.name);
  const before = fx.facts();
  const pv = (verb: string, extra: Record<string, unknown> = {}): ModelAction => ({ tool: "project_verbs", args: { verb, project: fx.project, ...extra } });
  const results = await codingChatDoes(fx, "s12", [
    pv("release.status"),
    pv("release.step", { step: "version", state: "done", summary: "v9.9.9", facts: ["version=9.9.9"] }),
    pv("release.notes", { text: "nope" }),
    pv("release.start"),
    pv("release.request", { why: "please" }),
    // A coding chat's tool has no confirm key at all; authority is checked before the confirm, so these answer
    // forbidden, never needs-confirm.
    pv("release.publish"),
    pv("release.withdraw", { tag: "v0.1.0", why: "x" }),
  ]);
  assert.equal(results.length, 7, JSON.stringify(results));
  assert.doesNotMatch(results[0]!, /forbidden/i, `status is a read: ${results[0]}`);
  for (const [i, r] of results.slice(1).entries()) assert.match(r, /forbidden/i, `call ${i + 1} refused: ${r}`);
  assert.deepEqual(fx.facts(), before, "no tag, channel or master moved");
  assert.equal((await k.verb("release.status", { project: fx.project })).json.release?.view?.open ?? null, null, "no release opened");
});

test("S12: release.step and release.notes are refused on the operator route", async () => {
  const fx = fixture();
  await k.register(fx.project, fx.name);
  for (const [verb, body] of [["release.step", { step: "version", state: "done", summary: "x" }], ["release.notes", { text: "x" }]] as const) {
    const r = await k.verb(verb, { project: fx.project, ...body });
    assert.equal(r.json.error?.code, "forbidden", `${verb}: ${JSON.stringify(r.json)}`);
  }
});

test("S13: a chat's script with the operator token can't start, publish or withdraw (x-sova-caller)", async () => {
  const fx = fixture();
  await k.register(fx.project, fx.name);
  const before = fx.facts();
  // As a chat's script sends it: the token plus the chat's own caller key (any key: the route refuses on its presence).
  for (const [verb, body] of [
    ["release.start", {}],
    ["release.publish", { confirm: true }],
    ["release.withdraw", { tag: "v0.1.0", why: "x", confirm: true }],
    ["release.abandon", { why: "x", confirm: true }],
  ] as const) {
    const r = await k.verb(verb, { project: fx.project, ...body }, { callerKey: "ck_fake-chat-key-0001" });
    assert.equal(r.json.error?.code, "forbidden", `${verb}: ${JSON.stringify(r.json)}`);
  }
  assert.deepEqual(fx.facts(), before);
});

test("S13 (real path): a coding chat's script calling scripts/sova-project.mjs release.start is refused, token or not", async () => {
  const fx = fixture();
  await k.register(fx.project, fx.name);
  const before = fx.facts();
  // --url always: a chat's CLI must never fall back to port 4800 (the live server).
  const cli = `node ${ROOT}scripts/sova-project.mjs release.start --project ${fx.project} --url ${k.base}`;
  const [plain, withToken, stripped] = await codingChatDoes(fx, "s13", [
    // What any script a chat runs gets: no token of its own (401) or, if it read one, its caller key rides along.
    { tool: "bash", args: { command: `${cli}; echo "exit=$?"` } },
    // A script that got hold of the operator token: SOVA_CALLER_KEY (set in every chat process) still rides along.
    { tool: "bash", args: { command: `SOVA_TOKEN=${k.hs.token} ${cli}; echo "exit=$?"` } },
    // The known gap (CONTRACT §5 t17): a script that drops its caller key and has the token reads as the operator.
    // Recorded, not asserted; it must not leave a release open for the next tests, so it is abandoned below.
    { tool: "bash", args: { command: `env -u SOVA_CALLER_KEY SOVA_TOKEN=${k.hs.token} ${cli}; echo "exit=$?"` } },
  ]);
  assert.match(plain ?? "", /Unauthorized|forbidden/i, plain);
  assert.match(withToken ?? "", /forbidden|never acts as the operator/i, withToken);
  assert.doesNotMatch(withToken ?? "", /exit=0/, `a refusal exits non-zero: ${withToken}`);
  const open = (await k.verb("release.status", { project: fx.project })).json.release?.view?.open ?? null;
  const gap = `known gap (t17): a header-stripped script with the token ${open ? "STARTED a release" : "was refused"}: ${(stripped ?? "").replace(/\s+/g, " ").slice(0, 200)}`;
  if (process.env.E2E_RELEASE_NOTES) appendFileSync(process.env.E2E_RELEASE_NOTES, `${gap}\n`);
  if (open) await k.verb("release.abandon", { project: fx.project, release: open.id, why: "gap probe", confirm: true });
  assert.deepEqual(fx.facts().tags, before.tags, "no tag moved");
});
