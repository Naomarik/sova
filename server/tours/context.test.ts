import { test } from "node:test";
import assert from "node:assert/strict";
import type { HEntry } from "../../shared/harness";
import { stateView } from "../harness/state-view";
import { resolveTourContext, resolveTourSource, type TourContextDeps, type TourHeldSandbox } from "./context";
import type { TourToolCaller } from "./tools";
import type { InstanceRecord, Registry } from "../project-services/store";

const entry = (key: string, data: unknown): HEntry => ({ kind: "state", id: key, parentId: null, key, data });
const sandbox = entry("sandbox", { version: 1, on: true, level: "workspace-write", enforcement: "full", backend: "test" });
const caller: TourToolCaller = { sessionId: "real-chat", sessionFile: "/server/chat.jsonl", cwd: "/forged/cwd", state: stateView([]) };
const heldOff: TourHeldSandbox = { on: false, enforcement: "none" };
/** `held`: what the process holding the chat reports; "unheld": this server holds no process for it. */
function deps(entries: HEntry[] = [sandbox], hold: TourHeldSandbox | null | "unheld" = heldOff): TourContextDeps {
  const held = hold === "unheld" ? undefined : hold;
  return { canonical: p => p, snapshot: async () => ({ sessionId: "real-chat", sessionFile: "/server/chat.jsonl", cwd: "/server/checkout", agentDir: "/server/agent", state: stateView(entries), held }) };
}
test("forged sessionId/cwd/sandbox in authoring input cannot replace trusted server context", async () => {
  const argument = { sessionId: "victim-chat", cwd: "/private", sandbox: { on: false } };
  const d = deps();
  // A malicious caller snapshot is deliberately not authority: the server snapshot is re-read.
  const context = await resolveTourContext({ ...caller, ...argument, sessionId: caller.sessionId }, d);
  assert.equal(context.sessionId, "real-chat"); assert.equal(context.cwd, "/server/checkout"); assert.equal(context.sandbox.on, true);
  await assert.rejects(resolveTourContext({ ...caller, sessionId: argument.sessionId }, d), /context cannot be established/);
});
test("without a held report only a recorded On runs (confined); Off or no entry refuses, never reading a policy default", async () => {
  for (const held of ["unheld", null] as const) {
    const error = await resolveTourContext(caller, deps([], held)).then(() => null, (e: Error) => e);
    assert.match(String(error?.message), /sandbox state can't be established.*Open this chat/, String(held));
    assert.doesNotMatch(String(error?.message), /Set Sandbox to On/, "never tells the user to change the sandbox to make recording work");
  }
  // Without a live process vouching for it, a recorded Off never runs unconfined; a recorded On still runs confined.
  const off = entry("sandbox", { version: 1, on: false, level: "workspace-write", enforcement: "none", backend: "none" });
  await assert.rejects(resolveTourContext(caller, deps([off], "unheld")), /sandbox state can't be established.*Open this chat/, "closed chat, recorded Off");
  assert.equal((await resolveTourContext(caller, deps([sandbox], "unheld"))).sandbox.on, true, "closed chat, recorded On: confined");
  // A held runtime reporting no sandbox state vouches for nothing, whatever the file says.
  for (const entries of [[off], [sandbox]]) await assert.rejects(resolveTourContext(caller, deps(entries, null)), /sandbox state can't be established/);
});
test("a default chat with no sandbox entry follows the state its held chat process reports", async () => {
  // Subagents only / Off: the chat's own tools are unconfined, so the recorder is too.
  assert.equal((await resolveTourContext(caller, deps([], heldOff))).sandbox.on, false);
  // On without a flushed entry: the held process decides, not the absent file entry.
  assert.equal((await resolveTourContext(caller, deps([], { on: true, enforcement: "full" }))).sandbox.on, true);
  await assert.rejects(resolveTourContext(caller, deps([], { on: true, enforcement: "unavailable" })), /not enforced locally/);
});
test("either On confines: a held On beats a recorded Off, and a recorded On beats a held Off", async () => {
  const off = entry("sandbox", { version: 1, on: false, level: "workspace-write", enforcement: "none", backend: "none" });
  assert.equal((await resolveTourContext(caller, deps([off], { on: true, enforcement: "full" }))).sandbox.on, true);
  assert.equal((await resolveTourContext(caller, deps([sandbox], heldOff))).sandbox.on, true);
  await assert.rejects(resolveTourContext(caller, deps([entry("sandbox", { version: 1, on: true, level: "workspace-write", enforcement: "unavailable" })], heldOff)), /not enforced locally/);
});
test("worker scope refuses even off-looking state without server parent provenance", async () => {
  const off = entry("sandbox", { version: 1, on: false, level: "workspace-write", workers: "off" });
  await assert.rejects(resolveTourContext(caller, deps([off, entry("subagents-worker-session", {})])), /parent sandbox scope is unavailable/);
  await assert.rejects(resolveTourContext(caller, deps([entry("subagents-worker-session", {})], heldOff)), /parent sandbox scope is unavailable/);
});
test("unavailable or remote sandbox cannot be used to launch a local recording", async () => {
  for (const enforcement of ["none", "unavailable"]) await assert.rejects(resolveTourContext(caller, deps([entry("sandbox", { version: 1, on: true, level: "workspace-write", enforcement })])), /not enforced locally/);
});
function twoProjects() {
  const rec = (id: string, project: string, checkout: string, slot = 1): InstanceRecord => ({ id, project, checkout, branch: "b", slot, generation: 1, createdBy: "session:real-chat", createdAt: "2026-01-02T03:04:05.000Z", cutWorktree: false, desired: { web: "running" }, prints: {}, data: {}, ports: { web: { http: 10000 + slot } } });
  // The chat's cwd (/server/checkout) is project A's; B is another project on the same host.
  const registry: Registry = { version: 1, shared: [], instances: [rec("copy-a", "/server/project", "/server/checkout"), rec("copy-b", "/other/project", "/other/checkout", 2)] };
  const projectsRead: string[] = [];
  const projects = async () => { projectsRead.push("listed"); return [{ id: "prj_aaaaaaaa", root: "/server/project" }, { id: "prj_bbbbbbbb", root: "/other/project" }]; };
  const roots: string[] = [];
  const d: TourContextDeps = { ...deps(), registry: () => registry, projects, canonical: p => { roots.push(p); return p; } };
  return { registry, d, projectsRead, roots };
}
const full = { kind: "project" as const, projectId: "prj_aaaaaaaa", instanceId: "copy-a", checkout: "/server/checkout", serviceId: "web", endpoint: "http" };
const short = { kind: "project" as const, instanceId: "copy-a", serviceId: "web", endpoint: "http" };

test("a short project source is filled in from the registry and the chat's project; a matching full one gives the same", async () => {
  const f = twoProjects();
  const context = await resolveTourContext(caller, f.d);
  assert.deepEqual(await resolveTourSource(context, short, f.d), full, "short form: Sova derives projectId and checkout");
  assert.deepEqual(await resolveTourSource(context, full, f.d), full, "control: the matching full form");
  assert.deepEqual(await resolveTourSource(context, { ...short, projectId: "prj_aaaaaaaa" }, f.d), full);
});

test("a supplied projectId or checkout that doesn't match is refused by field and never used", async () => {
  const f = twoProjects();
  const context = await resolveTourContext(caller, f.d);
  // B's project id with A's instance: derivation must not take the supplied id (it would find B).
  await assert.rejects(resolveTourSource(context, { ...short, projectId: "prj_bbbbbbbb" }, f.d), (e: Error) => e.message === "source.projectId doesn't match this running copy's project (prj_aaaaaaaa). Omit it and Sova fills it in.");
  await assert.rejects(resolveTourSource(context, { ...short, checkout: "/other/checkout" }, f.d), (e: Error) => e.message === "source.checkout doesn't match this running copy's checkout (/server/checkout). Omit it and Sova fills it in." && !e.message.includes("/other/checkout"));
  // An alias of the same folder canonicalizes to it and matches.
  const aliased: TourContextDeps = { ...f.d, canonical: p => p === "/alias/checkout" ? "/server/checkout" : p };
  assert.deepEqual(await resolveTourSource(context, { ...short, checkout: "/alias/checkout" }, aliased), full);
});

test("another project's running copy is refused by source.instanceId before its project is read", async () => {
  const f = twoProjects();
  const context = await resolveTourContext(caller, f.d);
  f.projectsRead.length = 0; f.roots.length = 0;
  // Even with B's own correct projectId and checkout supplied, B is not this chat's project.
  for (const source of [{ ...short, instanceId: "copy-b" }, { ...full, instanceId: "copy-b", projectId: "prj_bbbbbbbb", checkout: "/other/checkout" }])
    await assert.rejects(resolveTourSource(context, source, f.d), (e: Error) => e.message === "Recording refused: source.instanceId is not a running copy of this chat's project (its checkout or an active tracked worktree).");
  assert.deepEqual(f.projectsRead, [], "the project list was never read");
  assert.ok(!f.roots.includes("/other/project"), "B's project root was never read");
  await assert.rejects(resolveTourSource(context, { ...short, instanceId: "copy-z" }, f.d), /source\.instanceId is not a running copy/);
});

test("a re-record from a chat that no longer holds the copy is refused by field, never re-derived to another copy", async () => {
  const f = twoProjects();
  const moved: TourContextDeps = { ...f.d, snapshot: async () => ({ sessionId: "real-chat", sessionFile: "/server/chat.jsonl", cwd: "/other/checkout", agentDir: "/server/agent", state: stateView([sandbox]), held: heldOff }) };
  const context = await resolveTourContext(caller, moved);
  // The stored, pinned full source of A, as a re-record passes it.
  await assert.rejects(resolveTourSource(context, full, moved), /Recording refused: source\.instanceId is not a running copy of this chat's project/);
});

test("the endpoint is the port name alone; a service-qualified name is refused with the separate fields spelled out", async () => {
  const f = twoProjects();
  const context = await resolveTourContext(caller, f.d);
  const message = 'Recording refused: source.serviceId and source.endpoint must name a declared port of that copy, the port name alone: serviceId "web", endpoint "http".';
  await assert.rejects(resolveTourSource(context, { ...short, endpoint: "web.http" }, f.d), (e: Error) => e.message === 'source.endpoint is the port\'s name alone: for "web.http" use serviceId "web" and endpoint "http".');
  await assert.rejects(resolveTourSource(context, { ...short, endpoint: "https" }, f.d), (e: Error) => e.message === message, "https");
  await assert.rejects(resolveTourSource(context, { ...short, serviceId: "api" }, f.d), (e: Error) => e.message === message);
});

test("a copy whose project isn't registered here is refused", async () => {
  const f = twoProjects();
  const context = await resolveTourContext(caller, f.d);
  const none: TourContextDeps = { ...f.d, projects: async () => [] };
  await assert.rejects(resolveTourSource(context, short, none), (e: Error) => e.message === "Recording refused: this running copy's project isn't registered here.");
});
test("a chat whose sandbox is still turning on refuses, from its provisional entry or its held report", async () => {
  const provisional = entry("sandbox", { version: 1, on: true, level: "workspace-write", backend: "linux-bwrap", enforcement: "unavailable", reasons: ["starting"] });
  for (const d of [deps([provisional], "unheld"), deps([provisional], heldOff), deps([], { on: true, enforcement: "unavailable", starting: true })])
    await assert.rejects(resolveTourContext(caller, d), /still turning on/);
  // Positive control: a real unavailable On keeps its own refusal, and a final On records.
  await assert.rejects(resolveTourContext(caller, deps([entry("sandbox", { version: 1, on: true, level: "workspace-write", enforcement: "unavailable", reasons: ["bwrap missing"] })], heldOff)), /not enforced locally/);
  assert.equal((await resolveTourContext(caller, deps([sandbox], heldOff))).sandbox.on, true);
});
