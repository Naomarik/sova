// The runtime's look (§app.tours/look) with a stand-in runner: it runs as a no-image dry run carrying the look
// flag and sign-in route, rests in checking with its lists, never names a login value, can't be recorded, and
// keeps the tour's login for the dry run.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import type { TourJob } from "../../shared/tour";
import { stateView } from "../harness/state-view";
import { scratchRoot } from "../test-scratch";
import { tourScriptDigest } from "./checks";
import type { TourLookAnswer } from "./look";
import { TourRuntime, type TourRuntimeOptions } from "./runtime";
import type { TourToolCaller } from "./tools";

const ORIGIN = "https://example.test";
const USER = "made-up-look-unit-user";
test("a look runs as a flagged no-image dry run, rests in checking with its lists, names no login value, and can't be recorded", async () => {
  const root = scratchRoot("tour-look-unit-");
  const state = () => stateView([]);
  const caller: TourToolCaller = { sessionId: "chat-a", sessionFile: `${root}/chat.jsonl`, cwd: root, state: state() };
  const launches: Parameters<NonNullable<TourRuntimeOptions["run"]>>[0][] = [];
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const runtime = new TourRuntime({ root,
    context: { canonical: p => p, snapshot: async () => ({ sessionId: caller.sessionId, sessionFile: caller.sessionFile, cwd: root, agentDir: `${root}/agent`, state: state(), held: { on: false, enforcement: "none" } }) },
    target: async () => ({ origin: ORIGIN, assertCurrent: async () => {} }),
    run: async input => {
      launches.push(input);
      await gate;
      const controls = [{ role: "heading", name: "Dashboard", matches: 1, onFirstScreen: true, y: 0, h: 30 }, { text: `Signed in as ${USER}`, matches: 1, onFirstScreen: true, y: 40, h: 20 }];
      return { steps: [], assets: new Map(), contactSheets: [], suspicious: [], provenance: { origin: ORIGIN, recordedAt: "2026-01-02T03:04:05.000Z", publicOrigins: [] }, scriptDigest: tourScriptDigest(input.script),
        look: { signInPage: { route: "/login", url: "/login", controls: [], links: [] }, pages: [{ route: "/", desktop: { url: "/", controls, links: [`/users/${USER}`, "/settings"] }, phone: { url: "/", controls, links: [] } }] } };
    },
  } as TourRuntimeOptions);
  try {
    runtime.approvals.approve(ORIGIN);
    const signIn = { route: "/login", username: { kind: "role" as const, role: "textbox", name: "Email" }, password: { kind: "testId" as const, testId: "password" }, submit: { kind: "role" as const, role: "button", name: "Sign in" }, signedIn: { kind: "role" as const, role: "heading", name: "Dashboard" } };
    const looked = await runtime.look(caller, { source: { kind: "site", origin: ORIGIN }, signIn, pages: [{ route: "/" }] }, "tour-demo", { [ORIGIN]: { username: USER, password: "fake-pw-12" } });
    assert.equal(looked.job.tourId, "tour-demo");
    assert.deepEqual(looked.look, { tourId: "tour-demo", next: looked.look!.next }, "while it runs, what to do meanwhile");
    assert.match(looked.look!.next, /Call status/);
    for (let i = 0; i < 200 && !launches.length; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(launches[0]?.dryRun, true, "no pictures");
    assert.deepEqual(launches[0]?.look, {}, "the look flag; the sign-in route rides in the script's signIn");
    release();
    let job: TourJob | null | undefined;
    for (let i = 0; i < 400; i++) { job = runtime.queue.get("chat-a", looked.job.id); if (job?.phase === "checking" || job?.phase === "failed") break; await new Promise(r => setTimeout(r, 5)); }
    assert.equal(job?.phase, "checking", JSON.stringify(job?.failure));
    const answer = (await runtime.status(caller, looked.job.id)).look as TourLookAnswer;
    assert.ok(!JSON.stringify(answer).includes(USER), `no login value: ${JSON.stringify(answer)}`);
    assert.deepEqual(answer.pages[0]!.desktop!.controls.map(c => c.name ?? c.text), ["Dashboard"]);
    assert.equal(answer.pages[0]!.desktop!.more, 1, "the entry left out is counted");
    assert.deepEqual(answer.pages[0]!.desktop!.links, ["/settings"]);
    await assert.rejects(runtime.record(caller, looked.job.id), /Run dry-run first/);
    assert.ok(runtime.signIns.login("chat-a", "tour-demo", ORIGIN), "the tour keeps its login for the dry run");
    // Only a sign-in route: it rides to the runner as the look's route.
    const only = await runtime.look(caller, { source: { kind: "site", origin: ORIGIN }, signInRoute: "/welcome", pages: [] }, "tour-other");
    for (let i = 0; i < 400 && launches.length < 2; i++) await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(launches[1]?.look, { signInRoute: "/welcome" });
    assert.equal(only.steps, 1);
  } finally { release(); runtime.close(); rmSync(root, { recursive: true, force: true }); }
});
