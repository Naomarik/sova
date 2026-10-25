// A mark the recorder keeps always fits the published picture, even when its target sits a fraction of a
// pixel past the screen's edge (the capture check's slack); and a recording that fails for a reason the
// recorder didn't name logs what threw, never a login value (§app.tours/recording).
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Page } from "playwright-core";
import { normalizeTourManifest, type TourJob, type TourScript } from "../../shared/tour";
import { tourManifestFixture, tourScriptFixture } from "../../shared/tour-fixtures";
import { stateView } from "../harness/state-view";
import { scratchRoot } from "../test-scratch";
import { TourJobQueue } from "./queue";
import { TourRuntime, type TourRuntimeOptions } from "./runtime";
import { tourMark } from "./targets";
import type { TourToolCaller } from "./tools";

/** A page whose one target holds still at `box`. */
function pageWith(box: { x: number; y: number; width: number; height: number }): Page {
  const page: Record<string, unknown> = { evaluate: async () => {} };
  const locator: Record<string, unknown> = { filter: () => locator, waitFor: async () => {}, count: async () => 1, boundingBox: async () => ({ ...box }), page: () => page };
  page.getByRole = () => locator;
  return page as unknown as Page;
}

test("a phone mark a fraction of a pixel past the bottom edge is clamped, and its edition passes the manifest check", async () => {
  const viewport = { w: 390, h: 844 };
  const mark = await tourMark(pageWith({ x: 0, y: 800, width: 390, height: 44.2 }), { kind: "role", role: "heading", name: "Saved drafts" }, viewport, { n: 1, label: "Here.", side: "top" });
  assert.ok(mark.y + mark.h <= 1 && mark.x + mark.w <= 1, JSON.stringify(mark));
  assert.ok(Math.abs(mark.h * 844 - 44) < 1e-9, "only the part past the edge is cut");
  const manifest = tourManifestFixture();
  manifest.steps[0]!.views[0]!.captures.phone!.marks = [mark];
  assert.ok(normalizeTourManifest(manifest), "the edition built from it is valid");
});

const AT = "2026-01-02T03:04:05.000Z";
async function failedOnce(queue: TourJobQueue, sessionId: string, id: string): Promise<TourJob> {
  for (let i = 0; i < 400; i++) { const j = queue.get(sessionId, id)!; if (j.phase === "failed") return j; await new Promise(r => setTimeout(r, 5)); }
  throw new Error("never failed");
}

test("an unexplained failure stays generic in the job, and the server log says what threw", async () => {
  const root = scratchRoot("tour-queue-log-");
  const lines: string[] = [];
  const queue = new TourJobQueue({ root, log: line => lines.push(line) });
  try {
    const job = queue.enqueue({ sessionId: "chat-a", tourId: "tour-a", title: "T", total: 1 }, async () => { throw new Error("The recording is incomplete. No edition was published."); });
    const failed = await failedOnce(queue, "chat-a", job.id);
    assert.equal(failed.failure?.message, "Recording could not finish.");
    assert.deepEqual(lines, [`[tours] recording ${job.id} could not finish: The recording is incomplete. No edition was published.`]);
    void AT;
  } finally { queue.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a thrown message carrying a login value is logged without it", async () => {
  const root = scratchRoot("tour-queue-redact-");
  const ORIGIN = "https://example.test", PASSWORD = "fake-pw-07";
  const lines: string[] = [];
  const state = () => stateView([]);
  const caller: TourToolCaller = { sessionId: "chat-a", sessionFile: join(root, "chat.jsonl"), cwd: root, state: state() };
  const signed: TourScript = { ...tourScriptFixture(), signIn: { route: "/login", username: { kind: "role", role: "textbox", name: "Username" }, password: { kind: "testId", testId: "password" }, submit: { kind: "role", role: "button", name: "Sign in" }, signedIn: { kind: "role", role: "heading", name: "Saved drafts" } } };
  const runtime = new TourRuntime({ root, queue: new TourJobQueue({ root: join(root, "tour-jobs"), log: line => lines.push(line) }),
    context: { canonical: p => p, snapshot: async () => ({ sessionId: caller.sessionId, sessionFile: caller.sessionFile, cwd: root, agentDir: `${root}/agent`, state: state(), held: { on: false, enforcement: "none" } }) },
    target: async () => ({ origin: ORIGIN, assertCurrent: async () => {} }) as never,
    run: async () => { throw new Error(`page said: wrong password ${PASSWORD}`); },
  } as TourRuntimeOptions);
  try {
    runtime.approvals.approve(ORIGIN);
    const dry = await runtime.dryRun(caller, signed, "tour-demo", { [ORIGIN]: { username: "made-up-user", password: PASSWORD } });
    await failedOnce(runtime.queue, "chat-a", dry.job.id);
    assert.equal(lines.length, 1);
    assert.ok(!lines[0]!.includes(PASSWORD), lines[0]);
    assert.match(lines[0]!, /could not finish: \(a message that mentions a sign-in detail, not shown\)/);
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
});
