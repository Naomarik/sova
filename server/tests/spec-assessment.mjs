// Actual common team spawn -> scripted RPC child running the pinned SDK/spec-worker -> owner reopen -> readiness.
// No model/network requests. The spawnImpl replaces only the CLI transport, not the worker's SDK lifecycle.
import "../../pi-config/extensions/claude-code/tests/hermetic-env.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, readdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
const here = path.dirname(fileURLToPath(import.meta.url));
process.env.PI_PACKAGE_DIR = realpathSync(path.resolve(here, "../../node_modules/@earendil-works/pi-coding-agent"));
if (process.env.SOVA_ASSESS_TEST_AGENT) process.env.PI_CODING_AGENT_DIR = process.env.SOVA_ASSESS_TEST_AGENT;
const { jiti } = await import("../../pi-config/extensions/subagents/tests/runtime.mjs");
const { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager, initTheme } = await jiti.import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await jiti.import("@earendil-works/pi-ai");
initTheme(); // Match an actual host's theme initialization; never manually enable an extension tool.
const { registerSubagents } = await jiti.import(path.resolve(here, "../../pi-config/extensions/subagents/index.ts"));
const { SubagentRunner } = await jiti.import(path.resolve(here, "../../pi-config/extensions/subagents/runner.ts"));
const { computeReadiness, configureReadiness, resetReadiness, readinessChecksOf } = await jiti.import(path.resolve(here, "../merge-readiness.ts"));

function provider(script, probe) {
 return pi => pi.registerProvider("scripted", { baseUrl: "http://localhost", apiKey: "unused", api: "openai-completions", models: [{ id: "assessment", name: "Scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
  streamSimple(model) {
   const stream = createAssistantMessageEventStream(), step = script.shift() ?? { text: "Done.\nAlso changes: none" }; probe?.(step);
   const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: step.tool ? "toolUse" : "stop", timestamp: Date.now() };
   queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    if (step.tool) { const call = { type: "toolCall", id: `call-${crypto.randomUUID()}`, name: step.tool, arguments: step.args }; message.content.push(call); stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message }); }
    else { message.content.push({ type: "text", text: step.text }); stream.push({ type: "text_end", contentIndex: 0, content: step.text, partial: message }); }
    stream.push({ type: "done", reason: message.stopReason, message });
   });
   return stream;
  },
 });
}

if (process.argv.includes("--worker")) {
 const cwd = process.env.SOVA_ASSESS_TEST_CWD, agentDir = process.env.SOVA_ASSESS_TEST_AGENT;
 const script = [{ tool: "write", args: { path: "src/value.ts", content: "export const value = 90;\n" } }, { tool: "spec_assess", args: { action: "record", by: "scripted fixture", self: true, decisions: { decisions: [{ ids: ["§demo/rule"], disposition: "unresolved", reason: "Implementation changed while the old requirement says 80; comparison remains outstanding.", basis: [{ kind: "test", revision: process.env.SOVA_ASSESS_TEST_BASE, result: "failed", summary: "A declared fixture verification result, not semantic proof." }] }], files: [] } } }, { text: "Done.\nAlso changes: none" }];
 const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, additionalExtensionPaths: [path.resolve(here, "../../pi-config/extensions/mode/spec-worker.ts")], extensionFactories: [provider(script, step => {
  if (step.tool === "spec_assess") {
   const store = path.join(cwd, ".sova/spec/assessments");
   const names = readdirSync(store).filter(n => !n.startsWith("."));
   const packet = JSON.parse(readFileSync(path.join(store, names[0], "packet.json"), "utf8"));
   assert.equal(packet.capture.candidates[0].disposition, "unresolved");
   writeFileSync(process.env.SOVA_ASSESS_TEST_PROBE, JSON.stringify({ packet, recordAbsentBeforeRecording: !readdirSync(path.join(store, names[0])).includes("record.json"), spawnEnvironment: { owner: process.env.SOVA_SPEC_OWNER_SESSION, worker: process.env.SOVA_SPEC_WORKER_ID, team: process.env.SOVA_SPEC_TEAM_ID } }));
  }
 })] });
 await loader.reload();
 const manager = SessionManager.create(cwd, path.join(agentDir, "sessions/worker"));
 const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, settingsManager: SettingsManager.inMemory(), sessionManager: manager });
 await session.setModel(session.modelRuntime.getModel("scripted", "assessment"));
 const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
 session.subscribe(send);
 createInterface({ input: process.stdin }).on("line", async line => {
  try {
   const cmd = JSON.parse(line);
   if (cmd.type === "get_state") send({ type: "response", id: cmd.id, command: cmd.type, success: true, data: { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), model: session.model, thinkingLevel: "high" } });
   else if (cmd.type === "prompt") { send({ type: "response", id: cmd.id, command: cmd.type, success: true }); await session.prompt(cmd.message); }
   else if (cmd.type === "abort") { await session.abort(); send({ type: "response", id: cmd.id, command: cmd.type, success: true }); }
   else send({ type: "response", id: cmd.id, command: cmd.type, success: false, error: "unsupported fixture command" });
  } catch (error) { process.stderr.write(String(error.stack ?? error)); process.exitCode = 1; }
 });
} else {
 const scratch = mkdtempSync(path.join(tmpdir(), "assessment-spawn-sdk-")), cwd = path.join(scratch, "project"), agentDir = path.join(scratch, "agent"), probe = path.join(scratch, "worker-probe.json");
 let session, runners = [];
 try {
  mkdirSync(path.join(cwd, ".sova/spec/claims/demo"), { recursive: true }); mkdirSync(path.join(cwd, "src")); mkdirSync(path.join(agentDir, "extensions"), { recursive: true }); symlinkSync(path.resolve(here, "../../pi-config/extensions/spec"), path.join(agentDir, "extensions/spec")); process.env.PI_CODING_AGENT_DIR = agentDir;
  writeFileSync(path.join(cwd, ".sova/spec/manifest.json"), JSON.stringify({ formatVersion: 1, grammar: { claimsRoot: "claims/", directoryKinds: ["section"] }, boundary: { include: ["src"], exclude: [] }, claims: { "§demo/rule": { kind: "behavior", code: ["src/value.ts"], requires: [], authority: "accepted", evidence: "verified" } } }));
  writeFileSync(path.join(cwd, ".sova/spec/claims/demo/rule.md"), "# §demo/rule\n\nValue is 80.\n"); writeFileSync(path.join(cwd, ".sova/spec/.gitignore"), "/assessments/\n/drafts/\n"); writeFileSync(path.join(cwd, "src/value.ts"), "export const value = 80;\n");
  const git = (...args) => { const r = spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git("init", "-q", "-b", "master"); git("add", "."); git("commit", "-qm", "initial"); const base = git("rev-parse", "HEAD");
  const parentScript = [{ tool: "team_create", args: { name: "assessment fixture", objective: "Observe the unchanged requirement", members: [{ role: "author", prompt: "Change value to 90 and record an outstanding observation.", tools: ["read", "write", "bash"], wake: false }] } }, { text: "Team started." }];
  const manager = SessionManager.create(cwd, path.join(agentDir, "sessions/owner"));
  const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, extensionFactories: [provider(parentScript), pi => {
   pi.events.on("mode:discover", () => pi.events.emit("mode:state", { version: 1, minorModes: ["spec"] }));
   registerSubagents(pi, (options, handlers) => {
    const runner = new SubagentRunner({ ...options, spawnImpl: (_command, args, spawnOptions) => {
     assert.ok(args.includes(path.resolve(here, "../../pi-config/extensions/mode/spec-worker.ts")), "actual common code-writing worker path injected the worker observer");
     return spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker"], { ...spawnOptions, env: { ...spawnOptions.env, SOVA_ASSESS_TEST_CWD: cwd, SOVA_ASSESS_TEST_AGENT: agentDir, SOVA_ASSESS_TEST_BASE: base, SOVA_ASSESS_TEST_PROBE: probe } });
    } }, handlers); runners.push(runner); return runner;
   }, { agentDir, policyFile: path.join(agentDir, "absent-policy.json"), hosting: { enabled: false } });
  }] });
  await loader.reload();
  ({ session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, settingsManager: SettingsManager.inMemory(), sessionManager: manager }));
  await session.setModel(session.modelRuntime.getModel("scripted", "assessment"));
  await session.prompt("Start the assessment team");
  assert.equal(runners.length, 1, "actual team_create launched a real runner");
  const worker = runners[0], until = Date.now() + 30_000;
  while (!worker.isSettled() && Date.now() < until) await new Promise(r => setTimeout(r, 25));
  assert.equal(worker.taskOutcome, "success", worker.error ?? worker.finalOutput());
  const workerRecord = readFileSync(worker.sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line)).find(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "spec_assess");
  assert.equal(workerRecord.message.details.written, true);
  assert.equal(workerRecord.message.isError, false, "recording a failed verification declaration is still a normal operation, not a semantic gate");
  const captured = JSON.parse(readFileSync(probe, "utf8"));
  assert.equal(captured.recordAbsentBeforeRecording, true); assert.equal(captured.spawnEnvironment.owner, manager.getSessionId()); assert.equal(captured.spawnEnvironment.worker, worker.id); assert.ok(captured.spawnEnvironment.team);
  assert.equal(captured.packet.attribution.sessionId, worker.sessionId); assert.equal(captured.packet.query.base, base);
  const ownerFile = manager.getSessionFile();
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose(); session = undefined;
  const reopened = SessionManager.open(ownerFile); const entries = reopened.getEntries();
  const manifests = entries.filter(e => e.type === "custom" && e.customType === "subagents-worker-manifest");
  assert.ok(manifests.some(e => e.data.ref?.sessionId === worker.sessionId), "production recorder persisted worker identity");
  resetReadiness(); configureReadiness({ insights: { treeStatus: async () => ({ exists: true, readable: true, branch: "fixture", base: "master", ahead: 1, dirty: false, merged: false, subjects: [], headAt: 2 }) }, git: async () => "" });
  const row = { id: reopened.getSessionId(), path: ownerFile, cwd, busy: false, archived: false, lastActiveAt: new Date().toISOString() };
  const facts = { trees: [{ path: cwd, branch: "fixture", base, status: "active", session: row.id, action: "created" }], merges: [], lastCheck: { at: 1, ok: false } };
  const result = await computeReadiness(row, facts);
  assert.equal(result.trees[0].state, "in-progress"); assert.equal(result.trees[0].why, "the last check failed"); assert.deepEqual(readinessChecksOf(ownerFile).lastCheck, facts.lastCheck);
  assert.equal(result.specObservations.items.length, 1); const observation = result.specObservations.items[0];
  assert.equal(observation.attributionState, "matched", JSON.stringify(observation)); assert.equal(observation.assessmentState, "outstanding"); assert.equal(observation.verification[0].result, "failed"); assert.equal(observation.verification[0].revisionBinding.inputApplicability, "mismatched");
  // Actual full-mode command activation, strict snapshot, tool execution, and persisted restore.
  writeFileSync(path.join(cwd, "src/value.ts"), "export const value = 80;\n");
  const proseBefore = readFileSync(path.join(cwd, ".sova/spec/claims/demo/rule.md"), "utf8");
  mkdirSync(path.join(cwd, ".sova/spec/drafts/unknown-local/attachments"), { recursive: true });
  let immutableRecord;
  const modeScript = [{ tool: "write", args: { path: "src/value.ts", content: "const base = 80; export const value = base;\n" } }, { tool: "spec_assess", args: { action: "record", by: "scripted inspection", self: true, decisions: { decisions: [{ ids: ["§demo/rule"], disposition: "preserved", reason: "The literal 80 moved into a named constant; the value is unchanged.", basis: [{ kind: "inspection", revision: null, result: "passed", summary: "Compared the literal and constant reference in this fixture." }] }], files: [] } } }, { tool: "spec_assess", args: { action: "status" } }, { tool: "spec_assess", args: { action: "record", name: "absent-receipt", by: "scripted inspection", decisions: { decisions: [], files: [] } } }, { tool: "spec_assess", staleRecord: true, args: { action: "record", by: "scripted inspection", decisions: { decisions: [], files: [] } } }, { text: "Done.\nAlso changes: none" }];
  const makeModeSession = async manager => {
   const resources = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, additionalExtensionPaths: [path.resolve(here, "../../pi-config/extensions/mode/index.ts")], extensionFactories: [provider(modeScript, step => {
    if (!step.staleRecord) return;
    const store = path.join(cwd, ".sova/spec/assessments");
    const names = readdirSync(store).filter(n => !n.startsWith(".")).filter(n => JSON.parse(readFileSync(path.join(store, n, "packet.json"), "utf8")).attribution.ownerSessionId === modeManager.getSessionId());
    assert.equal(names.length, 1, "the original comparison is retained before stale refusal");
    step.args.name = names[0];
    const file = path.join(store, names[0], "record.json"); immutableRecord = { file, bytes: readFileSync(file, "utf8") };
    writeFileSync(path.join(cwd, "src/value.ts"), "const base = 80; export const value = base + 0;\n");
   })] });
   await resources.reload();
   const created = await createAgentSession({ cwd, agentDir, resourceLoader: resources, settingsManager: SettingsManager.inMemory(), sessionManager: manager });
   if (process.env.SOVA_ASSESS_TRACE) {
    created.session.subscribe(event => { if (event.type === "extension_error") process.stderr.write(`extension-error ${JSON.stringify(event)}\n`); });
    const set = created.session.setActiveToolsByName.bind(created.session);
    created.session.setActiveToolsByName = names => { process.stderr.write(`tool-set ${JSON.stringify(names)}\n`); const result = set(names); process.stderr.write(`tool-active ${JSON.stringify(created.session.getActiveToolNames())}\n`); return result; };
   }
   await created.session.bindExtensions({ ...(process.env.SOVA_ASSESS_TRACE ? { onError: error => process.stderr.write(`binding-error ${JSON.stringify(error)}\n`) } : {}) });
   await created.session.setModel(created.session.modelRuntime.getModel("scripted", "assessment")); return created.session;
  };
  const modeManager = SessionManager.create(cwd, path.join(agentDir, "sessions/full-mode")); session = await makeModeSession(modeManager);
  assert.ok(!session.getActiveToolNames().includes("spec_assess"));
  await session.prompt("/mode spec on"); assert.ok(session.getActiveToolNames().includes("spec_assess"), "command activates, not only registers");
  await session.prompt("/mode delegate"); await session.prompt("/mode strict on");
  await session.prompt("/mode spec off"); assert.ok(!session.getActiveToolNames().includes("spec_assess"));
  await session.prompt("/mode strict off"); assert.ok(!session.getActiveToolNames().includes("spec_assess"), "strict restore cannot resurrect the disabled tool");
  await session.prompt("/mode normal"); await session.prompt("/mode spec on");
  await session.prompt("Refactor without changing the value and explicitly record the comparison");
  const results = modeManager.getBranch().filter(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "spec_assess");
  assert.equal(results.length, 4); assert.ok(results.slice(0, 2).every(e => !e.message.isError), JSON.stringify(results));
  assert.equal(results[1].message.details.assessmentState, "recorded");
  assert.equal(results[1].message.details.exit, 1, "unknown applicability is still a normal status query");
  assert.equal(results[1].message.details.applicability, "unknown");
  assert.equal(results[1].message.details.decisions.decisions[0].disposition, "preserved");
  assert.equal(results[2].message.details.exit, 2, "a missing receipt is an explicit operational refusal");
  assert.equal(results[2].message.isError, true, "SDK refusal must not be flagged as a successful tool operation, even though structured details remain");
  assert.equal(results[3].message.details.exit, 1, "stale record refusal retains structured status");
  assert.equal(results[3].message.isError, true);
  assert.notEqual(results[3].message.details.written, true);
  for (const refused of results.slice(2)) assert.deepEqual(JSON.parse(refused.message.content[0].text), refused.message.details, "operative error flag preserves the full structured content and details");
  assert.equal(readFileSync(immutableRecord.file, "utf8"), immutableRecord.bytes, "refusal does not overwrite a record or clear candidates"); assert.equal(readFileSync(path.join(cwd, ".sova/spec/claims/demo/rule.md"), "utf8"), proseBefore);
  const modeFile = modeManager.getSessionFile(), count = modeManager.getBranch().filter(e => e.customType === "spec-assessment-task-v1").length;
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); session = undefined;
  const restored = SessionManager.open(modeFile); session = await makeModeSession(restored);
  assert.ok(session.getActiveToolNames().includes("spec_assess"), "reopen restores the active optional tool");
  assert.equal(restored.getBranch().filter(e => e.customType === "spec-assessment-task-v1").length, count, "opening creates no new assessment task");
  await session.prompt("/mode spec off"); assert.ok(!session.getActiveToolNames().includes("spec_assess"));
  console.log(JSON.stringify({ result: "pass", commonTeamSpawn: true, actualWorkerSdk: true, parentReopened: true, actualModeToolExecution: true, strictAndReopen: true, operationalRefusalsWithDetails: true, unchangedGate: result.trees[0].why, observation: { attributionState: observation.attributionState, assessmentState: observation.assessmentState, verification: observation.verification } }));
 } finally { if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); await Promise.all(runners.map(r => r.dispose())); session?.dispose(); rmSync(scratch, { recursive: true, force: true }); }
}
