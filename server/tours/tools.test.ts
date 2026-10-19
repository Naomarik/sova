import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ToolCtx } from "../../shared/harness";
import type { TourJob } from "../../shared/tour";
import { tourManifestFixture, tourScriptFixture } from "../../shared/tour-fixtures";
import { stateView } from "../harness/state-view";
import { WORKER_SESSION } from "../harness/state-kinds";
import { setTourToolRuntime, showBatonTourTool, tourJobCard, tourTools, type TourToolJob, type TourToolRuntime } from "./tools";

const AT = "2026-01-02T03:04:05.000Z";
const job = (): TourJob => ({ v: 1, id: "job-demo", tourId: "tour-demo", sessionId: "session-demo", title: "Drafts", phase: "checking", completed: 2, total: 2, createdAt: AT, updatedAt: AT });
const context = (): ToolCtx => ({ sessionId: "session-demo", cwd: "/projects/demo", leafId: () => null, branch: () => [], state: () => stateView([]) });
const tools = () => tourTools("session-demo", "/sessions/demo.jsonl");
const invoke = (params: unknown, ctx: ToolCtx | undefined = context()) => tools()[0]!.execute("call-demo", params, undefined, undefined, ctx);
function runtime(): TourToolRuntime {
  const reply = async (): Promise<TourToolJob> => ({ job: job(), steps: 1 });
  return { dryRun: reply, record: reply, status: reply, cancel: reply, check: reply, inspect: async () => ({ result: await reply(), content: [{ type: "text", text: "report" }] }), show: async () => tourManifestFixture() };
}
afterEach(() => setTourToolRuntime(undefined));

test("tour tools refuse absent runtime, caller substitution and authoring secrets before execution", async () => {
  await assert.rejects(invoke({ op: "status", jobId: "job-demo" }), /not ready/);
  let called = 0; const service = runtime(); service.dryRun = async () => { called++; return { job: job(), steps: 1 }; };
  setTourToolRuntime(service);
  await assert.rejects(invoke({ op: "dry-run", script: tourScriptFixture() }, { ...context(), sessionId: "another" }), /trusted owning chat/);
  // An authoring secret is refused before the runtime, naming the field and never echoing its value.
  await assert.rejects(invoke({ op: "dry-run", script: { ...tourScriptFixture(), password: "secret" } }), (error: Error) => {
    assert.match(error.message, /^The script has a field it doesn't take: password\./);
    assert.ok(!error.message.includes("secret"), "the refusal never echoes the field's value");
    return true;
  });
  await assert.rejects(invoke({ op: "dry-run", script: tourScriptFixture(), sessionId: "another" }), /Unknown tour parameter/);
  await assert.rejects(invoke({ op: "record", dryRunId: "../other" }), /successful dryRunId/);
  assert.equal(called, 0);
});

test("each tool operation keeps trusted context separate from script parameters and projects only a small card", async () => {
  const service = runtime(); let observed: unknown;
  service.dryRun = async (caller, script) => { observed = { caller, script }; return { job: job(), steps: 1 }; };
  setTourToolRuntime(service);
  const result = await invoke({ op: "dry-run", script: tourScriptFixture() });
  assert.equal((observed as any).caller.sessionFile, "/sessions/demo.jsonl");
  assert.equal((observed as any).caller.cwd, "/projects/demo");
  assert.equal((observed as any).script.source.origin, "https://example.test");
  assert.deepEqual(result.details, { v: 1, tourId: "tour-demo", title: "Drafts", steps: 1, status: "checking", jobId: "job-demo" });
  assert.ok(!JSON.stringify(result.details).includes("source"));
  const inspected = await invoke({ op: "inspect", jobId: "job-demo" });
  assert.deepEqual(inspected.content, [{ type: "text", text: "report" }]);
  await assert.rejects(invoke({ op: "inspect", jobId: "job-demo", capture: "../secret.png" }), /exact capture filename/);
});

test("ready cards require a complete matching checked edition, never a failed or malformed result", () => {
  assert.throws(() => tourJobCard({ job: { ...job(), phase: "ready", editionId: "edition-demo" }, steps: 1 }), /no matching checked edition/);
  const ready = { job: { ...job(), phase: "ready" as const, editionId: "edition-demo" }, steps: 1, manifest: tourManifestFixture() };
  assert.equal(tourJobCard(ready).status, "ready");
  assert.throws(() => tourJobCard({ ...ready, manifest: { ...tourManifestFixture(), editionId: "wrong-edition" } }), /no matching checked edition/);
  assert.throws(() => tourJobCard({ ...ready, job: { ...ready.job, phase: "made-up" } as any }), /no matching checked edition/);
});

test("worker recording fails closed without trusted parent scope, not from script-supplied scope", async () => {
  setTourToolRuntime(runtime());
  const state = stateView([{ kind: "state", id: "marker", parentId: null, key: WORKER_SESSION.type, data: { v: 1 } }]);
  assert.ok(state.has(WORKER_SESSION));
  await assert.rejects(invoke({ op: "dry-run", script: tourScriptFixture() }, { ...context(), state: () => state }), /parent sandbox scope/);
});

test("check requires actual review schema and show accepts only checked identity from this chat", async () => {
  setTourToolRuntime(runtime());
  await assert.rejects(invoke({ op: "check", jobId: "job-demo", verification: { overviewReviewed: false, suspiciousCapturesReviewed: [], notes: "unchecked" } }), /actual overview review/);
  const shown = await tools()[1]!.execute("show", { tourId: "tour-demo", editionId: "edition-demo" }, undefined, undefined, context());
  assert.equal((shown.details as any).status, "ready");
  assert.ok(!JSON.stringify(shown).includes("scriptDigest"));
  await assert.rejects(tools()[1]!.execute("show", { tourId: "other-demo" }, undefined, undefined, context()), /matching complete checked edition/);
  const service = runtime(); service.status = async () => ({ job: { ...job(), sessionId: "other-session" }, steps: 1 }); setTourToolRuntime(service);
  await assert.rejects(invoke({ op: "status", jobId: "job-demo" }), /another chat/);
});

test("baton show is handle-only and a resolver cannot substitute another binding", async () => {
  const binding = { v: 1 as const, handle: "tr_abcdefghijklmnop", title: "Drafts", summary: "A saved draft", steps: 1, edition: "edition-demo", files: ["desktop.png"] };
  const tool = showBatonTourTool(async () => binding);
  assert.equal(tool.name, "show_tour");
  await assert.rejects(tool.execute("x", { tourId: "tour-demo", handle: binding.handle }, undefined, undefined, context()), /Unknown tour parameter/);
  await assert.rejects(tool.execute("x", { handle: "tr_qrstuvwxyzabcdef" }, undefined, undefined, context()), /not available/);
  const result = await tool.execute("x", { handle: binding.handle }, undefined, undefined, context());
  assert.deepEqual(result.details, { v: 1, handle: binding.handle, title: "Drafts", summary: "A saved draft", steps: 1 });
});

/** Problems a strict OpenAI-compatible validator has with a tool's parameters: a root combinator, a
    non-object root, or any property schema without a `type`. */
function schemaProblems(schema: unknown): string[] {
  const out: string[] = [];
  const root = schema as Record<string, unknown>;
  if (!root || root.type !== "object" || !root.properties || typeof root.properties !== "object") out.push("root is not a typed object with properties");
  for (const key of ["oneOf", "anyOf", "allOf", "not", "if"]) if (root && key in root) out.push(`root ${key}`);
  const walk = (s: unknown, at: string) => {
    if (!s || typeof s !== "object") { out.push(`${at}: not a schema`); return; }
    const o = s as Record<string, unknown>;
    if (typeof o.type !== "string") out.push(`${at}: no type`);
    if (o.properties && typeof o.properties === "object") for (const [k, v] of Object.entries(o.properties)) walk(v, `${at}.${k}`);
    if (o.items) walk(o.items, `${at}[]`);
  };
  if (root?.properties && typeof root.properties === "object") for (const [k, v] of Object.entries(root.properties)) walk(v, k);
  return out;
}

test("every served tour tool's parameters pass the strict-provider walker; the old record_tour schema fails it", () => {
  const all = [...tools(), showBatonTourTool(async () => { throw new Error("unused"); })];
  assert.deepEqual(all.map(t => t.name), ["record_tour", "show_tour", "show_tour"]);
  for (const tool of all) assert.deepEqual(schemaProblems(tool.parameters), [], tool.name);
  const record = tools()[0]!.parameters as { properties: Record<string, { enum?: string[] }>; required: string[] };
  assert.deepEqual(record.required, ["op"]);
  assert.deepEqual(record.properties.op!.enum, ["look", "dry-run", "record", "status", "cancel", "inspect", "check"]);
  // Positive control: the root-oneOf schema served before this fix (sent no arguments on zai).
  const str = { type: "string", minLength: 1, maxLength: 100 };
  const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
  const old = { oneOf: [obj({ op: { const: "dry-run" }, script: { type: "object" }, tourId: str }, ["op", "script"]), obj({ op: { const: "check" }, jobId: str, verification: obj({ overviewReviewed: { const: true } }, ["overviewReviewed"]) }, ["op", "jobId", "verification"])] };
  const problems = schemaProblems(old);
  assert.ok(problems.includes("root oneOf") && problems.includes("root is not a typed object with properties"), problems.join("; "));
  assert.deepEqual(schemaProblems(obj({ op: { const: "x" } }, ["op"])), ["op: no type"]);
});

test("record_tour names each operation's missing or foreign field before any runtime call", async () => {
  let calls = 0; const service = runtime();
  for (const k of ["dryRun", "record", "status", "cancel", "check"] as const) { const f = service[k]; (service as any)[k] = async (...a: unknown[]) => { calls++; return (f as any)(...a); }; }
  setTourToolRuntime(service);
  await assert.rejects(invoke({}), /needs "op": one of look, dry-run, record, status, cancel, inspect, check/);
  await assert.rejects(invoke({ op: "publish" }), /needs "op"/);
  await assert.rejects(invoke({ op: "dry-run" }), /dry-run needs script/);
  await assert.rejects(invoke({ op: "record" }), /record needs dryRunId/);
  for (const op of ["status", "cancel", "inspect"]) await assert.rejects(invoke({ op }), new RegExp(`${op} needs jobId`));
  await assert.rejects(invoke({ op: "check" }), /check needs jobId and verification/);
  await assert.rejects(invoke({ op: "check", jobId: "job-demo" }), /check needs verification/);
  await assert.rejects(invoke({ op: "status", jobId: "job-demo", script: {} }), /Unknown tour parameter for status: script\. status takes jobId/);
  await assert.rejects(invoke({ op: "dry-run", script: tourScriptFixture(), jobId: "job-demo" }), /Unknown tour parameter for dry-run: jobId/);
  await assert.rejects(invoke({ op: "check", jobId: "job-demo", verification: { overviewReviewed: false, suspiciousCapturesReviewed: [], notes: "not looked" } }), /actual overview review/);
  await assert.rejects(invoke({ op: "look" }), /look needs source and pages/);
  await assert.rejects(invoke({ op: "look", source: { kind: "site", origin: "https://app.example.test" }, pages: [{ route: "/" }], script: {} }), /Unknown tour parameter for look: script/);
  await assert.rejects(invoke({ op: "look", source: { kind: "site", origin: "https://app.example.test" }, pages: [{ route: "nowhere" }] }), /pages\[0\]: route must be a path/);
  assert.equal(calls, 0);
  // Positive control: the same operations with their fields reach the runtime.
  await invoke({ op: "status", jobId: "job-demo" });
  await invoke({ op: "dry-run", script: tourScriptFixture() });
  assert.equal(calls, 2);
});

test("a project source names its running copy alone, and a bad source field is named instead of a generic invalid script", async () => {
  const { normalizeTourScript } = await import("../../shared/tour");
  let reached: unknown[] = []; const service = runtime();
  service.dryRun = async (_caller, script) => { reached.push(script.source); return { job: job(), steps: 1 }; };
  setTourToolRuntime(service);
  const short = { kind: "project", instanceId: "sova-de20b2ff", serviceId: "server", endpoint: "http" };
  const withSource = (source: unknown) => ({ ...tourScriptFixture(), source });
  // The stored form still needs the server-derived fields: the short form is only an authoring request.
  assert.equal(normalizeTourScript(withSource(short)), undefined, "control: a stored script needs projectId and checkout");
  await invoke({ op: "dry-run", script: withSource(short) });
  await invoke({ op: "dry-run", script: withSource({ ...short, projectId: "prj_aaaaaaaa", checkout: "/projects/demo" }) });
  assert.deepEqual(reached, [short, { ...short, projectId: "prj_aaaaaaaa", checkout: "/projects/demo" }]);
  reached = [];
  const named: [unknown, RegExp][] = [
    [{ ...short, projectId: "/home/me/project" }, /^Error: source\.projectId must be an id like prj_…, not a path; omit it and Sova fills it in\.$/],
    [{ ...short, checkout: "projects/demo" }, /^Error: source\.checkout must be the copy's absolute canonical checkout path; omit it and Sova fills it in\.$/],
    [{ kind: "project", serviceId: "server", endpoint: "http" }, /^Error: source\.instanceId is required/],
    [{ ...short, endpoint: 4820 }, /^Error: source\.endpoint must be the endpoint's name/],
    [{ ...short, endpoint: "server.http" }, /^Error: source\.endpoint is the port's name alone: for "server\.http" use serviceId "server" and endpoint "http"\.$/],
    [{ ...short, port: 4820 }, /^Error: source has a field a project source doesn't take: port\./],
    [{ kind: "site", origin: "https://example.test/path" }, /^Error: source\.origin must be an exact http\(s\) origin/],
    [{ kind: "copy" }, /^Error: source\.kind must be "project" or "site"/],
  ];
  for (const [source, message] of named) await assert.rejects(invoke({ op: "dry-run", script: withSource(source) }), message, JSON.stringify(source));
  const { source: _drop, ...noSource } = tourScriptFixture();
  await assert.rejects(invoke({ op: "dry-run", script: noSource }), /^Error: The script needs source/);
  // A problem outside the source is named too, by its field (§app.tours/authoring).
  await assert.rejects(invoke({ op: "dry-run", script: { ...withSource(short), title: "" } }), /^Error: title must be 1 to 200 characters\.$/);
  assert.deepEqual(reached, []);
});

test("an unknown top-level script field is named, and every optional top-level field still passes", async () => {
  const { normalizeTourScriptRequest, tourScriptProblem } = await import("../../shared/tour");
  let calls = 0; const service = runtime(); service.dryRun = async () => { calls++; return { job: job(), steps: 1 }; };
  setTourToolRuntime(service);
  // Positive control: every optional top-level field the validator knows, at once.
  const full = { ...tourScriptFixture(), sites: ["https://cdn.example.test"], accountId: "acct-demo" };
  assert.ok(normalizeTourScriptRequest(full), "control: every optional top-level field is accepted");
  assert.equal(tourScriptProblem(full), null);
  await invoke({ op: "dry-run", script: full });
  assert.equal(calls, 1);
  // Retry 4's slip exactly: a view's empty actions map at the top level.
  const slip = { ...tourScriptFixture(), actions: {} };
  assert.equal(normalizeTourScriptRequest(slip), undefined);
  assert.match(tourScriptProblem(slip) ?? "", /^The script has a field it doesn't take: actions\. A script takes v, title, summary, audience, outcome, source, sites, accountId, signIn, chapters, steps; a view's fields \(route, sizes, actions, marks, masks\) belong on a view inside steps\.$/);
  await assert.rejects(invoke({ op: "dry-run", script: slip }), /^Error: The script has a field it doesn't take: actions\./);
  // Echoed names are bounded: at most five, each at most 40 characters, control characters dropped.
  const noisy = { ...tourScriptFixture(), ["a".repeat(60)]: 1, "bad\u0007name\n": 1, f3: 1, f4: 1, f5: 1, f6: 1, f7: 1 };
  assert.equal(normalizeTourScriptRequest(noisy), undefined);
  const said = tourScriptProblem(noisy) ?? "";
  assert.match(said, new RegExp(`^The script has fields it doesn't take: ${"a".repeat(40)}…, badname, f3, f4, f5 and 2 more\\.`));
  assert.ok(!/[\u0000-\u001f]/.test(said));
  assert.equal(calls, 1, "neither refused script reached the runtime");
});

test("a page view missing actions is named by its place, and the same view with actions passes", async () => {
  const { normalizeTourScriptRequest, tourScriptProblem } = await import("../../shared/tour");
  let calls = 0; const service = runtime(); service.dryRun = async () => { calls++; return { job: job(), steps: 1 }; };
  setTourToolRuntime(service);
  const base = tourScriptFixture();
  // A reference view takes no actions: the control exercises the page-only check skipping it.
  const ref = { id: "ref", title: "Ref", kind: "reference" as const, note: "", reference: "Text." };
  const twoSteps = { ...base, steps: [...base.steps, { ...base.steps[0]!, id: "second", views: [{ ...base.steps[0]!.views[0]! }, ref] }] };
  // Control: both page views carry actions, and the reference view has none.
  assert.ok(normalizeTourScriptRequest(twoSteps));
  assert.equal(tourScriptProblem(twoSteps), null);
  await invoke({ op: "dry-run", script: twoSteps });
  assert.equal(calls, 1);
  // Retry 4's other slip: the first view of the second step without actions.
  const { actions: _drop, ...noActions } = twoSteps.steps[1]!.views[0] as unknown as Record<string, unknown>;
  const missing = { ...twoSteps, steps: [twoSteps.steps[0]!, { ...twoSteps.steps[1]!, views: [noActions, ref] }] };
  assert.equal(normalizeTourScriptRequest(missing), undefined);
  assert.equal(tourScriptProblem(missing), 'steps[1] "second" \u203a views[0] "overview" is a page view and needs actions.');
  await assert.rejects(invoke({ op: "dry-run", script: missing }), /^Error: steps\[1\] "second" \u203a views\[0\] "overview" is a page view and needs actions\.$/);
  assert.equal(calls, 1, "the refused script never reached the runtime");
});

test("look reaches the runtime with its request and tour id, and its answer carries the look", async () => {
  const service = runtime();
  const seen: unknown[] = [];
  service.look = async (_caller, request, tourId) => { seen.push([request, tourId]); return { job: job(), steps: 1, look: { tourId: tourId ?? "tour-demo", next: "Run the dry run with tourId." } }; };
  setTourToolRuntime(service);
  const request = { source: { kind: "site", origin: "https://app.example.test" }, signInRoute: "/login", pages: [{ route: "/" }] };
  const result = await invoke({ op: "look", ...request, tourId: "tour-demo" }) as { content: { text: string }[] };
  assert.deepEqual(seen, [[request, "tour-demo"]]);
  assert.deepEqual((JSON.parse(result.content[0]!.text) as { look: unknown }).look, { tourId: "tour-demo", next: "Run the dry run with tourId." });
});
