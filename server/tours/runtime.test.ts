import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tourEditionAssetsFixture, tourManifestFixture, tourScriptFixture } from "../../shared/tour-fixtures";
import type { TourJob } from "../../shared/tour";
import { stateView } from "../harness/state-view";
import { scratchRoot } from "../test-scratch";
import { tourScriptDigest } from "./checks";
import { TourCaptureFailure } from "./targets";
import { TourTargetRefused, TourTargetUnverifiable } from "../project-services/tour-target";
import { TourRuntime, type TourRuntimeOptions } from "./runtime";
import type { TourToolCaller } from "./tools";
import type { TourContextDeps } from "./context";
import type { Registry } from "../project-services/store";

async function settled(runtime: TourRuntime, id: string): Promise<TourJob> {
  for (let i = 0; i < 200; i++) {
    const job = runtime.queue.get("chat-a", id)!;
    if (["checking", "ready", "failed", "needs-site-approval", "needs-test-account", "cancelled"].includes(job.phase)) return job;
    await new Promise<void>(resolve => queueMicrotask(resolve));
  }
  throw new Error("The in-process queue did not settle.");
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function setup(change?: (input: Parameters<NonNullable<TourRuntimeOptions["run"]>>[0]) => void | Promise<void>, hooks: { snapshot?: () => Promise<void>; assertCurrent?: () => Promise<void>; completeAfterAbort?: boolean; context?: Pick<TourContextDeps, "registry" | "projects">; cwd?: string } = {}) {
  const root = scratchRoot("tour-runtime-");
  let enforced = false;
  const state = () => stateView([{ kind: "state", id: "sandbox", parentId: null, key: "sandbox", data: { version: 1, on: enforced, level: "workspace-write", enforcement: enforced ? "full" : "none", backend: "test" } }]);
  const caller: TourToolCaller = { sessionId: "chat-a", sessionFile: `${root}/chat.jsonl`, cwd: "/forged", state: state() };
  const launches: Parameters<NonNullable<TourRuntimeOptions["run"]>>[0][] = [];
  let incomplete = false, broken = false, authRequired = false, extraOrigin: string | undefined;
  const runtime = new TourRuntime({ root,
    context: { canonical: p => p, snapshot: async () => { await hooks.snapshot?.(); return { sessionId: caller.sessionId, sessionFile: caller.sessionFile, cwd: hooks.cwd ?? root, agentDir: `${root}/agent`, state: state(), held: { on: enforced, enforcement: enforced ? "full" : "none" } }; }, ...hooks.context },
    target: async () => ({ origin: "https://example.test", assertCurrent: async () => { await hooks.assertCurrent?.(); } }),
    run: async input => {
      launches.push(input); await change?.(input);
      if (authRequired && !input.account) throw new TourCaptureFailure({ message: "This page requires a test account.", guidance: "Store a test account.", blockedOrigin: "https://example.test" });
      if (broken) throw new TourCaptureFailure({ message: "Target matched 0 controls.", guidance: "Choose an exact accessible name.", stepId: "find-draft", viewId: "overview", size: "phone", target: { kind: "text", text: "Saved" }, matches: 0, nearest: ["Saved drafts"] });
      if (!hooks.completeAfterAbort || !input.signal?.aborted) {
        await input.beforeContact("https://example.test");
        if (extraOrigin) await input.beforeContact(extraOrigin);
      }
      const manifest = tourManifestFixture(), assets = input.dryRun ? new Map<string, Uint8Array>() : tourEditionAssetsFixture();
      if (incomplete) assets.delete("phone.png");
      return { steps: input.dryRun ? [] : manifest.steps, assets, contactSheets: input.dryRun ? [] : manifest.check.contactSheets, suspicious: input.dryRun ? [] : ["phone.png"], provenance: { origin: "https://example.test", recordedAt: manifest.recordedAt, publicOrigins: ["https://example.test"] }, scriptDigest: tourScriptDigest(input.script) };
    },
  });
  return { runtime, caller, root, launches, setIncomplete: () => { incomplete = true; }, setBroken: () => { broken = true; }, requireAccount: () => { authRequired = true; }, contactExtra: (origin: string) => { extraOrigin = origin; }, tighten: () => { enforced = true; }, close: () => { runtime.close(); rmSync(root, { recursive: true, force: true }); } };
}
async function captured(f: ReturnType<typeof setup>) {
  const dry = await f.runtime.dryRun(f.caller, tourScriptFixture(), "tour-demo");
  assert.equal((await settled(f.runtime, dry.job.id)).phase, "checking");
  const capture = await f.runtime.record(f.caller, dry.job.id);
  await settled(f.runtime, capture.job.id);
  return capture.job.id;
}
const verification = { overviewReviewed: true as const, suspiciousCapturesReviewed: ["phone.png"], notes: "Reviewed every overview cell and inspected the suspicious phone picture." };

test("publish requires actual overview and suspicious-picture receipts; private artifacts stay out of cards", async () => {
  const f = setup();
  try {
    f.runtime.approvals.approve("https://example.test");
    const id = await captured(f);
    assert.equal(f.runtime.store.latestEdition("chat-a", "tour-demo"), null);
    await assert.rejects(f.runtime.check(f.caller, id, verification), /Inspect every overview/);
    await f.runtime.inspect(f.caller, id);
    await assert.rejects(f.runtime.check(f.caller, id, verification), /suspicious capture/);
    await f.runtime.inspect(f.caller, id, "phone.png");
    const ready = await f.runtime.check(f.caller, id, verification);
    assert.equal(ready.job.phase, "ready"); assert.ok(ready.manifest);
    assert.equal(f.runtime.store.latestEdition("chat-a", "tour-demo")?.manifest.editionId, ready.job.editionId);
    assert.deepEqual(f.runtime.artifacts.read("chat-a", id)?.publicOrigins, ["https://example.test"]);
    assert.deepEqual(f.runtime.store.latestEdition("chat-a", "tour-demo")?.provenance.publicOrigins, ["https://example.test"]);
    assert.ok(!JSON.stringify(ready.manifest).includes("publicOrigins"));
    assert.ok(f.launches.every(input => input.context.cwd === f.root && input.context.sessionId === "chat-a"));
    const jobJson = JSON.stringify(ready.job);
    for (const secret of ["contact-sheet.png", "script", "receipts", "overviewReviewed", "source"]) assert.ok(!jobJson.includes(secret), secret);
    await assert.rejects(f.runtime.status({ ...f.caller, sessionId: "chat-b" }, id), /unavailable in this chat/);
  } finally { f.close(); }
});
test("an incomplete edition is never published even after a successful dry run", async () => {
  const f = setup();
  try {
    f.runtime.approvals.approve("https://example.test"); f.setIncomplete();
    const id = await captured(f);
    assert.equal(f.runtime.queue.get("chat-a", id)?.phase, "failed");
    assert.equal(f.runtime.store.latestEdition("chat-a", "tour-demo"), null);
    await assert.rejects(f.runtime.check(f.caller, id, verification), /no complete captured edition/);
    assert.equal(f.runtime.store.latestEdition("chat-a", "tour-demo"), null);
  } finally { f.close(); }
});
test("failed re-record returns step/reason/nearest targets and preserves the previous complete edition", async () => {
  const f = setup();
  try {
    f.runtime.approvals.approve("https://example.test");
    const first = await captured(f); await f.runtime.inspect(f.caller, first); await f.runtime.inspect(f.caller, first, "phone.png");
    const ready = await f.runtime.check(f.caller, first, verification);
    f.setBroken();
    const again = await f.runtime.reRecord(f.caller, "tour-demo");
    const failed = await settled(f.runtime, again.id);
    assert.equal(failed.phase, "failed"); assert.equal(failed.failure?.stepId, "find-draft"); assert.deepEqual(failed.failure?.nearest, ["Saved drafts"]);
    assert.equal(f.runtime.store.latestEdition("chat-a", "tour-demo")?.manifest.editionId, ready.job.editionId);
    assert.equal((await f.runtime.show(f.caller, "tour-demo")).editionId, ready.job.editionId);
    assert.deepEqual(f.runtime.artifacts.read("chat-a", again.id)?.report?.failure, failed.failure);
  } finally { f.close(); }
});
test("unapproved sites release the queue without starting any browser and resume only after exact consent", async () => {
  const f = setup();
  try {
    const dry = await f.runtime.dryRun(f.caller, tourScriptFixture());
    assert.equal((await settled(f.runtime, dry.job.id)).phase, "needs-site-approval"); assert.equal(f.launches.length, 0);
    await assert.rejects(f.runtime.approve(f.caller, dry.job.id, "https://other.test"), /exact site requested/);
    await f.runtime.approve(f.caller, dry.job.id, "https://example.test");
    assert.equal((await settled(f.runtime, dry.job.id)).phase, "checking"); assert.equal(f.launches.length, 1);
  } finally { f.close(); }
});
test("sandbox tightening between child launch and contact refuses before request permission", async () => {
  let f: ReturnType<typeof setup>;
  f = setup(() => f.tighten());
  try {
    f.runtime.approvals.approve("https://example.test");
    const dry = await f.runtime.dryRun(f.caller, tourScriptFixture());
    const failed = await settled(f.runtime, dry.job.id);
    assert.equal(failed.phase, "failed"); assert.match(failed.failure!.message, /sandbox scope changed/);
    assert.equal(f.runtime.store.latestEdition("chat-a", dry.job.tourId), null);
  } finally { f.close(); }
});

test("a copy whose process state can't be read fails the job with its own copy, never a pass or an approval wait", async () => {
  let unreadable = false;
  const f = setup(undefined, { assertCurrent: async () => { if (unreadable) throw new TourTargetUnverifiable("EACCES /proc/net/tcp"); } });
  try {
    f.runtime.approvals.approve("https://example.test");
    const control = await f.runtime.dryRun(f.caller, tourScriptFixture());
    assert.equal((await settled(f.runtime, control.job.id)).phase, "checking", "control: a readable copy checks");
    unreadable = true;
    const dry = await f.runtime.dryRun(f.caller, tourScriptFixture());
    const failed = await settled(f.runtime, dry.job.id);
    assert.equal(failed.phase, "failed");
    assert.equal(failed.failure?.message, "Sova couldn't verify this running copy: this host's process information can't be read.");
    assert.equal(failed.failure?.guidance, "Retry in a moment. Recording never continues against a copy it can't verify.");
    assert.equal(f.runtime.store.latestEdition("chat-a", dry.job.tourId), null);
  } finally { f.close(); }
});

test("a copy refused during recording fails the job with the refusal's own reason, not the generic line", async () => {
  let swapped = false;
  const f = setup(undefined, { assertCurrent: async () => { if (swapped) throw new TourTargetRefused("This running copy changed during recording. Retry against the same copy after it is stable."); } });
  try {
    f.runtime.approvals.approve("https://example.test");
    const control = await f.runtime.dryRun(f.caller, tourScriptFixture());
    assert.equal((await settled(f.runtime, control.job.id)).phase, "checking", "control: an unchanged copy checks");
    swapped = true;
    const dry = await f.runtime.dryRun(f.caller, tourScriptFixture());
    const failed = await settled(f.runtime, dry.job.id);
    assert.equal(failed.phase, "failed");
    assert.equal(failed.failure?.message, "This running copy changed during recording. Retry against the same copy after it is stable.");
    assert.equal(failed.failure?.guidance, "Start this same running copy through project services, then retry. Recording never starts a substitute.");
    assert.notEqual(failed.failure?.message, "Recording could not finish.");
    assert.equal(f.runtime.store.latestEdition("chat-a", dry.job.tourId), null);
  } finally { f.close(); }
});

test("a short project source is stored as the full source Sova derived; a path for projectId is refused by name", async () => {
  let root = "";
  const registry = (): Registry => ({ version: 1, shared: [], instances: [{ id: "copy-a", project: "/projects/a", checkout: root, branch: "a", slot: 1, generation: 1, createdBy: "operator", createdAt: "2026-01-02T03:04:05.000Z", cutWorktree: false, desired: { web: "running" }, prints: {}, data: {}, ports: { web: { http: 10001 } } }] });
  const f = setup(undefined, { context: { registry, projects: async () => [{ id: "prj_aaaaaaaa", root: "/projects/a" }] } });
  root = f.root;
  try {
    f.runtime.approvals.approve("https://example.test");
    const script = tourScriptFixture();
    const request = { ...script, source: { kind: "project" as const, instanceId: "copy-a", serviceId: "web", endpoint: "http" } };
    const dry = await f.runtime.dryRun(f.caller, request);
    assert.equal((await settled(f.runtime, dry.job.id)).phase, "checking");
    const full = { kind: "project", projectId: "prj_aaaaaaaa", instanceId: "copy-a", checkout: f.root, serviceId: "web", endpoint: "http" };
    assert.deepEqual(f.runtime.artifacts.read("chat-a", dry.job.id)?.script.source, full, "the attempt pins the derived full source");
    assert.deepEqual(f.launches.at(-1)?.script.source, full, "the recorder gets the full source");
    await assert.rejects(f.runtime.dryRun(f.caller, { ...request, source: { ...request.source, projectId: "/projects/a" } } as never), (e: Error) => e.message.startsWith("source.projectId must be an id like prj_"));
  } finally { f.close(); }
});

test("revoking an encountered undeclared subresource origin after capture prevents publication", async () => {
  const f = setup();
  try {
    f.runtime.approvals.approve("https://example.test"); f.runtime.approvals.approve("https://pictures.test"); f.contactExtra("https://pictures.test");
    const id = await captured(f); await f.runtime.inspect(f.caller, id); await f.runtime.inspect(f.caller, id, "phone.png");
    assert.ok(f.runtime.artifacts.read("chat-a", id)?.contactedOrigins?.includes("https://pictures.test"));
    f.runtime.approvals.revoke("https://pictures.test");
    await assert.rejects(f.runtime.check(f.caller, id, verification), /consent changed/);
    assert.equal(f.runtime.store.latestEdition("chat-a", "tour-demo"), null);
  } finally { f.close(); }
});
test("test-account requirement releases the slot, vault submission resumes with only an opaque script reference", async () => {
  const f = setup();
  try {
    f.runtime.approvals.approve("https://example.test"); f.requireAccount();
    const dry = await f.runtime.dryRun(f.caller, tourScriptFixture());
    const waiting = await settled(f.runtime, dry.job.id);
    assert.equal(waiting.phase, "needs-test-account"); assert.equal(waiting.requirements?.testAccount?.origin, "https://example.test");
    await f.runtime.saveAccount(f.caller, dry.job.id, { origin: "https://example.test", username: "test-reviewer", password: "fake-pw-19", testAccount: true });
    assert.equal((await settled(f.runtime, dry.job.id)).phase, "checking");
    const stored = f.runtime.artifacts.read("chat-a", dry.job.id)!;
    assert.ok(stored.script.accountId); assert.ok(!JSON.stringify(stored).includes("fake-pw-19"));
    assert.ok(!JSON.stringify(f.runtime.queue.get("chat-a", dry.job.id)).includes("fake-pw-19"));
    assert.equal(f.launches.at(-1)?.account?.password, "fake-pw-19");
  } finally { f.close(); }
});

test("deleting a chat waits for runner cleanup and prevents late captures, while retaining other chats and global accounts", async () => {
  const entered = deferred(), cleanup = deferred();
  let childSignal: AbortSignal | undefined;
  const f = setup(async input => {
    if (!input.dryRun) { childSignal = input.signal; entered.resolve(); await cleanup.promise; }
  }, { completeAfterAbort: true });
  try {
    f.runtime.approvals.approve("https://example.test");
    const account = f.runtime.accounts.save({ origin: "https://example.test", username: "test-user", password: "fake-pw-20", testAccount: true });
    const other = f.runtime.queue.enqueue({ sessionId: "chat-b", tourId: "other-tour", title: "Other chat", total: 1 }, async () => ({ phase: "checking" }));
    f.runtime.artifacts.save({ v: 1, sessionId: "chat-b", jobId: other.id, tourId: "other-tour", script: tourScriptFixture(), mode: "dry-run", suspicious: [], receipts: [] });
    const dry = await f.runtime.dryRun(f.caller, tourScriptFixture());
    await settled(f.runtime, dry.job.id);
    const recording = await f.runtime.record(f.caller, dry.job.id);
    await entered.promise;
    let removed = false;
    const deletion = f.runtime.removeSession("chat-a").then(() => { removed = true; });
    assert.equal(childSignal?.aborted, true);
    await assert.rejects(f.runtime.dryRun(f.caller, tourScriptFixture()), /deleted/);
    assert.equal(removed, false, "abort is not child cleanup");
    assert.ok(f.runtime.artifacts.read("chat-a", recording.job.id), "private staging remains until actual child settlement");
    cleanup.resolve(); await deletion;
    assert.equal(f.runtime.queue.list("chat-a").length, 0);
    assert.equal(existsSync(join(f.root, "tour-private", "chat-a")), false);
    assert.equal(f.runtime.store.latestEdition("chat-a", recording.job.tourId), null);
    assert.ok(f.runtime.queue.get("chat-b", other.id));
    assert.ok(f.runtime.artifacts.read("chat-b", other.id));
    assert.ok(f.runtime.approvals.isApproved("https://example.test"));
    assert.ok(f.runtime.accounts.resolve(account.id, "https://example.test"));
    const reopened = new TourRuntime({ root: f.root });
    try { await assert.rejects(reopened.dryRun(f.caller, tourScriptFixture()), /deleted/); }
    finally { reopened.close(); }
  } finally { cleanup.resolve(); f.close(); }
});

test("deletion while trusted context resolves prevents a pre-deletion request from queuing later", async () => {
  const entered = deferred(), release = deferred();
  const f = setup(undefined, { snapshot: async () => { entered.resolve(); await release.promise; } });
  let enqueues = 0;
  const enqueue = f.runtime.queue.enqueue.bind(f.runtime.queue);
  f.runtime.queue.enqueue = (...args) => { enqueues++; return enqueue(...args); };
  try {
    const submission = f.runtime.dryRun(f.caller, tourScriptFixture());
    await entered.promise; await f.runtime.removeSession("chat-a");
    release.resolve();
    await assert.rejects(submission, /deleted/);
    assert.equal(f.runtime.queue.list("chat-a").length, 0);
    assert.equal(existsSync(join(f.root, "tour-private", "chat-a")), false);
    assert.equal(f.launches.length, 0);
    assert.equal(enqueues, 0, "the runtime must not rely on the downstream queue refusing late work");
  } finally { release.resolve(); f.close(); }
});

test("deletion while final source verification awaits prevents checked-edition publication", async () => {
  const entered = deferred(), release = deferred();
  let checking = false;
  const f = setup(undefined, { assertCurrent: async () => { if (checking) { entered.resolve(); await release.promise; } } });
  try {
    f.runtime.approvals.approve("https://example.test");
    const id = await captured(f);
    await f.runtime.inspect(f.caller, id); await f.runtime.inspect(f.caller, id, "phone.png");
    checking = true;
    let publications = 0;
    const publish = f.runtime.store.publishEdition.bind(f.runtime.store);
    f.runtime.store.publishEdition = (...args) => { publications++; return publish(...args); };
    const publication = f.runtime.check(f.caller, id, verification);
    await entered.promise; await f.runtime.removeSession("chat-a"); release.resolve();
    await assert.rejects(publication, /deleted/);
    assert.equal(publications, 0, "the runtime must not call publication even if the store also refuses deleted chats");
    assert.equal(f.runtime.store.latestEdition("chat-a", "tour-demo"), null);
    assert.equal(existsSync(join(f.root, "tour-private", "chat-a")), false);
  } finally { release.resolve(); f.close(); }
});

test("inspect copies the pictures it returns into the chat's own folder, outside the private store, and names their paths", async () => {
  const work = scratchRoot("tour-work-");
  const f = setup(undefined, { cwd: work });
  try {
    f.runtime.approvals.approve("https://example.test");
    const id = await captured(f);
    const sheet = await f.runtime.inspect(f.caller, id);
    const text = JSON.parse((sheet.content[0] as { text: string }).text) as { copies?: string[] };
    const path = join(work, ".sova-tour", id, "contact-sheet.png");
    assert.deepEqual(text.copies, [path], "the copy's path, in the chat's working folder (its context cwd)");
    assert.ok(!path.startsWith(join(f.root, "tour-private")), "outside the tours private store");
    assert.deepEqual(readFileSync(path), f.runtime.artifacts.readImage("chat-a", id, "contact-sheet.png"), "the sheet's own bytes");
    assert.equal(readFileSync(join(work, ".sova-tour", ".gitignore"), "utf8"), "*\n", "git ignores the folder");
    const one = await f.runtime.inspect(f.caller, id, "phone.png");
    assert.deepEqual((JSON.parse((one.content[0] as { text: string }).text) as { copies?: string[] }).copies, [join(work, ".sova-tour", id, "phone.png")]);
  } finally { f.close(); rmSync(work, { recursive: true, force: true }); }
});

test("inspect never writes a copy through a link in the chat's folder", async () => {
  const work = scratchRoot("tour-work-");
  const f = setup(undefined, { cwd: work });
  const elsewhere = scratchRoot("tour-elsewhere-");
  try {
    f.runtime.approvals.approve("https://example.test");
    const id = await captured(f);
    symlinkSync(elsewhere, join(work, ".sova-tour"));
    const sheet = await f.runtime.inspect(f.caller, id);
    assert.equal((JSON.parse((sheet.content[0] as { text: string }).text) as { copies?: string[] }).copies, undefined);
    assert.deepEqual(readdirSync(elsewhere), [], "nothing written through the link");
    assert.equal(sheet.content.filter(c => c.type === "image").length, 1, "the picture itself is still returned");
    // Inside Sova's state: never copied there either.
    const inState = setup(undefined);
    try {
      inState.runtime.approvals.approve("https://example.test");
      const sid = await captured(inState);
      assert.equal((JSON.parse(((await inState.runtime.inspect(inState.caller, sid)).content[0] as { text: string }).text) as { copies?: string[] }).copies, undefined, "a chat folder inside the state root gets no copy");
    } finally { inState.close(); }
  } finally { f.close(); rmSync(elsewhere, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); }
});
