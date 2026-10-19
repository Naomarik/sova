import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import type { TourJob } from "../../shared/tour";
import { stateView } from "../harness/state-view";
import { mountTourJobRoutes, type TourJobRouteOptions } from "./runtime-routes";

function fixture() {
  const calls: { op: string; sessionId: string; input?: unknown }[] = [];
  const job: TourJob = { v: 1, id: "job-a", sessionId: "chat-a", tourId: "tour-a", title: "A tour", phase: "checking", completed: 2, total: 2, createdAt: "2026-01-02T03:04:05.000Z", updatedAt: "2026-01-02T03:04:05.000Z" };
  const runtime: ReturnType<NonNullable<TourJobRouteOptions["runtime"]>> = {
    status: async (caller) => { calls.push({ op: "status", sessionId: caller.sessionId }); return { job, steps: 1 }; },
    cancel: async caller => { calls.push({ op: "cancel", sessionId: caller.sessionId }); return { job: { ...job, phase: "cancelled" }, steps: 1 }; },
    approve: async (caller, _id, input) => { calls.push({ op: "approve", sessionId: caller.sessionId, input }); return job; },
    saveAccount: async (caller, _id, input) => { calls.push({ op: "account", sessionId: caller.sessionId, input }); return job; },
    signIn: async (caller, _id, input) => { calls.push({ op: "sign-in", sessionId: caller.sessionId, input }); if ("password" in input && input.password.includes("THROW")) throw new Error(`refused ${input.password}`); return { ...job, phase: "recording" }; },
    approveAll: async (caller, _id, origins) => { calls.push({ op: "approve-all", sessionId: caller.sessionId, input: origins }); if (origins.includes("https://moved.test")) throw new Error("This job isn't waiting for site approval."); return job; },
    reRecord: async caller => { calls.push({ op: "re-record", sessionId: caller.sessionId }); return job; },
    latest: sessionId => { calls.push({ op: "latest", sessionId }); return { editionId: "previous-checked", job, sites: [] }; },
    revokeSite: (caller, _tour, origin) => { calls.push({ op: "revoke-site", sessionId: caller.sessionId, input: origin }); return [{ origin, approved: false, account: false }]; },
    removeAccount: (caller, _tour, origin) => { calls.push({ op: "remove-account", sessionId: caller.sessionId, input: origin }); return [{ origin, approved: false, account: false }]; },
  };
  const app = new Hono();
  mountTourJobRoutes(app, { runtime: () => runtime, owned: async sid => sid === "chat-a", current: sid => sid === "chat-a", caller: async sessionId => ({ sessionId, sessionFile: "/server/known.jsonl", cwd: "/server/checkout", state: stateView([]) }) });
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { app, calls, post };
}
test("job routes enforce current owner scope and pass only server-resolved caller context", async () => {
  const f = fixture();
  assert.equal((await f.app.request("/api/tours/chat-a/jobs/job-a")).status, 200);
  assert.equal((await f.app.request("/api/tours/chat-b/jobs/job-a")).status, 404);
  assert.equal((await f.post("/api/tours/chat-b/jobs/job-a/cancel", {})).status, 404);
  assert.equal((await f.post("/api/tours/chat-a/jobs/job-a/cancel", { sessionId: "chat-b", cwd: "/private", sandbox: { on: false } })).status, 200);
  assert.deepEqual(f.calls, [{ op: "status", sessionId: "chat-a" }, { op: "cancel", sessionId: "chat-a" }]);
});
test("approval/account/re-record reject forged caller and scope fields; credentials never return in response", async () => {
  const f = fixture();
  const base = "/api/tours/chat-a/jobs/job-a";
  assert.equal((await f.post(`${base}/approve`, { origin: "https://example.test", sessionId: "chat-b" })).status, 400);
  assert.equal((await f.post(`${base}/approve`, { origin: "https://example.test" })).status, 200);
  assert.equal((await f.post(`${base}/account`, { origin: "https://example.test", username: "test", password: "fake-pw-13", testAccount: false })).status, 400);
  const account = await f.post(`${base}/account`, { origin: "https://example.test", username: "test", password: "fake-pw-13", testAccount: true });
  assert.equal(account.status, 200); assert.ok(!(await account.text()).includes("fake-pw-13"));
  assert.equal((await f.post("/api/tours/chat-a/tour-a/re-record", { cwd: "/private", sessionId: "chat-b" })).status, 400);
  assert.equal((await f.post("/api/tours/chat-a/tour-a/re-record", {})).status, 200);
  assert.deepEqual(f.calls.map(c => c.op), ["approve", "account", "re-record"]);
  assert.ok(f.calls.every(c => c.sessionId === "chat-a"));
});
test("latest route keeps prior checked edition alongside an in-progress replacement and caps secrets body", async () => {
  const f = fixture();
  const latest = await f.app.request("/api/tours/chat-a/tour-a");
  const body = await latest.json() as { editionId: string; job: TourJob };
  assert.equal(body.editionId, "previous-checked"); assert.equal(body.job.phase, "checking");
  assert.equal(latest.headers.get("cache-control"), "no-store");
  assert.equal((await f.post("/api/tours/chat-a/jobs/job-a/account", { password: "x".repeat(20_000) })).status, 413);
});

/** Every job route, with a malformed and a well-formed body, as the operator UI sends them. */
const ROUTES: { name: string; method: "GET" | "POST" | "DELETE"; path: string; valid?: string }[] = [
  { name: "status", method: "GET", path: "/api/tours/chat-a/jobs/job-a" },
  { name: "latest", method: "GET", path: "/api/tours/chat-a/tour-a" },
  { name: "cancel", method: "POST", path: "/api/tours/chat-a/jobs/job-a/cancel", valid: "{}" },
  { name: "approve", method: "POST", path: "/api/tours/chat-a/jobs/job-a/approve", valid: JSON.stringify({ origin: "https://example.test" }) },
  { name: "account", method: "POST", path: "/api/tours/chat-a/jobs/job-a/account", valid: JSON.stringify({ origin: "https://example.test", username: "test", password: "fake-pw-14", testAccount: true }) },
  { name: "sign-in", method: "POST", path: "/api/tours/chat-a/jobs/job-a/sign-in", valid: JSON.stringify({ origin: "https://example.test", username: "ada", password: "fake-pw-14" }) },
  { name: "sign-in-code", method: "POST", path: "/api/tours/chat-a/jobs/job-a/sign-in", valid: JSON.stringify({ origin: "https://example.test", code: "123456" }) },
  { name: "approve-all", method: "POST", path: "/api/tours/chat-a/jobs/job-a/approve-all", valid: JSON.stringify({ origins: ["https://example.test", "https://api.example.test"] }) },
  { name: "re-record", method: "POST", path: "/api/tours/chat-a/tour-a/re-record", valid: "{}" },
  { name: "revoke-site", method: "DELETE", path: "/api/tours/chat-a/tour-a/approvals", valid: JSON.stringify({ origin: "https://example.test" }) },
  { name: "remove-account", method: "DELETE", path: "/api/tours/chat-a/tour-a/accounts", valid: JSON.stringify({ origin: "https://example.test" }) },
];
/** `when`: the moment the chat is deleted (during the owner check, during the caller lookup, or inside the runtime action). */
function racing(when: "owned" | "caller" | "action" | "never") {
  let deleted = false, ownedCalls = 0;
  const calls: string[] = [];
  const act = <T>(op: string, value: T): T => {
    calls.push(op);
    if (when === "action") { deleted = true; throw new Error("chat was deleted"); }
    if (when === "never" && op !== "latest") throw new Error("runtime refusal while the chat still exists");
    return value;
  };
  const job = { v: 1, id: "job-a", sessionId: "chat-a", tourId: "tour-a", title: "A tour", phase: "checking", completed: 0, total: 1, createdAt: "2026-01-02T03:04:05.000Z", updatedAt: "2026-01-02T03:04:05.000Z" } as TourJob;
  const app = new Hono();
  mountTourJobRoutes(app, {
    runtime: () => ({
      status: async () => act("status", { job, steps: 1 }),
      cancel: async () => act("cancel", { job, steps: 1 }),
      approve: async () => act("approve", job),
      saveAccount: async () => act("account", job),
      signIn: async () => act("sign-in", job),
      approveAll: async () => act("approve-all", job),
      reRecord: async () => act("re-record", job),
      latest: () => act("latest", { editionId: "previous", job, sites: [] }),
      revokeSite: () => act("revoke-site", []),
      removeAccount: () => act("remove-account", []),
    }),
    owned: async sid => { ownedCalls++; const ok = sid === "chat-a" && !deleted; if (when === "owned") deleted = true; return ok; },
    caller: async sessionId => { if (when === "caller") deleted = true; return { sessionId, sessionFile: "/server/known.jsonl", cwd: "/server/checkout", state: stateView([]) }; },
    current: sid => sid === "chat-a" && !deleted,
  });
  const send = (r: (typeof ROUTES)[number], body?: string) => app.request(r.path, r.method === "GET" ? {} : { method: r.method, headers: { "Content-Type": "application/json" }, body: body ?? "" });
  return { send, calls, owned: () => ownedCalls };
}

test("deletion during admission answers 404 for every job route, even with a malformed body, and never reaches the runtime", async () => {
  for (const when of ["owned", "caller"] as const) for (const r of ROUTES) for (const body of r.method !== "GET" ? ["{bad", r.valid!] : [undefined]) {
    const f = racing(when);
    const res = await f.send(r, body);
    assert.equal(res.status, 404, `${when} ${r.name} ${body}`);
    assert.deepEqual(await res.json(), { error: "Recording not found.", code: "not-found" }, "indistinguishable from a missing chat");
    assert.deepEqual(f.calls, [], `${when} ${r.name}: no runtime action after the chat was deleted`);
    assert.equal(f.owned(), 1);
  }
});

test("deletion while the runtime action runs answers 404, not 409; a live chat's refusal keeps 409 and a live malformed body keeps 400", async () => {
  for (const r of ROUTES.filter(r => r.method !== "GET")) {
    const gone = await racing("action").send(r, r.valid);
    assert.equal(gone.status, 404, `${r.name}: deleted during the action`);
    // Positive controls: the chat still exists.
    const refused = await racing("never").send(r, r.valid);
    assert.equal(refused.status, 409, `${r.name}: a live chat's refusal stays a bounded 409`);
    if (r.name !== "cancel") {
      const live = racing("never");
      const malformed = await live.send(r, "{bad");
      assert.equal(malformed.status, 400, `${r.name}: a live chat's malformed body is still 400`);
      assert.deepEqual(live.calls, [], "validation refuses before the runtime");
    }
  }
  for (const r of ROUTES.filter(r => r.method === "GET")) assert.equal((await racing("action").send(r)).status, 404, r.name);
});

test("Revoke Site and Remove Account take exactly one origin and act only for the owning chat", async () => {
  const f = fixture();
  const del = (path: string, body: unknown) => f.app.request(path, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  for (const path of ["approvals", "accounts"]) {
    assert.equal((await del(`/api/tours/chat-b/tour-a/${path}`, { origin: "https://example.test" })).status, 404, `${path}: another chat`);
    assert.equal((await del(`/api/tours/chat-a/tour-a/${path}`, { origin: "https://example.test", sessionId: "chat-b" })).status, 400, `${path}: forged field`);
    assert.equal((await del(`/api/tours/chat-a/tour-a/${path}`, { origin: "https://example.test/path" })).status, 400, `${path}: not an exact origin`);
    const ok = await del(`/api/tours/chat-a/tour-a/${path}`, { origin: "https://example.test" });
    assert.equal(ok.status, 200, path);
    assert.deepEqual(await ok.json(), [{ origin: "https://example.test", approved: false, account: false }]);
  }
  assert.deepEqual(f.calls, [{ op: "revoke-site", sessionId: "chat-a", input: "https://example.test" }, { op: "remove-account", sessionId: "chat-a", input: "https://example.test" }]);
});

/** Every console and stdio write while `run` runs, so a leak into a log fails like a leak into a reply. */
async function captured<T>(run: () => Promise<T>): Promise<{ value: T; logged: string }> {
  const out: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const saved = methods.map(m => console[m]);
  const writes = [process.stdout.write, process.stderr.write];
  for (const m of methods) console[m] = (...args: unknown[]) => { out.push(args.map(String).join(" ")); };
  const tap = (orig: typeof process.stdout.write) => function (this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]) { out.push(String(chunk)); return (orig as (...a: unknown[]) => boolean).call(this, chunk, ...rest); } as typeof process.stdout.write;
  process.stdout.write = tap(writes[0]!); process.stderr.write = tap(writes[1]!);
  try { return { value: await run(), logged: out.join("\n") }; }
  finally { methods.forEach((m, i) => { console[m] = saved[i]!; }); process.stdout.write = writes[0]!; process.stderr.write = writes[1]!; }
}

test("sign-in: owner check before any shape check, exactly one complete shape, and the reply is the job alone", async () => {
  const f = fixture();
  const url = (sid: string) => `/api/tours/${sid}/jobs/job-a/sign-in`;
  const login = { origin: "https://example.test", username: "  ada  ", password: "fixture-pw" };
  // Another chat, with a valid and an invalid body: the same 404, and no runtime call.
  for (const body of [login, { nonsense: true }, "{bad"]) {
    const res = typeof body === "string" ? await f.app.request(url("chat-b"), { method: "POST", headers: { "Content-Type": "application/json" }, body }) : await f.post(url("chat-b"), body);
    assert.equal(res.status, 404, `chat-b ${JSON.stringify(body)}`);
  }
  assert.deepEqual(f.calls, []);
  // Positive control: the owner's login and code reach the runtime exactly, the username trimmed.
  const ok = await f.post(url("chat-a"), login);
  assert.equal(ok.status, 200);
  const job = await ok.json() as TourJob;
  assert.equal(job.phase, "recording"); assert.equal(job.id, "job-a");
  assert.equal((await f.post(url("chat-a"), { origin: "https://example.test", code: "123456" })).status, 200);
  assert.deepEqual(f.calls, [
    { op: "sign-in", sessionId: "chat-a", input: { origin: "https://example.test", username: "ada", password: "fixture-pw" } },
    { op: "sign-in", sessionId: "chat-a", input: { origin: "https://example.test", code: "123456" } },
  ]);
  // Negative: anything but one complete shape is a 400 with fixed copy, before the runtime.
  const bad: unknown[] = [
    { origin: "https://example.test", code: "123456", password: "x" },
    { origin: "https://example.test", username: "ada", password: "x", code: "1" },
    { origin: "https://example.test", username: "", password: "x" },
    { origin: "https://example.test", username: "   ", password: "x" },
    { origin: "https://example.test", username: "ada", password: "" },
    { origin: "https://example.test", username: "ada", password: "line\nbreak" },
    { origin: "https://example.test", username: "a".repeat(513), password: "x" },
    { origin: "https://example.test", username: "ada", password: "x".repeat(4097) },
    { origin: "https://example.test", code: "" },
    { origin: "https://example.test", code: "1".repeat(65) },
    { origin: "https://example.test/login", username: "ada", password: "x" },
    { origin: "https://example.test", username: "ada", password: "x", sessionId: "chat-b" },
    { origin: "https://example.test", username: "ada", password: "x", testAccount: true },
    { origin: "https://example.test" },
    { username: "ada", password: "x" },
    ["https://example.test", "ada", "x"],
  ];
  for (const body of bad) {
    const res = await f.post(url("chat-a"), body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.equal(f.calls.length, 2, "no malformed body reached the runtime");
  // A body under the limit but over the field cap is the shape refusal, not the size one: the limit isn't refusing everything.
  assert.equal((await f.post(url("chat-a"), { origin: "https://example.test", username: "ada", password: "x".repeat(15_000) })).status, 400);
});

test("sign-in never echoes or logs a password or code: replies, refusals, runtime errors and stdio", async () => {
  const f = fixture();
  const pw = `PRIVATE_PW_${Math.random().toString(36).slice(2)}`, code = `PRIVATE_CODE_${Math.random().toString(36).slice(2)}`.slice(0, 40);
  const url = "/api/tours/chat-a/jobs/job-a/sign-in";
  const { value: texts, logged } = await captured(async () => {
    // Positive control: the capture really sees both console and stderr on this runtime.
    console.error("CAPTURE_CONTROL"); process.stderr.write("CAPTURE_CONTROL2\n");
    const out: { status: number; text: string }[] = [];
    const send = async (body: unknown) => { const res = await f.post(url, body); out.push({ status: res.status, text: await res.text() }); };
    await send({ origin: "https://example.test", username: "ada", password: pw });
    await send({ origin: "https://example.test", code });
    await send({ origin: "https://example.test", username: "ada", password: pw, code });
    await send({ origin: "https://example.test", username: "ada", password: `${pw}\u0000` });
    await send({ origin: "https://example.test", username: "ada", password: `THROW_${pw}` });
    // Chunked, with no Content-Length: the limit still cuts it, and the runtime never sees it.
    const big = JSON.stringify({ origin: "https://example.test", username: "ada", password: `${pw}${"x".repeat(17_000)}` });
    const stream = new ReadableStream({ start(c) { const bytes = new TextEncoder().encode(big); for (let i = 0; i < bytes.length; i += 4096) c.enqueue(bytes.slice(i, i + 4096)); c.close(); } });
    const chunked = await f.app.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
    out.push({ status: chunked.status, text: await chunked.text() });
    const sized = await f.app.request(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(big)) }, body: big });
    out.push({ status: sized.status, text: await sized.text() });
    return out;
  });
  assert.deepEqual(texts.map(t => t.status), [200, 200, 400, 400, 409, 413, 413]);
  assert.deepEqual(JSON.parse(texts[4]!.text), { error: "That recording action could not finish. Check its chat and recording report, then retry.", code: "recording-refused" }, "a runtime error's own message never reaches the reply");
  for (const t of texts) { assert.ok(!t.text.includes("PRIVATE_"), `reply ${t.status} echoed a secret`); }
  assert.ok(logged.includes("CAPTURE_CONTROL") && logged.includes("CAPTURE_CONTROL2"), "the capture saw console and stderr, so its absence check means something");
  assert.ok(!logged.includes("PRIVATE_"), "a secret reached a log");
  assert.equal(f.calls.filter(c => c.op === "sign-in").length, 3, "only the two valid bodies and the throwing one reached the runtime; the oversized ones never did");
});

test("Approve All passes exactly the shown list for the owning chat; a job that moved on is a fixed 409", async () => {
  const f = fixture();
  const url = (sid: string) => `/api/tours/${sid}/jobs/job-a/approve-all`;
  const shown = ["https://example.test", "https://api.example.test"];
  assert.equal((await f.post(url("chat-b"), { origins: shown })).status, 404);
  assert.equal((await f.post(url("chat-b"), { origins: "nope" })).status, 404, "authorization before shape");
  assert.deepEqual(f.calls, []);
  assert.equal((await f.post(url("chat-a"), { origins: shown })).status, 200);
  assert.deepEqual(f.calls, [{ op: "approve-all", sessionId: "chat-a", input: shown }]);
  for (const body of [{}, { origins: [] }, { origins: ["https://example.test", "https://example.test"] }, { origins: ["https://example.test/path"] }, { origins: Array.from({ length: 17 }, (_, i) => `https://s${i}.example.test`) }, { origins: shown, sessionId: "chat-b" }, { origin: "https://example.test" }]) {
    assert.equal((await f.post(url("chat-a"), body)).status, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.equal(f.calls.length, 1, "no malformed list reached the runtime");
  const moved = await f.post(url("chat-a"), { origins: ["https://moved.test"] });
  assert.equal(moved.status, 409);
  assert.ok(!(await moved.text()).includes("waiting for site approval"), "the runtime's message stays server-side");
});

test("sign-in with an account (a three-box sign-in): passed through trimmed, exact shapes only, never echoed or logged", async () => {
  const f = fixture();
  const url = "/api/tours/chat-a/jobs/job-a/sign-in", origin = "https://workshop.example.test";
  const acct = `PRIVATE_ACCT_${Math.random().toString(36).slice(2)}`;
  assert.equal((await f.post(url.replace("chat-a", "chat-b"), { origin, account: acct, username: "ada", password: "pw" })).status, 404, "authorization first");
  const { value: texts, logged } = await captured(async () => {
    console.error("CAPTURE_CONTROL");
    const out: { status: number; text: string }[] = [];
    for (const body of [
      { origin, account: `  ${acct}  `, username: "ada", password: "pw" },
      { origin, account: "", username: "ada", password: "pw" },
      { origin, account: "   ", username: "ada", password: "pw" },
      { origin, account: `${acct}\u0007x`, username: "ada", password: "pw" },
      { origin, account: "a".repeat(513), username: "ada", password: "pw" },
      { origin, account: 7, username: "ada", password: "pw" },
      { origin, account: acct, code: "123456" },
      { origin, account: acct, username: "ada" },
      { origin, account: acct },
    ]) { const res = await f.post(url, body); out.push({ status: res.status, text: await res.text() }); }
    return out;
  });
  assert.deepEqual(texts.map(t => t.status), [200, 400, 400, 400, 400, 400, 400, 400, 400]);
  assert.ok(logged.includes("CAPTURE_CONTROL"), "the capture works");
  for (const t of texts) assert.ok(!t.text.includes("PRIVATE_ACCT_"), `reply ${t.status} echoed the account`);
  assert.ok(!logged.includes("PRIVATE_ACCT_"), "the account reached a log");
  // Only the valid one reached the runtime, account trimmed; whether the job asks for an account is the runtime's check.
  assert.deepEqual(f.calls, [{ op: "sign-in", sessionId: "chat-a", input: { origin, account: acct, username: "ada", password: "pw" } }]);
  // Control: the two-box shape still carries no account key at all.
  await f.post(url, { origin, username: "ada", password: "pw" });
  assert.equal("account" in (f.calls[1]!.input as object), false);
});
