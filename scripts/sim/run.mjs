#!/usr/bin/env node
// The chat-powers end-to-end simulation (al_2 a13, t16, t19 q8): a made-up org, Mamluk Arabia, whose
// founder Alperen (played by claude-code claude-haiku-5-5) answers a gathering chat about the club's
// archery website, on a hermetic Sova server. Then the checks:
//
//   G  the gathering ends (Alperen confirmed the repeat-back);
//   C1 master's spec (claims/ + manifest.json) is byte-identical after the chat, on disk and in git;
//   C2 the conversation's own draft holds Alperen's requirements; C2b it is locked in (confirmed);
//   C3 spec_lookup returned no quotes, names, § ids, code paths or labels; code_read no names or
//      quotes; the replies leaked none; C3b a candidate record carries its "Proposed" marker;
//   C4a GET /api/draft-specs lists his draft with his requirements; C4b the project overseer, asked
//      "what are the draft specs?", answers with them;
//   C5 a coding session started from the draft (…/draft-specs/:sid/build) gets it in its first prompt
//      and can say what it asks for;
//   S2 the Project Assistant: a bug report and a feature ask; "start a fix" (codingStart, assistant
//      column) Off reaches Needs you as an owner request; On starts a coding session after the hold.
//
// Contracts: .chat-powers-brief/ARCH.md, through scripts/sim/contracts.mjs. A step whose piece hasn't
// landed reports PENDING, never a pass; a check that can't tell pass from fail says INCONCLUSIVE.
//
//   node scripts/sim/run.mjs [--port 4836] [--share-port 4837] [--turns 20]
//        [--gather-model zai/glm-5.3] [--cheap-model zai/glm-5.3] [--keep] [--only gather|s2]
//
// Run it as ONE foreground command: a sandboxed shell kills what it started when it returns.
// Never the live server: it refuses port 4800 and the real agent dir. It writes under
// <worktree>/.cache/sim/ (the agent dir, each run's transcripts and report.json) and a scratch root in
// the temp dir (the org workspace and the project, each its own git repository). Rerunnable: every
// run starts from a fresh agent dir and scratch root. --keep leaves the server running.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { alperen as makeAlperen, chatLog } from "./lib/alperen.mjs";
import { api as makeApi, share as makeShare, sleep, tokenOf } from "./lib/api.mjs";
import { addedSpecText, hits, longQuotes, readJsonl, requirementGroups, sameHashes, specHashes, specHashesAt, toolExchanges } from "./lib/checks.mjs";
import { buildAgentDir, cleanEnv, ROOT, startServer } from "./lib/hermetic.mjs";
import * as contracts from "./contracts.mjs";

const { values: opt } = parseArgs({
  options: {
    port: { type: "string", default: "4836" },
    "share-port": { type: "string", default: "4837" },
    turns: { type: "string", default: "20" },
    "gather-model": { type: "string", default: "zai/glm-5.3" },
    "cheap-model": { type: "string", default: "zai/glm-5.3" },
    keep: { type: "boolean", default: false },
    only: { type: "string" },
  },
});
const CHEAP = opt["cheap-model"];

const FIX = join(ROOT, "scripts/sim/fixtures/mamluk-arabia");
const fixture = JSON.parse(readFileSync(join(FIX, "org.json"), "utf8"));
const requirements = JSON.parse(readFileSync(join(FIX, "requirements.json"), "utf8"));
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const SIM = join(ROOT, ".cache/sim");
const out = join(SIM, "runs", runId);
mkdirSync(out, { recursive: true });
const agentDir = join(SIM, "agent");
const scratch = mkdtempSync(join(tmpdir(), "sova-sim-"));
const results = [];
const log = (...a) => console.log(`[sim ${new Date().toISOString().slice(11, 19)}]`, ...a);
const record = (id, status, detail = {}) => {
  results.push({ id, status, ...detail });
  log(`${status.padEnd(12)} ${id}${detail.why ? ` — ${detail.why}` : ""}`);
};
const save = (name, data) => writeFileSync(join(out, name), typeof data === "string" ? data : JSON.stringify(data, null, 2));
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=sim", "-c", "user.email=sim@example.invalid", ...args], { encoding: "utf8" }).trim();
const groupsWhy = (g) => `names ${g.required.found.join(", ") || "none"}${g.required.missing.length ? `; MISSING ${g.required.missing.join(", ")}` : ""}${g.optional.found.length ? `; also ${g.optional.found.join(", ")}` : ""}`;

// ---- the fixture: project root (git, master, seed spec) -----------------------------------------
const projectRoot = join(scratch, "mamluk-arabia-website");
const workspaceDir = join(scratch, "mamluk-arabia-workspace");
cpSync(join(FIX, "project/site"), join(projectRoot, "site"), { recursive: true });
cpSync(join(FIX, "project/seed-spec"), join(projectRoot, ".sova/spec"), { recursive: true });
git(scratch, "init", "-q", "-b", "master", projectRoot);
git(projectRoot, "add", "-A");
git(projectRoot, "commit", "-q", "-m", "Mamluk Arabia website: static site and seed spec");
const masterRev = git(projectRoot, "rev-parse", "HEAD");
const hashesBefore = specHashes(projectRoot);
const masterSpecCopy = join(out, "master-spec");
cpSync(join(projectRoot, ".sova/spec"), masterSpecCopy, { recursive: true });

// ---- the hermetic server ------------------------------------------------------------------------
const { token } = buildAgentDir({ agentDir, fresh: true });
const port = Number(opt.port), sharePort = Number(opt["share-port"]);
log(`agent dir ${agentDir}; scratch ${scratch}; out ${out}`);
const server = await startServer({ agentDir, port, sharePort, log: join(out, "server.log") });
log(`server up on ${port} (share ${sharePort}), head ${server.health.head ?? "?"}`);
const api = makeApi({ port, token });
const sh = makeShare({ sharePort });
const ctx = { api, share: sh, port, token, agentDir, projectRoot, workspaceDir, out, opt, fixture };
const throwaway = [];

async function sessionIdle(id, { timeoutMs = 600_000 } = {}) {
  const t = Date.now();
  let quiet = 0;
  while (Date.now() - t < timeoutMs) {
    const s = await api.get(`/api/sessions/by-id/${id}`).catch(() => null);
    quiet = s && !s.busy ? quiet + 1 : 0;
    if (quiet >= 3) return s;
    await sleep(1000);
  }
  throw new Error(`session ${id} still busy after ${timeoutMs / 1000} s`);
}

/** Every assistant text in a session file after its `from`-th entry, joined. */
function assistantText(path, from = 0) {
  return readJsonl(path).slice(from).filter((e) => e.type === "message" && e.message.role === "assistant")
    .map((m) => (m.message.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n")).join("\n").trim();
}

/** One operator message into an existing session, from its composer (WS /ws/chat); the answer after it. */
async function ask(path, id, text) {
  const from = existsSync(path) ? readJsonl(path).length : 0;
  const errors = await contracts.wsChat(ctx, path, { type: "prompt", text });
  if (errors.length) throw new Error(`prompt refused on ${path}: ${errors.join("; ")}`);
  await sleep(2000);
  await sessionIdle(id);
  return assistantText(path, from);
}

try {
  // ---- org, roster, owner, project --------------------------------------------------------------
  await api.put("/api/orgs/operator", { name: fixture.operator });
  const org = await api.post("/api/orgs", { name: fixture.org.name, dir: workspaceDir });
  const orgId = org.id;
  const people = {};
  for (const p of fixture.people) {
    const page = await api.post(`/api/orgs/${orgId}/people`, { name: p.name, role: p.role, decides: p.decides, language: "en" });
    people[p.key] = page.roster.find((r) => r.name === p.name).id;
  }
  await api.put(`/api/orgs/${orgId}/owner`, { personId: people[fixture.owner] });
  const withProject = await api.post(`/api/orgs/${orgId}/projects`, { name: fixture.project.name, root: projectRoot });
  const project = withProject.projectList.find((x) => x.name === fixture.project.name);
  Object.assign(ctx, { orgId, people, projectId: project.id });
  // The project overseer and the coding sessions it starts run on the cheap model; holds last 1 minute.
  await api.post(`/api/projects/${project.id}/overseer`, {});
  await api.patch(`/api/projects/${project.id}/overseer`, { model: CHEAP, codingModel: CHEAP, holdMin: 1 }).catch((e) => log(`overseer settings: ${e.message}`));
  save("org.json", { orgId, people, projectId: project.id, projectRoot, workspaceDir, masterRev });
  log(`org ${orgId}, project ${project.id}, Alperen ${people.alperen}`);

  if (opt.only !== "s2") {
    // ---- the gathering: Alperen through his link, the way his phone does it ---------------------
    const g = fixture.gathering;
    const started = await api.post("/api/baton", { orgId, projectId: project.id, to: people.alperen, publicTitle: g.publicTitle, goal: g.goal, question: g.question, model: opt["gather-model"] });
    const linkToken = tokenOf(started.link);
    ctx.gathering = { sessionId: started.sessionId, path: started.path, token: linkToken };
    log(`gathering ${started.sessionId} on ${opt["gather-model"]}; link …${linkToken.slice(-6)}`);
    const alp = makeAlperen({ personaFile: join(FIX, "alperen.md") });
    const turns = [];
    let view = (await sh.view(linkToken)).body;
    for (let turn = 0; turn < Number(opt.turns); turn++) {
      if (view.state === "done" || view.state === "closed" || view.viewer?.canWrite === false) break;
      const text = await alp.reply(view);
      turns.push({ turn, alperen: text });
      log(`Alperen: ${text.slice(0, 160)}`);
      const before = view.items.length;
      const sent = await sh.send(linkToken, text);
      if (sent.status !== 202) {
        turns.push({ turn, refused: sent });
        log(`share refused ${sent.status}: ${JSON.stringify(sent.body)}`);
        break;
      }
      await sleep(2000);
      await sessionIdle(started.sessionId);
      view = (await sh.view(linkToken)).body;
      for (const r of view.items.slice(before).filter((i) => i.kind === "reply" || i.kind === "done")) log(`Chat: ${(r.text ?? r.summary).slice(0, 160)}`);
      save("gathering-chat.txt", chatLog(view));
    }
    save("gathering-share-view.json", view);
    save("gathering-chat.txt", chatLog(view));
    save("gathering-turns.json", turns);
    if (existsSync(started.path)) copyFileSync(started.path, join(out, "gathering-session.jsonl"));
    record("G gathering ended after his yes", view.state === "done" ? "PASS" : "FAIL", { why: `state ${view.state}${view.holder && view.holder !== "Alperen" ? ` (held by ${view.holder}${view.viewer?.reason ? `, ${view.viewer.reason}` : ""})` : ""} after ${turns.length} message(s) from Alperen`, transcript: join(out, "gathering-chat.txt") });

    // ---- C1: master's spec untouched --------------------------------------------------------------
    const disk = sameHashes(hashesBefore, specHashes(projectRoot));
    const headNow = git(projectRoot, "rev-parse", "master");
    const inGit = sameHashes(specHashesAt(projectRoot, masterRev) ?? {}, specHashesAt(projectRoot, "master") ?? {});
    record("C1 master spec byte-identical", disk.ok && inGit.ok ? "PASS" : "FAIL", { why: disk.ok && inGit.ok ? `${Object.keys(hashesBefore).length} files identical; master ${headNow === masterRev ? "unmoved" : `moved to ${headNow} (spec files unchanged)`}` : `changed: ${[...disk.diff, ...inGit.diff].join(", ")}` });

    // ---- C2: his draft holds his requirements -----------------------------------------------------
    const draft = await contracts.conversationDraft(ctx);
    if (draft.pending) {
      record("C2 draft holds his requirements", "PENDING", { why: draft.pending });
      record("C2b draft locked in", "PENDING", { why: draft.pending });
    } else {
      ctx.draft = draft;
      const added = draft.dir ? addedSpecText(draft.dir, masterSpecCopy) : "";
      if (draft.dir) cpSync(draft.dir, join(out, "draft-spec"), { recursive: true });
      if (draft.record) save("draft-record.json", draft.record);
      save("draft-added.txt", added);
      const live = (draft.record?.items ?? []).filter((i) => i.status !== "dropped");
      const itemsText = live.map((i) => `${i.title}\n${i.text}`).join("\n");
      const gDir = requirementGroups(added, requirements);
      const gItems = requirementGroups(itemsText, requirements);
      record("C2 draft holds his requirements", draft.dir && gDir.required.missing.length === 0 ? "PASS" : "FAIL", { why: `draft ${draft.name ?? "?"}: dir ${draft.dir ? groupsWhy(gDir) : "MISSING"}; record ${live.length} item(s), ${groupsWhy(gItems)}`, draft: draft.dir });
      record("C2b draft locked in", draft.state === "confirmed" ? "PASS" : "FAIL", { why: `state ${draft.state ?? "unknown"}${draft.record?.confirmedAt ? ` at ${draft.record.confirmedAt}` : ""}` });
    }

    // ---- C2c: lock-in order: a repeat-back, then a message of his, then the confirm ------------------
    const entries = existsSync(started.path) ? readJsonl(started.path) : [];
    const seq = entries.flatMap((e) => {
      const m = e.type === "message" ? e.message : null;
      if (m?.role === "user") return ["person"];
      if (m?.role === "assistant") return (m.content ?? []).filter((c) => c.type === "toolCall" && /^requirements_(summary|confirm)$/.test(c.name)).map((c) => c.name);
      return [];
    });
    const confirmAt = seq.lastIndexOf("requirements_confirm");
    if (confirmAt < 0) record("C2c lock-in after his own yes", seq.includes("requirements_summary") ? "FAIL" : "PENDING", { why: seq.includes("requirements_summary") ? "a repeat-back but no requirements_confirm" : "neither requirements_summary nor requirements_confirm was called (not landed in the gathering loadout?)" });
    else {
      const lastSummary = seq.lastIndexOf("requirements_summary", confirmAt);
      const personBetween = lastSummary >= 0 && seq.slice(lastSummary + 1, confirmAt).includes("person");
      record("C2c lock-in after his own yes", personBetween ? "PASS" : "FAIL", { why: personBetween ? "repeat-back → his message → confirm" : `confirm without ${lastSummary < 0 ? "a repeat-back" : "a message of his after the repeat-back"}` });
    }

    // ---- C3: the outsider look-up and the replies leak nothing -----------------------------------
    const ex = toolExchanges(entries);
    save("gathering-tools.json", ex);
    const s = fixture.sentinels;
    const specRes = ex.filter((e) => e.name === "spec_lookup" && !e.isError);
    const codeRes = ex.filter((e) => e.name === "code_read" && !e.isError);
    const leaks = [
      ...specRes.flatMap((e) => hits(e.result, s.specLookup).map((h) => ({ tool: e.name, args: e.args, ...h }))),
      ...codeRes.flatMap((e) => hits(e.result, s.codeRead).map((h) => ({ tool: e.name, args: e.args, ...h }))),
    ];
    const unwrapped = specRes.filter((e) => !/<<untrusted project spec/.test(e.result) && !/no written description/i.test(e.result));
    const replyText = view.items.filter((i) => ["reply", "done", "decision", "handoff"].includes(i.kind)).map((i) => i.text ?? i.summary ?? i.statement ?? i.question).join("\n");
    const replyLeaks = hits(replyText, s.replies);
    const replyWarn = hits(replyText, s.repliesWarn);
    save("c3-scan.json", { specLookups: specRes.length, codeReads: codeRes.length, leaks, unwrapped: unwrapped.length, replyLeaks, replyWarn, tools: ex.map((e) => e.name) });
    if (leaks.length || replyLeaks.length || unwrapped.length) record("C3 outsider look-up cleaned", "FAIL", { why: `${leaks.length} look-up leak(s), ${unwrapped.length} unwrapped result(s), ${replyLeaks.length} reply leak(s): c3-scan.json` });
    else if (!specRes.length) record("C3 outsider look-up cleaned", "INCONCLUSIVE", { why: `spec_lookup never ran (tools used: ${[...new Set(ex.map((e) => e.name))].join(", ") || "none"}): a clean scan proves nothing` });
    else record("C3 outsider look-up cleaned", "PASS", { why: `${specRes.length} spec_lookup and ${codeRes.length} code_read result(s), no sentinel, all wrapped; replies clean${replyWarn.length ? ` (names, allowed: ${[...new Set(replyWarn.map((w) => w.pattern))].join(", ")})` : ""}` });
    // ---- C3d/C3b: deterministic, every passage of master and of his draft through the outsider read ----
    const probeDir = join(scratch, "probe");
    const copies = [{ label: "master", spec: masterSpecCopy }, ...(ctx.draft?.dir ? [{ label: "draft", spec: ctx.draft.dir }] : [])].map((c) => {
      const toolRoot = join(probeDir, c.label);
      cpSync(c.spec, join(toolRoot, ".sova/spec"), { recursive: true });
      return { label: c.label, toolRoot };
    });
    const names = [...fixture.people.map((p) => p.name), fixture.operator];
    writeFileSync(join(probeDir, "in.json"), JSON.stringify({ names, copies }));
    const probe = spawnSync("bun", [join(ROOT, "scripts/sim/lib/lookup-probe.ts"), join(probeDir, "in.json")], { cwd: ROOT, encoding: "utf8", timeout: 300_000, maxBuffer: 16 << 20, env: { ...cleanEnv(), PI_CODING_AGENT_DIR: join(probeDir, "agent") } });
    let probed = [];
    try { probed = JSON.parse(probe.stdout); } catch { record("C3d outsider read of every passage", "ERROR", { why: `probe failed: ${(probe.stderr || probe.stdout).slice(0, 500)}` }); }
    if (probed.length) {
      save("c3d-probe.json", probed);
      const nameParts = [...new Set(names.flatMap((n) => [n, ...n.split(/\s+/)]).filter((w) => w.length > 2))].map((w) => `\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      const pats = [...s.specLookup, ...nameParts];
      const bad = probed.flatMap((r) => (r.result ? [...hits(r.result, pats).map((h) => ({ label: r.label, id: r.id, ...h })), ...longQuotes(r.result).map((q) => ({ label: r.label, id: r.id, pattern: "a quote of 4+ words", at: q }))] : [{ label: r.label, id: r.id, pattern: "refused", at: r.refused }]));
      const unwrappedP = probed.filter((r) => r.result && !r.result.startsWith("<<untrusted project spec"));
      record("C3d outsider read of every passage", bad.length || unwrappedP.length ? "FAIL" : "PASS", { why: `${probed.length} passage(s) (${copies.map((c) => c.label).join(" + ")}): ${bad.length ? `${bad.length} hit(s): ${bad.slice(0, 3).map((b) => `${b.id} /${b.pattern}/ …${b.at}…`).join(" | ")}` : "no name, quote, § id, path or label"}${unwrappedP.length ? `; ${unwrappedP.length} unwrapped` : ""}` });
      const cm = s.candidateMarker;
      const cands = probed.filter((r) => r.candidate && r.result);
      const marked = cands.filter((r) => r.result.includes(cm.marker));
      const falseMarks = probed.filter((r) => !r.candidate && r.result?.includes(cm.marker));
      record("C3b candidate record marked", cands.length && marked.length === cands.length && !falseMarks.length ? "PASS" : "FAIL", { why: `${marked.length}/${cands.length} candidate passage(s) marked; ${falseMarks.length} settled passage(s) wrongly marked` });
    }

    // ---- C4: "what are the draft specs?" ------------------------------------------------------------
    const ds = await contracts.draftSpecs(ctx);
    if (ds.pending) record("C4a GET /api/draft-specs", "PENDING", { why: ds.pending });
    else {
      save("c4a-draft-specs.json", ds);
      const mine = (ds.drafts ?? []).find((d) => d.sessionId === started.sessionId);
      const text = mine ? [...mine.newItems, ...mine.changes].map((i) => `${i.title}\n${i.text}`).join("\n") : "";
      const g4 = requirementGroups(text, requirements);
      record("C4a GET /api/draft-specs", mine && g4.required.missing.length === 0 ? "PASS" : "FAIL", { why: mine ? `${mine.person ?? "?"}, ${mine.state}, ${mine.newItems.length} new + ${mine.changes.length} change(s), ${mine.clashes} clash(es); ${groupsWhy(g4)}` : `no summary for ${started.sessionId} among ${(ds.drafts ?? []).length}` });
    }
    const po = await api.get(`/api/projects/${project.id}/overseer`);
    if (!po.path) record("C4b project overseer answers", "FAIL", { why: "the project has no overseer conversation" });
    else {
      const answer = await ask(po.path, po.id, "What are the draft specs?");
      save("c4b-answer.md", answer);
      copyFileSync(po.path, join(out, "c4b-project-overseer.jsonl"));
      const used = toolExchanges(readJsonl(po.path)).some((e) => e.name === "sova_draft_specs");
      const g4b = requirementGroups(answer, requirements);
      record("C4b project overseer answers", used && g4b.required.missing.length === 0 ? "PASS" : "FAIL", { why: `${used ? "used" : "did NOT use"} sova_draft_specs; ${groupsWhy(g4b)}`, answer: join(out, "c4b-answer.md") });
    }

    // ---- C5: a coding session started from the draft sees it ---------------------------------------
    const coding = ctx.draft ? await contracts.startCodingFromDraft(ctx) : { pending: "no draft (C2)" };
    if (coding.pending) record("C5 coding session from the draft", "PENDING", { why: coding.pending });
    else if (coding.error) record("C5 coding session from the draft", "FAIL", { why: coding.error });
    else {
      throwaway.push(coding.path);
      await sleep(5000);
      const first = existsSync(coding.path) ? contracts.firstUserText(coding.path) : "";
      save("c5-first-prompt.md", first);
      const gFirst = requirementGroups(first, requirements);
      const named = ctx.draft.name && first.includes(ctx.draft.name);
      // Let its first turn run (it was told to implement); stop it, then ask what the draft asks for.
      await sessionIdle(coding.id, { timeoutMs: 900_000 }).catch(async () => (await contracts.abortSession(ctx, coding.path), await sessionIdle(coding.id)));
      const answer = await ask(coding.path, coding.id, "Stop building for a moment. In a short list: what does the draft you started from ask for? Change no files.");
      save("c5-answer.md", answer);
      copyFileSync(coding.path, join(out, "c5-coding-session.jsonl"));
      const gAns = requirementGroups(answer, requirements);
      const titles = (ctx.draft.record?.items ?? []).filter((i) => !["dropped", "built", "promoted"].includes(i.status)).map((i) => i.title);
      const titled = titles.filter((t) => first.includes(t));
      const ok = named && titles.length > 0 && titled.length === titles.length && gFirst.required.missing.length === 0 && gAns.required.missing.length === 0;
      record("C5 coding session from the draft", ok ? "PASS" : "FAIL", { why: `first prompt ${named ? "names" : "does NOT name"} ${ctx.draft.name}, holds ${titled.length}/${titles.length} item title(s), ${groupsWhy(gFirst)}; its answer ${groupsWhy(gAns)}` });
    }
  }

  if (opt.only !== "gather") {
    // ---- S2: the Project Assistant, "start a fix" Off then On --------------------------------------
    const models = await contracts.setAssistantModels(ctx, CHEAP);
    log(`assistant models: ${models.pending ?? (models.via === "file" ? "written to project-assistant.json (route not wired)" : "set")}`);
    await api.patch(`/api/projects/${ctx.projectId}/overseer`, { assistantModels: { coding: { model: CHEAP }, gathering: { model: CHEAP } } }).catch((e) => log(`assistantModels: ${e.message}`));
    for (const on of [false, true]) {
      const name = `S2 start-a-fix ${on ? "On" : "Off"}`;
      const set = await contracts.setAssistantPower(ctx, "codingStart", on, on ? { resume: true } : {});
      if (set.pending || set.error) { record(name, set.pending ? "PENDING" : "FAIL", { why: set.pending ?? set.error }); continue; }
      const since = Date.now();
      const codingBefore = (await contracts.projectCodingSessions(ctx)).map((c) => c.sessionId);
      const text = on
        ? "The contact form doesn't send anything, people tell me they never hear back. Please start a fix for it."
        : "The timetable on the home page still shows last week's classes, not this week's. Please fix it. And I'd like a Gallery page for our training photos.";
      const said = await contracts.ownerSays(ctx, text);
      if (said.pending || said.error) { record(name, said.pending ? "PENDING" : "FAIL", { why: said.pending ?? said.error }); continue; }
      save(`s2-${on ? "on" : "off"}-assistant.json`, said.view);
      const reply = said.reply;
      // What the assistant did, from its own session file (operator side).
      const pa = await api.get(`/api/orgs/${ctx.orgId}/owner/assistant`).catch(() => null);
      let tools = [];
      if (pa?.sessionId) {
        const s2 = await api.get(`/api/sessions/by-id/${pa.sessionId}`).catch(() => null);
        if (s2?.path && existsSync(s2.path)) {
          copyFileSync(s2.path, join(out, "s2-assistant-session.jsonl"));
          tools = toolExchanges(readJsonl(s2.path)).map((e) => e.name);
        }
      }
      const leak = hits(reply, fixture.sentinels.replies);
      if (on) {
        // Held first (Needs you, Cancel only), then a coding session once the 1-minute hold ends.
        const held = await contracts.attentionOf(ctx, ["held-act"], since);
        let started = null;
        for (let i = 0; i < 60 && !started; i++) {
          await sleep(5000);
          started = (await contracts.projectCodingSessions(ctx)).find((c) => !codingBefore.includes(c.sessionId)) ?? null;
        }
        for (let i = 0; started && !started.branch && i < 6; i++) {
          await sleep(5000);
          started = (await contracts.projectCodingSessions(ctx)).find((c) => c.sessionId === started.sessionId) ?? started;
        }
        if (started?.path) throwaway.push(started.path);
        await sleep(5000);
        const home = await contracts.ownerHome(ctx).catch(() => null);
        const reqs = home?.requests ?? [];
        const fixStarted = reqs.some((r) => r.kind === "fix" && r.status === "started");
        record(name, tools.includes("start_fix") && held.length && started && /^sova\//.test(started.branch ?? "") && fixStarted ? "PASS" : "FAIL", { why: `start_fix ${tools.includes("start_fix") ? "called" : "NOT called"}; held ${held.length ? "yes" : "NO"}; coding session ${started ? `${started.sessionId} on ${started.branch ?? "the root"} after ${Math.round((Date.now() - since) / 1000)} s` : "NOT started in 5 min"}; owner page requests ${reqs.map((r) => `${r.kind}:${r.status}`).join(", ") || "none"}${fixStarted ? "" : " (NO fix request reads started)"}${leak.length ? `; REPLY LEAK ${leak.map((l) => l.pattern)}` : ""}` });
      } else {
        await sleep(10_000);
        const asks = await contracts.attentionOf(ctx, ["owner-request"], since);
        const startedAny = (await contracts.projectCodingSessions(ctx)).some((c) => !codingBefore.includes(c.sessionId));
        const home = await contracts.ownerHome(ctx).catch(() => null);
        const reqs = (home?.requests ?? []).map((r) => `${r.kind}:${r.status}`);
        record(name, asks.length && !startedAny && !leak.length ? "PASS" : "FAIL", { why: `owner request in Needs you: ${asks.length ? asks.map((a) => a.detail ?? a.title).join(" | ").slice(0, 200) : "NONE"}; coding session started: ${startedAny ? "YES" : "no"}; tools ${[...new Set(tools)].join(", ") || "none"}; owner page requests ${reqs.join(", ") || "none"}${leak.length ? `; REPLY LEAK ${leak.map((l) => l.pattern)}` : ""}` });
      }
    }
  }
} catch (err) {
  record("run", "ERROR", { why: err instanceof Error ? err.stack ?? err.message : String(err) });
} finally {
  for (const path of throwaway) {
    await contracts.abortSession(ctx, path).catch(() => {});
    await api.post("/api/sessions/archive", { path, archived: true }).catch((e) => log(`archive ${path}: ${e.message}`));
  }
  const failed = results.filter((r) => r.status === "FAIL" || r.status === "ERROR").length;
  const report = { runId, out, scratch, agentDir, port, sharePort, head: server.health.head, gatherModel: opt["gather-model"], cheapModel: CHEAP, alperenModel: "claude-code/claude-haiku-5-5", results, failed };
  save("report.json", report);
  if (!opt.keep) {
    await server.stop();
    spawnSync("bun", [join(ROOT, "scripts/stop-chats.ts"), "--agent-dir", agentDir], { cwd: ROOT, stdio: "ignore", timeout: 60_000 });
  } else log(`--keep: server still on ${port} (pid ${server.child.pid})`);
  console.log(`\n${results.map((r) => `${r.status.padEnd(12)} ${r.id}${r.why ? ` — ${r.why.split("\n")[0]}` : ""}`).join("\n")}\n\nreport: ${join(out, "report.json")}`);
  process.exit(failed ? 1 : 0);
}
