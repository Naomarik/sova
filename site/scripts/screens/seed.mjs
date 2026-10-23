#!/usr/bin/env node
// Write everything Sova reads, from the story, into a throwaway root:
//   <root>/home/<project.path>  the demo git repo (author Demo <demo@example.com>, fixed dates)
//   <root>/home/.pi/agent       a hermetic agent dir (scripts/hermetic-agent-dir.mjs), with
//                               models.json naming the director, Delegate's routes on it, and the
//                               static sessions as session files dated relative to now
// Nothing is read from or written to the real ~/.pi.
//
//   node seed.mjs [--root <dir>] [--director-port <n>]     # prints the root it seeded
//
// capture.mjs and record.mjs call seed() themselves; this CLI is for looking at a seeded root.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadStory, REPO, storyUuid } from "./load-story.mjs";
import { actionOf, text } from "./story-check.mjs";
import { agentDirOf, makeRoot, rootEnv, writeJson } from "./harness.mjs";

/** Commit dates are fixed, so the demo repo's shas are the same on every run. */
const GIT_EPOCH = Date.parse("2026-09-01T09:00:00Z");

/** The project's absolute path under the root's home. */
export const projectDir = (root, plan) => join(root, "home", plan.project.path.slice(2));

export async function seed(plan, root, { directorPort, now = Date.now() } = {}) {
  const home = join(root, "home");
  const agent = agentDirOf(root);
  const env = rootEnv(root);

  // Git identity for everything that commits in the run (the repo, worktree merges).
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Demo\n\temail = demo@example.com\n[init]\n\tdefaultBranch = master\n[advice]\n\tdetachedHead = false\n");

  // The demo repo.
  const repo = projectDir(root, plan);
  mkdirSync(repo, { recursive: true });
  const git = (args, extra = {}) => execFileSync("git", args, { cwd: repo, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] }).toString();
  git(["init", "-q", "-b", "master"]);
  plan.project.commits.forEach((c, i) => {
    for (const [p, body] of Object.entries(c.files)) {
      mkdirSync(dirname(join(repo, p)), { recursive: true });
      writeFileSync(join(repo, p), body);
    }
    const date = new Date(GIT_EPOCH + i * 3_600_000).toISOString();
    git(["add", "-A"]);
    git(["commit", "-q", "-m", c.message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  });

  // The hermetic agent dir, built by the repo's own script at <root>/home/.pi/agent. That script
  // refuses to touch $HOME/.pi, so it runs with HOME at a scratch dir of the root (it then reads no
  // real ~/.pi either).
  const scratchHome = join(root, "tmp", "hermetic-home");
  mkdirSync(scratchHome, { recursive: true });
  execFileSync(process.execPath, [join(REPO, "scripts", "hermetic-agent-dir.mjs")], { cwd: REPO, env: { ...env, HOME: scratchHome, HERMETIC_AGENT_DIR: agent }, stdio: ["ignore", "pipe", "pipe"] });

  // models.json: every provider the story names, each at the director (the linked catalogue is
  // replaced), so a real provider name shows on screen while nothing leaves the machine.
  const models = join(agent, "models.json");
  if (existsSync(models) || isLink(models)) rmSync(models);
  const providers = {};
  for (const name of plan.providers) {
    const byId = new Map();
    for (const m of Object.values(plan.models)) if (m.provider === name && !byId.has(m.id)) byId.set(m.id, m);
    providers[name] = {
      baseUrl: `http://127.0.0.1:${directorPort ?? 9}/v1`,
      api: "openai-completions",
      apiKey: "demo",
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
      models: [...byId.values()].map((m) => ({ id: m.id, name: m.name ?? m.id, reasoning: true, contextWindow: m.contextWindow ?? 200_000, maxTokens: 32_000 })),
    };
  }
  writeJson(models, { providers });

  // pi settings: new sessions start on the main model; nothing else changes.
  const settingsFile = join(agent, "settings.json");
  const settings = JSON.parse(execFileSync("cat", [settingsFile]).toString());
  const main = plan.sessions.find((s) => s.live) ?? plan.sessions[0];
  writeJson(settingsFile, { ...settings, defaultProvider: main.provider, defaultModel: main.modelId, ...(main.effort ? { defaultThinkingLevel: main.effort } : {}) });

  // The session summaries (topic-outline): only the story's summarizer model, at the director,
  // soon after a turn ends; no Claude Code fallback. The director answers with `summary` steps.
  writeJson(join(agent, "topic-outline.json"), plan.summarizer
    ? { summarizers: [{ backend: "pi", model: plan.summarizer, timeoutMs: 30_000 }], trigger: { debounceMs: 300, minNewMessages: 2 } }
    : { summarizers: [{ backend: "pi", model: `${plan.provider}/none`, timeoutMs: 1_000 }], trigger: { debounceMs: 3_000, minNewMessages: 1_000_000 } });

  // Delegate's routes: every profile on the pi backend, on the story's models.
  const route = (key) => {
    const m = plan.models[key];
    return { backend: "pi", model: m.ref, effort: m.effort ?? "medium" };
  };
  const slot = (...keys) => keys.find((k) => plan.models[k]) ?? Object.keys(plan.models)[0];
  writeJson(join(agent, "mode-delegate.json"), {
    version: 1,
    profiles: {
      planning: { primary: route(slot("main")), fallback: null },
      investigation: { primary: route(slot("scout", "glm")), fallback: null },
      routine: { primary: route(slot("routine", "glm")), fallback: null },
      complex: { primary: route(slot("main")), fallback: null },
    },
  });

  // The static sessions.
  const sessionsDir = join(agent, "sessions", `--${repo.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  mkdirSync(sessionsDir, { recursive: true });
  const written = {};
  for (const s of plan.sessions.filter((x) => !x.live)) {
    const end = now - s.offsetMs;
    const lines = staticSession(plan, s, repo, end);
    const start = new Date(lines[0].timestamp);
    const file = join(sessionsDir, `${start.toISOString().replace(/[:.]/g, "-")}_${s.uuid}.jsonl`);
    writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    utimesSync(file, new Date(end), new Date(end));
    written[s.id] = file;
  }
  return { root, home, agent, repo, sessionsDir, sessions: written };
}

/** The static sessions' titles, set where Sova keeps them (its own title store, as a rename
    does): the sidebar titles a session from that store, else from its first message. */
export async function titleStatic(server, plan, seeded) {
  for (const s of plan.sessions.filter((x) => !x.live)) await server.call("POST", "/api/sessions/title", { path: seeded.sessions[s.id], title: s.title });
}

const isLink = (p) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/** A finished session as pi writes it: header, model, name, then the messages with usage. */
export function staticSession(plan, s, repo, endMs) {
  const steps = s.messages;
  const span = 15_000 * steps.length;
  let t = endMs - span;
  const tick = () => (t += 15_000);
  const id = (n) => createHash("sha256").update(`${s.id}:${n}`).digest("hex").slice(0, 8);
  const [provider, model] = [s.provider, s.modelId];
  const lines = [];
  let parent = null;
  let n = 0;
  const push = (entry) => {
    const e = { ...entry, id: id(n++), parentId: parent, timestamp: new Date(t).toISOString() };
    parent = e.id;
    lines.push(e);
  };
  lines.push({ type: "session", version: 3, id: s.uuid, timestamp: new Date(t).toISOString(), cwd: repo });
  push({ type: "model_change", provider, modelId: model });
  if (s.effort) push({ type: "thinking_level_change", thinkingLevel: s.effort });
  push({ type: "session_info", name: s.title });
  // A session the director carries on was in its modes from the start: the mode extension's own
  // markers (a switch, then the minor mode), each with the active state it restores from.
  if (s.then && s.modes.length) {
    const major = s.modes.includes("delegate") ? "delegate" : "normal";
    const active = { version: 1, mode: major, strict: false, minorModes: s.modes.filter((m) => m !== "delegate") };
    if (major !== "normal") push({ type: "custom", customType: "mode", data: { mode: major, active } });
    for (const minor of active.minorModes) push({ type: "custom", customType: "mode", data: { minor, on: true, active } });
  }

  const files = new Map(plan.files);
  let context = 9_000;
  const usage = (out) => {
    context += 600 + out * 4;
    return { input: context, output: out, cacheRead: 0, cacheWrite: 0, totalTokens: context + out, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  };
  const assistant = (content, stopReason, extra = {}) => ({
    role: "assistant",
    content,
    api: "openai-completions",
    provider,
    model,
    usage: usage(content.reduce((k, c) => k + (c.text?.length ?? 40), 0) / 4),
    stopReason,
    timestamp: t,
    ...extra,
  });

  let docs = [];
  let say = [];
  let k = 0;
  // Written-in summaries: the topic-outline snapshots its summarizer would have appended.
  const anchorOf = new Map(); // user step index -> its anchor
  let lastAnchor = null; // the newest user or text-only assistant message, as an anchor
  let lastEntryId = null; // the newest message entry of any kind (a summary's basis)
  let topics = [];
  let counter = 0;
  const remember = (role, message) => {
    const anchor = { entryId: parent, role, timestamp: t, fingerprint: fingerprint(message) };
    lastAnchor = anchor;
    return anchor;
  };
  const pushMessage = (message) => {
    push({ type: "message", message });
    if (message.role === "assistant" && !message.content.some((c) => c.type === "toolCall")) remember("assistant", message);
    lastEntryId = parent;
  };
  for (const [si, step] of steps.entries()) {
    const a = actionOf(step);
    if (a === "summary") {
      const sum = step.summary;
      for (const tp of sum.topics) {
        const from = tp.from !== undefined ? anchorOf.get(tp.from) : null;
        const range = from ? { from, to: lastAnchor } : undefined;
        if (tp.update) topics = topics.map((x) => (x.id === tp.update ? { ...x, heading: tp.heading, summary: tp.summary, at: t, ...(from ? { anchor: from, range } : {}) } : x));
        else topics.push({ id: `t${++counter}`, heading: tp.heading, anchor: from, range, summary: tp.summary, at: t });
      }
      const latest = topics.reduce((p, x) => (!p || x.at >= p.at ? x : p), null);
      push({
        type: "custom",
        customType: "topic-outline",
        data: { version: 2, topics, now: sum.now, overall: sum.overall, topicCounter: counter, basisLeafId: lastEntryId, generatedAt: t, state: "fresh", lastHeading: latest?.heading ?? "", lastManualHeading: "", purpose: text(steps.find((x) => actionOf(x) === "user").user).slice(0, 400) },
      });
      continue;
    }
    tick();
    if (a === "user") {
      const message = { role: "user", content: [{ type: "text", text: text(step.user) }], timestamp: t };
      push({ type: "message", message });
      anchorOf.set(si, remember("user", message));
      lastEntryId = parent;
      continue;
    }
    if (a === "say") {
      say.push(text(step.say));
      const next = steps.slice(si + 1).find((x) => actionOf(x) !== "summary");
      if (!next || ["user", "say", "error"].includes(actionOf(next))) {
        if (next && actionOf(next) === "say") continue;
        pushMessage(assistant([{ type: "text", text: say.join("\n\n") }], "stop"));
        say = [];
      }
      continue;
    }
    if (a === "error") {
      pushMessage(assistant(say.length ? [{ type: "text", text: say.join("\n\n") }] : [], "error", { errorMessage: step.error }));
      say = [];
      continue;
    }
    const callId = `call_${s.id.replace(/-/g, "_")}_${k++}`;
    let name;
    let args;
    let result;
    let details;
    if (a === "read") {
      [name, args, result] = ["read", { path: step.read }, files.get(step.read) ?? ""];
    } else if (a === "bash") {
      [name, args, result] = ["bash", { command: step.bash.command }, text(step.bash.output ?? "") || "(no output)"];
    } else if (a === "align" || a === "decide") {
      const align = alignModule();
      const input =
        a === "align"
          ? { ops: [{ op: "create", ...step.align }] }
          : { doc: docs.at(-1).id, ops: [...Object.entries(step.decide.answers).map(([q, decision]) => ({ op: "decide", q, decision })), ...(step.decide.status ? [{ op: "status", to: step.decide.status }] : [])] };
      const out = align.applyAlignCall(docs, input, { now: new Date(t).toISOString(), readFile: () => "" });
      docs = [...docs.filter((d) => d.id !== out.details.doc?.id), ...(out.details.doc ? [out.details.doc] : [])];
      [name, args, result, details] = ["align", input, out.text, out.details];
    }
    pushMessage(assistant([...(say.length ? [{ type: "text", text: say.join("\n\n") }] : []), { type: "toolCall", id: callId, name, arguments: args }], "toolUse"));
    say = [];
    tick();
    lastEntryId = id(n);
    push({ type: "message", message: { role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text: result }], ...(details ? { details } : {}), isError: false, timestamp: t } });
  }
  return lines;
}

let alignMod = null;
let anchorsMod = null;
const alignModule = () => alignMod;
/** A message's fingerprint as the topic-outline extension stores it in a topic's anchor. */
const fingerprint = (message) => anchorsMod.fingerprintOf(message);
/** The align extension's own core (Node builtins only), so a static alignment is the real shape;
    and the topic-outline extension's anchors, so a written-in summary's anchors are too. */
export async function loadAlignModule() {
  alignMod ??= await import(join(REPO, "pi-config", "extensions", "mode", "align.ts"));
  anchorsMod ??= await import(join(REPO, "pi-config", "extensions", "topic-outline", "anchors.ts"));
  return alignMod;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const { plan } = await loadStory();
  await loadAlignModule();
  const root = opt("--root") ?? makeRoot();
  const out = await seed(plan, root, { directorPort: Number(opt("--director-port") ?? 9) });
  console.log(`seeded ${out.root}`);
  for (const [id, f] of Object.entries(out.sessions)) console.log(`  ${id}: ${f.slice(root.length + 1)}`);
  console.log(`remove it with: rm -rf ${root}`);
  void storyUuid;
}
