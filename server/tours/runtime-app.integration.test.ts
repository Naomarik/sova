import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tourScriptFixture } from "../../shared/tour-fixtures";
import type { TourJob } from "../../shared/tour";
import { createTourRouteFixture } from "./route-fixture.integration.fixture";

// Route wiring and main-listener auth only. Durable jobs are seeded fixtures, not browser evidence.
// Every request crosses the actual buildApp HTTP adapter; app.request's trusted bypass is not used.
test("real app mounts tour job routes behind token, origin, ownership and durable deletion gates", { timeout: 60_000 }, async () => {
  const f = await createTourRouteFixture();
  try {
    const { ensureTourToolRuntime } = await import("./runtime");
    const { TourJobBlocked } = await import("./queue");
    const { markTourSessionDeleted } = await import("./deleted");
    const runtime = ensureTourToolRuntime();
    const consentOrigin = "https://tour-consent.example.test", accountOrigin = "https://tour-account.example.test";
    const privateAudience = "PRIVATE_ROUTE_FIXTURE_AUDIENCE", password = "fake-pw-11";
    async function seed(tourId: string, origin: string, requirement: NonNullable<TourJob["requirements"]>) {
      const script = tourScriptFixture(); script.source = { kind: "site", origin }; script.audience = privateAudience;
      const job = runtime.queue.enqueue({ sessionId: f.sid, tourId, title: script.title, total: 2 }, async current => {
        const authorized = requirement.origins ? runtime.approvals.isApproved(origin) : !!runtime.artifacts.read(f.sid, current.id)?.script.accountId;
        if (!authorized) throw new TourJobBlocked(requirement);
        return { phase: "checking" };
      });
      runtime.artifacts.save({ v: 1, sessionId: f.sid, jobId: job.id, tourId, script, mode: "dry-run", suspicious: [], receipts: [], report: job });
      await new Promise<void>(resolve => queueMicrotask(resolve));
      await runtime.queue.waitForSessionIdle(f.sid);
      return job;
    }
    const consent = await seed("app-consent-tour", consentOrigin, { origins: [consentOrigin] });
    const account = await seed("app-account-tour", accountOrigin, { testAccount: { origin: accountOrigin, kind: "http-basic", reason: "Use a made-up test account for this fixture." } });
    assert.equal(runtime.queue.get(f.sid, consent.id)?.phase, "needs-site-approval");
    assert.equal(runtime.queue.get(f.sid, account.id)?.phase, "needs-test-account");
    const jobPath = `/api/tours/${f.sid}/jobs/${consent.id}`, accountPath = `/api/tours/${f.sid}/jobs/${account.id}`;
    const latestPath = `/api/tours/${f.sid}/app-consent-tour`, reRecordPath = `/api/tours/${f.sid}/absent-tour/re-record`;
    const send = async (path: string, method = "GET", body?: string, authenticated = true, extra: Record<string, string> = {}) => fetch(`${f.mainURL}${path}`, {
      method, body,
      headers: { ...(authenticated ? { Cookie: f.ownerCookie } : {}), Origin: f.mainURL, "Sec-Fetch-Site": "same-origin", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...extra },
    });
    const routes = [
      { path: jobPath, method: "GET" }, { path: `${jobPath}/cancel`, method: "POST" },
      { path: `${jobPath}/approve`, method: "POST" }, { path: `${accountPath}/account`, method: "POST" },
      { path: latestPath, method: "GET" }, { path: reRecordPath, method: "POST" },
    ];
    for (const route of routes) {
      const denied = await send(route.path, route.method, route.method === "POST" ? "{}" : undefined, false);
      assert.equal(denied.status, 401, `${route.method} ${route.path} is protected on the actual listener`);
      assert.ok(!(await denied.text()).includes(f.ownerCookie));
    }
    assert.equal(runtime.approvals.isApproved(consentOrigin), false, "unauthenticated routes changed no consent");
    const crossSite = await send(`${jobPath}/cancel`, "POST", "{}", true, { Origin: "https://not-this-app.example.test", "Sec-Fetch-Site": "cross-site" });
    assert.equal(crossSite.status, 403, "even a valid cookie cannot authorize a foreign page");
    const status = await send(jobPath); assert.equal(status.status, 200);
    const statusText = await status.text(); assert.equal(JSON.parse(statusText).id, consent.id);
    assert.ok(!statusText.includes(privateAudience)); assert.ok(!statusText.includes("script"));
    const latest = await send(latestPath); assert.equal(latest.status, 200);
    assert.equal((await latest.json() as { job: TourJob }).job.id, consent.id);
    const wrongOwner = await send(jobPath.replace(f.sid, "missing-chat")); assert.equal(wrongOwner.status, 404);
    const forgedApproval = await send(`${jobPath}/approve`, "POST", JSON.stringify({ origin: consentOrigin, sessionId: "missing-chat" }));
    assert.equal(forgedApproval.status, 400); assert.equal(runtime.approvals.isApproved(consentOrigin), false);
    const approved = await send(`${jobPath}/approve`, "POST", JSON.stringify({ origin: consentOrigin })); assert.equal(approved.status, 200);
    await runtime.queue.waitForSessionIdle(f.sid);
    assert.equal(runtime.approvals.isApproved(consentOrigin), true);
    assert.equal(runtime.queue.get(f.sid, consent.id)?.phase, "checking");
    const saved = await send(`${accountPath}/account`, "POST", JSON.stringify({ origin: accountOrigin, username: "fixture-reviewer", password, testAccount: true }));
    assert.equal(saved.status, 200); assert.ok(!(await saved.text()).includes(password));
    await runtime.queue.waitForSessionIdle(f.sid);
    assert.equal(runtime.queue.get(f.sid, account.id)?.phase, "checking");
    const privateAttempt = runtime.artifacts.read(f.sid, account.id)!;
    assert.ok(privateAttempt.script.accountId); assert.ok(!JSON.stringify(privateAttempt).includes(password));
    const cancelled = await send(`${jobPath}/cancel`, "POST", JSON.stringify({ sessionId: "missing-chat", cwd: "/forged" }));
    assert.equal(cancelled.status, 200); assert.equal((await cancelled.json() as TourJob).phase, "cancelled");
    assert.equal(runtime.queue.get(f.sid, account.id)?.phase, "checking", "cancel authority comes from the route's own chat/job, not body fields");
    const forgedReRecord = await send(reRecordPath, "POST", JSON.stringify({ sessionId: "missing-chat" })); assert.equal(forgedReRecord.status, 400);
    const absentEdition = await send(reRecordPath, "POST", "{}"); assert.equal(absentEdition.status, 409);
    assert.equal((await absentEdition.json() as { code: string }).code, "recording-refused", "re-record reached its real handler, not a missing-route fallback");
    // A chat deleted while a write body is still arriving answers the indistinguishable 404, never 400/409.
    // The headers arrive first, so the request is past the app gates when the (malformed) body follows.
    const { request } = await import("node:http");
    const { unlinkSync } = await import("node:fs");
    const { digest } = await import("./assets");
    const marker = join(f.stateRoot, "tour-deleted", `${digest(f.sid)}.json`);
    const url = new URL(f.mainURL);
    const streamed = (path: string, during: () => void) => new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: Number(url.port), path, method: "POST", agent: false, headers: { Cookie: f.ownerCookie, Origin: f.mainURL, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json", "Content-Length": "4" } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 500)); });
      req.on("error", reject); req.flushHeaders();
      setTimeout(() => { try { during(); } catch (error) { reject(error); } req.end("{bad"); }, 300);
    });
    for (const path of [`${jobPath}/approve`, `${accountPath}/account`, reRecordPath]) {
      assert.equal(await streamed(path, () => {}), 400, `positive control: a live owner's malformed body at ${path} is a 400`);
      try { assert.equal(await streamed(path, () => markTourSessionDeleted(f.stateRoot, f.sid)), 404, `${path}: deleted during body admission`); }
      finally { unlinkSync(marker); }
    }
    // Keep source and private/job files deliberately present: the durable barrier itself must hide them.
    assert.ok(existsSync(f.sessionFile)); assert.ok(runtime.artifacts.read(f.sid, account.id));
    markTourSessionDeleted(f.stateRoot, f.sid);
    assert.ok(existsSync(f.sessionFile)); assert.ok(runtime.artifacts.read(f.sid, account.id));
    for (const route of routes) {
      const body = route.method === "POST" ? "{" : undefined;
      const deleted = await send(route.path, route.method, body);
      const absent = await send(route.path.replace(f.sid, "missing-chat"), route.method, body);
      assert.equal(deleted.status, 404, `${route.method} ${route.path}: deletion wins before malformed-body parsing`);
      assert.equal(absent.status, 404); assert.equal(await deleted.text(), await absent.text(), "a deleted chat is indistinguishable from a missing one");
    }
  } finally { await f.close(); }
});
