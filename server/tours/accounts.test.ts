import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TourAccountStore } from "./accounts";
import { TourJobStore } from "./job";
import { tourScriptFixture } from "../../shared/tour-fixtures";
import type { TourJob } from "../../shared/tour";
import { stateView } from "../harness/state-view";
import { tourScriptDigest } from "./checks";
import { TourRuntime, type TourRuntimeOptions } from "./runtime";
import { TourCaptureFailure } from "./targets";
import type { TourToolCaller } from "./tools";

const account = { origin: "https://example.test", username: "test-user", password: "fake-pw-05", testAccount: true as const };

test("test-account password is stored once privately and never serialized from metadata, secret handles or jobs", () => {
  const root = mkdtempSync(join(tmpdir(), "tour-account-"));
  try {
    const store = new TourAccountStore(join(root, "vault")); const saved = store.save(account);
    const secret = new TourAccountStore(join(root, "vault")).resolve(saved.id, account.origin)!;
    assert.deepEqual(secret.credentials(), { origin: account.origin, username: account.username, password: account.password }, "explicit trusted IPC projection provides working sign-in, not a dummy credential");
    const serialized = [JSON.stringify(saved), JSON.stringify(store.list()), JSON.stringify(secret), JSON.stringify({ secret }), JSON.stringify({ ...secret }), inspect(secret)];
    for (const text of serialized) { assert.ok(!text.includes(account.password)); assert.ok(!text.includes(account.username)); }
    const jobs = new TourJobStore(join(root, "jobs"));
    assert.throws(() => jobs.save({ v: 1, id: "job", tourId: "tour", sessionId: "session", title: "Tour", phase: "queued", completed: 0, total: 2, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", account: secret } as any), /Invalid tour job/);
    const durable = readFileSync(join(root, "vault", "test-accounts.json"), "utf8");
    assert.equal(durable.split(account.password).length - 1, 1, "only dedicated host-local vault holds the durable password");
    if (process.platform !== "win32") {
      assert.equal(statSync(join(root, "vault")).mode & 0o777, 0o700);
      assert.equal(statSync(join(root, "vault", "test-accounts.json")).mode & 0o777, 0o600);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sign-in is test-only and credentials cannot cross exact-origin boundaries or survive deletion", () => {
  const root = mkdtempSync(join(tmpdir(), "tour-account-"));
  try {
    const store = new TourAccountStore(root);
    assert.throws(() => store.save({ ...account, testAccount: false } as any), /Use a test account/);
    assert.throws(() => store.save({ ...account, origin: "https://name:password@example.test" }), /exact HTTP/);
    assert.throws(() => store.save({ ...account, username: "bad:name" }), /Basic credentials/);
    const saved = store.save(account);
    for (const origin of ["http://example.test", "https://example.test:444", "https://other.test"]) assert.equal(store.resolve(saved.id, origin), null);
    assert.equal(store.resolve("../test-accounts", account.origin), null);
    store.remove(saved.id); assert.equal(store.resolve(saved.id, account.origin), null); assert.deepEqual(store.list(), []);
    assert.ok(!readFileSync(join(root, "test-accounts.json"), "utf8").includes(account.password));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("malformed secret storage errors never quote the raw password", () => {
  const root = mkdtempSync(join(tmpdir(), "tour-account-"));
  try {
    const store = new TourAccountStore(root); writeFileSync(join(root, "test-accounts.json"), `{"password":"${account.password}`);
    assert.throws(() => store.list(), error => error instanceof Error && !error.message.includes(account.password) && /could not be read/.test(error.message));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("one test account per exact origin: storing again replaces it in place and every tour can find it", () => {
  const root = mkdtempSync(join(tmpdir(), "tour-account-"));
  try {
    const store = new TourAccountStore(root);
    assert.equal(store.forOrigin(account.origin), null);
    const first = store.save(account);
    assert.deepEqual(store.forOrigin(account.origin)?.credentials(), { origin: account.origin, username: account.username, password: account.password });
    for (const origin of ["http://example.test", "https://example.test:444", "https://other.test", "not an origin"]) assert.equal(store.forOrigin(origin), null, origin);
    const other = store.save({ ...account, origin: "https://other.test", password: "fake-pw-06" });
    const second = store.save({ ...account, password: "fake-pw-04" });
    assert.equal(second.id, first.id, "the opaque reference a tour already holds stays valid");
    assert.deepEqual(store.list().map(a => a.origin).sort(), [account.origin, "https://other.test"]);
    assert.equal(store.resolve(first.id, account.origin)?.credentials().password, "fake-pw-04");
    assert.equal(store.resolve(other.id, "https://other.test")?.credentials().password, "fake-pw-06");
    const durable = readFileSync(join(root, "test-accounts.json"), "utf8");
    assert.ok(!durable.includes(account.password), "the replaced password is gone, not kept as a second copy");
    // Older state with two accounts for one origin is ambiguous: none is picked, and storing again collapses them.
    const twin = { id: "legacy-twin", origin: account.origin, kind: "http-basic", createdAt: "2026-01-01T00:00:00.000Z", username: "test-user", password: "fixture-legacy" };
    writeFileSync(join(root, "test-accounts.json"), JSON.stringify({ v: 1, accounts: [...JSON.parse(durable).accounts, twin] }));
    assert.equal(store.forOrigin(account.origin), null);
    store.save(account);
    assert.equal(store.list().filter(a => a.origin === account.origin).length, 1);
    assert.ok(store.forOrigin(account.origin));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a fresh tour of the same Basic-auth origin uses the stored account: no second prompt, no second copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "tour-account-"));
  const origin = "https://example.test";
  const state = stateView([{ kind: "state", id: "sandbox", parentId: null, key: "sandbox", data: { version: 1, on: false, level: "workspace-write", enforcement: "none", backend: "test" } }] as Parameters<typeof stateView>[0]);
  const caller: TourToolCaller = { sessionId: "chat-a", sessionFile: join(root, "chat.jsonl"), cwd: "/forged", state };
  const sent: (string | undefined)[] = [];
  const runtime = new TourRuntime({ root,
    context: { canonical: p => p, snapshot: async () => ({ sessionId: caller.sessionId, sessionFile: caller.sessionFile, cwd: root, agentDir: join(root, "agent"), state, held: { on: false, enforcement: "none" } }) },
    target: async () => ({ origin, assertCurrent: async () => {} }),
    // Stands in for a Basic-auth site: without credentials it answers 401, as the real recorder reports.
    run: async (input: Parameters<NonNullable<TourRuntimeOptions["run"]>>[0]) => {
      sent.push(input.account?.password);
      if (!input.account) throw new TourCaptureFailure({ message: "This page requires a test account.", guidance: "Store a test account.", blockedOrigin: origin });
      await input.beforeContact(origin);
      return { steps: [], assets: new Map<string, Uint8Array>(), contactSheets: [], suspicious: [], provenance: { origin, recordedAt: new Date().toISOString(), publicOrigins: [] }, scriptDigest: tourScriptDigest(input.script) };
    },
  });
  const settled = async (id: string): Promise<TourJob> => {
    for (let i = 0; i < 500; i++) {
      const job = runtime.queue.get(caller.sessionId, id)!;
      if (["checking", "ready", "failed", "needs-site-approval", "needs-test-account", "cancelled"].includes(job.phase)) return job;
      await new Promise(ok => setTimeout(ok, 2));
    }
    throw new Error("The in-process queue did not settle.");
  };
  try {
    runtime.approvals.approve(origin);
    // Tour 1: the site asks for sign-in once; the operator stores the test account.
    const first = await runtime.dryRun(caller, tourScriptFixture(), "tour-one");
    assert.equal((await settled(first.job.id)).phase, "needs-test-account");
    await runtime.saveAccount(caller, first.job.id, { origin, username: "test-user", password: "fake-pw-05", testAccount: true });
    assert.equal((await settled(first.job.id)).phase, "checking");
    // Tour 2: a brand-new script for the same origin, with no account reference at all.
    const second = await runtime.dryRun(caller, tourScriptFixture(), "tour-two");
    assert.equal((await settled(second.job.id)).phase, "checking", "no second sign-in prompt");
    assert.equal(sent.at(-1), "fake-pw-05");
    assert.equal(runtime.accounts.list().length, 1, "the password is stored once");
    // An explicit reference that doesn't resolve for this origin is refused, never silently replaced.
    const forged = tourScriptFixture(); forged.accountId = "missing-account";
    const third = await runtime.dryRun(caller, forged, "tour-three");
    const blocked = await settled(third.job.id);
    assert.equal(blocked.phase, "needs-test-account");
    // So is a real account of another origin: credentials never cross exact-origin boundaries.
    const elsewhere = runtime.accounts.save({ origin: "https://other.test", username: "test-user", password: "fake-pw-06", testAccount: true });
    const crossed = tourScriptFixture(); crossed.accountId = elsewhere.id;
    const fourth = await runtime.dryRun(caller, crossed, "tour-four");
    assert.equal((await settled(fourth.job.id)).phase, "needs-test-account");
    assert.equal(sent.length, 3, "neither refused reference reached the recorder");
    assert.ok(!sent.includes("fake-pw-06"));
    assert.ok(!JSON.stringify(runtime.queue.list(caller.sessionId)).includes("fake-pw-05"));
    assert.equal(runtime.accounts.list().filter(a => a.origin === origin).length, 1);
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
});
