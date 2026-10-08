// Read story.json, check it, and compile it into the plan every other script works from: static
// session files to write, the director's scenes (each live script cut into model replies), shots,
// slots and the video's beats. Nothing here starts a process or writes a file.
//
//   const { plan, warnings } = await loadStory();          // throws StoryError on any problem
//   formatProblems(err.problems)                            // "story.json:12:5 /sessions/0/id: ..."

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { JsonPosError, parseWithPositions } from "./json-pos.mjs";
import { actionOf, crossCheck, durationMs, fileBody, makeValidator, offsetMs, text } from "./story-check.mjs";

export const HERE = import.meta.dirname;
export const SITE = resolve(HERE, "../..");
export const REPO = resolve(SITE, "..");
export const STORY = join(HERE, "story.json");
export const SCHEMA = join(HERE, "story.schema.json");

export class StoryError extends Error {
  constructor(problems, file) {
    super(formatProblems(problems, file));
    this.problems = problems;
  }
}

/** One line per problem: file:LINE:COL /pointer: message (hint). */
export function formatProblems(problems, file = STORY, pos = null, caret = null) {
  return problems
    .map((p) => {
      const at = p.line ? p : locate(pos, p.pointer, p.key);
      const where = at ? `${basename(file)}:${at.line}:${at.col}` : basename(file);
      const out = `${where} ${p.pointer || "/"}: ${p.message}${p.hint ? ` (${p.hint})` : ""}`;
      return caret && at ? `${out}\n${caretLine(caret, at)}` : out;
    })
    .join("\n");
}

function caretLine(source, at) {
  const line = source.split("\n")[at.line - 1] ?? "";
  return `    ${line}\n    ${" ".repeat(Math.max(0, at.col - 1))}^`;
}

/** The position of a pointer, or of its closest parent that has one. A key error points at the key. */
function locate(pos, pointer, key) {
  if (!pos) return null;
  let p = pointer;
  for (;;) {
    const hit = pos.get(p);
    if (hit) return key && hit.keyLine ? { line: hit.keyLine, col: hit.keyCol } : hit;
    if (!p) return null;
    p = p.slice(0, p.lastIndexOf("/"));
  }
}

/**
 * Parse, validate and cross-check a story. Returns { story, pos, problems, warnings }, problems empty
 * when it is good. `file` defaults to story.json; tests point it at broken copies.
 */
export async function checkStory(file = STORY, opts = {}) {
  const source = readFileSync(file, "utf8");
  const storyDir = opts.storyDir ?? dirname(file);
  let parsed;
  try {
    parsed = parseWithPositions(source);
  } catch (e) {
    if (!(e instanceof JsonPosError)) throw e;
    return { source, problems: [{ pointer: e.pointer, message: e.message, line: e.line, col: e.col, syntax: true }], warnings: [] };
  }
  const { value: story, pos } = parsed;
  const schema = JSON.parse(readFileSync(SCHEMA, "utf8"));
  const shape = makeValidator(schema)(story);
  if (shape.length) return { source, story, pos, problems: dedupe(shape), warnings: [] };
  const { errors, warnings, facts } = await crossCheck(story, { storyDir, repoRoot: REPO, ...(opts.banned ? { banned: opts.banned } : {}) });
  return { source, story, pos, problems: dedupe(errors), warnings, facts };
}

const dedupe = (ps) => [...new Map(ps.map((p) => [`${p.pointer}\0${p.message}`, p])).values()];

/** checkStory, then compile; throws StoryError (its message already formatted) on any problem. */
export async function loadStory(file = STORY, opts = {}) {
  const r = await checkStory(file, opts);
  if (r.problems.length) {
    const e = new Error(formatProblems(r.problems, file, r.pos, r.source));
    e.problems = r.problems;
    e.name = "StoryError";
    throw e;
  }
  return { plan: compile(r.story, r.facts, dirname(file), r.pos), warnings: r.warnings, story: r.story, pos: r.pos };
}

// ---- compile -------------------------------------------------------------------------------------

/** A stable UUID for a story id: the same story gives the same session ids on every run. */
export function storyUuid(kind, id) {
  const h = createHash("sha256").update(`sova-screens:${kind}:${id}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Strings in a tool step's args that name a story session: "$session:<id>". */
export const SESSION_REF = /^\$session:([a-z][a-z0-9-]*)$/;

/**
 * A script cut into the model's replies. Each reply: { text, calls: [{ name, args, pointer }],
 * hold?, pointer }. A user step is a turn boundary; consecutive says join into one reply; a say
 * right before a tool step opens that tool's reply. A hold before a reply gates it; a hold before a
 * user step or at the end marks the turn's end (`idleHolds` on the reply that ended it).
 */
export function cutReplies(steps, basePath, ctx) {
  const replies = [];
  const users = [];
  let say = [];
  let hold = null;
  let holdAt = null;
  const flushSay = (pointer) => {
    if (!say.length) return;
    replies.push({ text: say.join("\n\n"), calls: [], pointer, ...(hold ? { hold } : {}) });
    hold = null;
    say = [];
  };
  steps.forEach((step, k) => {
    const pointer = `${basePath}/${k}`;
    const a = actionOf(step);
    if (a === "user") {
      flushSay(pointer);
      if (hold) {
        (replies.at(-1) ?? {}).idleHolds = [...((replies.at(-1) ?? {}).idleHolds ?? []), hold];
        hold = null;
      }
      users.push({ text: text(step.user), index: k, afterReply: replies.length, pointer });
      return;
    }
    if (a === "say") {
      say.push(text(step.say));
      return;
    }
    if (a === "hold") {
      if (say.length) flushSay(pointer);
      hold = step.hold;
      holdAt = pointer;
      return;
    }
    const call = toolCall(step, a, ctx);
    replies.push({ text: say.join("\n\n"), calls: [{ ...call, pointer: `${pointer}/${a}` }], pointer, ...(hold ? { hold } : {}) });
    say = [];
    hold = null;
  });
  flushSay(`${basePath}/${steps.length - 1}`);
  if (hold && replies.length) replies.at(-1).idleHolds = [...(replies.at(-1).idleHolds ?? []), hold];
  void holdAt;
  return { replies, users };
}

/** The tool call a step makes, with every repo path made absolute at run time by the director. */
function toolCall(step, a, ctx) {
  switch (a) {
    case "read":
      return { name: "read", args: { path: step.read } };
    case "edit":
      return { name: "edit", args: { path: step.edit.path, edits: [{ oldText: text(step.edit.old), newText: text(step.edit.new) }] } };
    case "write":
      return { name: "write", args: { path: step.write.path, content: fileBody(step.write.content, ctx.storyDir) } };
    case "bash":
      return { name: "bash", args: { command: step.bash.command } };
    case "align":
      return { name: "align", args: { ops: [{ op: "create", ...step.align }] } };
    case "decide": {
      const ops = Object.entries(step.decide.answers).map(([q, decision]) => ({ op: "decide", q, decision }));
      if (step.decide.status) ops.push({ op: "status", to: step.decide.status });
      return { name: "align", args: { ops } };
    }
    case "worktree":
      return step.worktree.create
        ? { name: "worktree", args: { action: "create", name: step.worktree.create } }
        : { name: "worktree", args: { action: "merge", path: `feat/${step.worktree.merge}` } };
    case "spawn": {
      const specs = [step.spawn].flat().map((id) => ctx.workerSpec(id));
      return specs.length === 1 ? { name: "agent_spawn", args: specs[0], workers: [step.spawn].flat() } : { name: "agent_spawn", args: { agents: specs }, workers: [step.spawn].flat() };
    }
    case "wait":
      return { name: "agent_wait", args: { ids: step.wait.map((w) => `$worker:${w}`) } };
    case "show_changes": {
      const s = step.show_changes;
      return {
        name: "show_changes",
        args: {
          scope: s.scope,
          ...(s.worktree ? { worktree: `feat/${s.worktree}` } : {}),
          title: s.title,
          steps: s.steps.map((st) => ({ title: st.title, ...(st.why ? { why: st.why } : {}), ...(st.buildsOn?.length ? { buildsOn: st.buildsOn } : {}), hunks: st.files.map((f) => ({ path: f })) })),
        },
      };
    }
    case "tool":
      return { name: step.tool.name, args: step.tool.args };
    default:
      throw new Error(`no tool for ${a}`);
  }
}

function compile(story, facts, storyDir, pos) {
  const provider = story.provider;
  const ref = (m) => `${provider}/${story.models[m].id}`;
  const workers = story.workers ?? {};
  const workerSpec = (id) => {
    const w = workers[id];
    const m = story.models[w.model];
    return {
      prompt: text(w.task),
      name: w.name ?? id,
      model: ref(w.model),
      ...(m.effort ? { effort: m.effort } : {}),
      ...(w.in ? { cwd: `$worktree:${w.in}` } : {}),
      wake: false,
    };
  };
  const ctx = { storyDir, workerSpec };

  const files = new Map();
  for (const c of story.project.commits) for (const [p, body] of Object.entries(c.files)) files.set(p, fileBody(body, storyDir));

  const scenes = [];
  const sessions = story.sessions.map((s, i) => {
    const base = {
      id: s.id,
      uuid: storyUuid("session", s.id),
      title: s.title,
      offsetMs: offsetMs(s.at),
      model: ref(s.model),
      modelId: story.models[s.model].id,
      effort: story.models[s.model].effort ?? null,
      contextWindow: story.models[s.model].contextWindow ?? 200_000,
      modes: s.modes ?? [],
      pointer: `/sessions/${i}`,
    };
    if (s.messages) return { ...base, live: false, messages: s.messages.map((m, k) => ({ ...m, pointer: `/sessions/${i}/messages/${k}` })) };
    const cut = cutReplies(s.script, `/sessions/${i}/script`, ctx);
    scenes.push({ id: s.id, kind: "session", key: cut.users[0].text, model: ref(s.model), contextWindow: base.contextWindow, ...cut });
    return { ...base, live: true, users: cut.users };
  });
  for (const [id, w] of Object.entries(workers)) {
    const cut = cutReplies(w.script, `/workers/${id}/script`, ctx);
    scenes.push({ id, kind: "worker", key: text(w.task), model: ref(w.model), contextWindow: story.models[w.model].contextWindow ?? 200_000, owner: facts.spawnedBy.get(id), in: w.in ?? null, name: w.name ?? id, ...cut });
  }
  if (story.overseer) {
    const cut = cutReplies(story.overseer.script, "/overseer/script", ctx);
    scenes.push({ id: "overseer", kind: "overseer", key: cut.users[0].text, model: ref(story.overseer.model), contextWindow: story.models[story.overseer.model].contextWindow ?? 200_000, ...cut });
  }

  // Which scenes hold at each hold name (a hold shared by a session and its worker is reached when
  // every one of them is waiting there).
  const holds = {};
  for (const sc of scenes)
    for (const r of sc.replies) {
      if (r.hold) (holds[r.hold] ??= []).push({ scene: sc.id, kind: "gate" });
      for (const h of r.idleHolds ?? []) (holds[h] ??= []).push({ scene: sc.id, kind: "idle" });
    }

  const positions = Object.fromEntries([...pos].map(([p, v]) => [p, [v.line, v.col]]));
  return {
    provider,
    models: Object.fromEntries(Object.entries(story.models).map(([k, m]) => [k, { ...m, ref: ref(k) }])),
    project: { name: story.project.name, path: story.project.path, commits: story.project.commits.map((c) => ({ message: c.message, files: Object.fromEntries(Object.entries(c.files).map(([p, b]) => [p, fileBody(b, storyDir)])) })) },
    files,
    sessions,
    workers: Object.fromEntries(Object.entries(workers).map(([id, w]) => [id, { id, name: w.name ?? id, model: ref(w.model), in: w.in ?? null, owner: facts.spawnedBy.get(id) ?? null }])),
    overseer: story.overseer ? { model: ref(story.overseer.model), effort: story.models[story.overseer.model].effort ?? null } : null,
    scenes,
    holds,
    shots: story.shots,
    pageShots: story.pageShots,
    video: story.video ? { ...story.video, typingMs: durationMs(story.video.typing), chunkMs: durationMs(story.video.chunk), poster: story.video.poster ?? story.pageShots["hero.desk"] } : null,
    positions,
  };
}

/** story.json:LINE:COL for a pointer, from a compiled plan (the director maps tool refusals back). */
export function whereIn(plan, pointer) {
  let p = pointer;
  for (;;) {
    const hit = plan.positions[p];
    if (hit) return `story.json:${hit[0]}:${hit[1]}`;
    if (!p) return "story.json";
    p = p.slice(0, p.lastIndexOf("/"));
  }
}
