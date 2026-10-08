// The story's checks: a small JSON Schema validator for exactly the keywords story.schema.json
// uses, then the cross-checks a schema can't express (references, turn structure, the demo repo
// replayed in memory, show_changes coverage, the align tool's own rules, privacy). Every problem is
// { pointer, message, hint? }; load-story.mjs turns pointers into story.json:LINE:COL.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { hostname, homedir, userInfo } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pointerOf } from "./json-pos.mjs";

/** Every keyword the validator understands. A schema keyword outside this set fails the test that
    pins the two together (story-check.test.mjs), so the schema can't silently outgrow the check. */
export const KNOWN_KEYWORDS = new Set([
  "$schema", "$id", "$ref", "$defs", "title", "description",
  "type", "properties", "required", "additionalProperties", "propertyNames", "minProperties",
  "items", "minItems", "enum", "const", "pattern", "minLength", "minimum", "oneOf",
]);

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const isType = (v, t) => (t === "number" ? typeof v === "number" : t === "integer" ? Number.isInteger(v) : typeOf(v) === t || (t === "number" && typeOf(v) === "integer"));

function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** The closest of `options` to `word`, if it is close enough to be a likely typo. */
export function didYouMean(word, options) {
  let best = null;
  let score = Infinity;
  for (const o of options) {
    const s = lev(word.toLowerCase(), o.toLowerCase());
    if (s < score) [best, score] = [o, s];
  }
  return best !== null && score <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}

export function makeValidator(rootSchema) {
  const resolveRef = (ref) => {
    if (!ref.startsWith("#/")) throw new Error(`only local $refs are supported: ${ref}`);
    return ref.slice(2).split("/").reduce((s, k) => s[k], rootSchema);
  };
  const deref = (s) => {
    while (s && s.$ref) s = resolveRef(s.$ref);
    return s;
  };
  const describe = (s) => (s.description ? ` (${s.description})` : "");

  function validate(schema, value, path, errors) {
    const s = deref(schema);
    if (!s) return;
    if (s.oneOf) return oneOf(s, value, path, errors);
    if (s.const !== undefined && value !== s.const) errors.push({ pointer: pointerOf(path), message: `must be ${JSON.stringify(s.const)}` });
    if (s.enum && !s.enum.includes(value))
      errors.push({ pointer: pointerOf(path), message: `${JSON.stringify(value)} is not allowed; use one of: ${s.enum.map((e) => JSON.stringify(e)).join(", ")}` });
    if (s.type && !isType(value, s.type)) {
      errors.push({ pointer: pointerOf(path), message: `must be ${s.type === "array" ? "an array" : s.type === "object" ? "an object" : `a ${s.type}`}, not ${typeOf(value) === "array" ? "an array" : typeOf(value) === "object" ? "an object" : typeOf(value)}` });
      return;
    }
    if (typeof value === "string") {
      if (s.minLength !== undefined && value.length < s.minLength) errors.push({ pointer: pointerOf(path), message: value.length === 0 ? "must not be empty" : `must be at least ${s.minLength} characters` });
      if (s.pattern && !new RegExp(s.pattern, "u").test(value)) errors.push({ pointer: pointerOf(path), message: `${JSON.stringify(value)} doesn't fit${describe(s) || ` /${s.pattern}/`}` });
    }
    if (typeof value === "number" && s.minimum !== undefined && value < s.minimum) errors.push({ pointer: pointerOf(path), message: `must be at least ${s.minimum}` });
    if (Array.isArray(value)) {
      if (s.minItems !== undefined && value.length < s.minItems) errors.push({ pointer: pointerOf(path), message: `needs at least ${s.minItems} item${s.minItems === 1 ? "" : "s"}` });
      if (s.items) value.forEach((v, i) => validate(s.items, v, [...path, i], errors));
    }
    if (typeOf(value) === "object") {
      const props = s.properties ?? {};
      for (const key of s.required ?? []) if (!(key in value)) errors.push({ pointer: pointerOf(path), message: `missing "${key}"${describe(deref(props[key]) ?? {})}` });
      const keys = Object.keys(value);
      if (s.minProperties !== undefined && keys.length < s.minProperties) errors.push({ pointer: pointerOf(path), message: `needs at least ${s.minProperties} entr${s.minProperties === 1 ? "y" : "ies"}` });
      for (const key of keys) {
        if (s.propertyNames) {
          const sub = [];
          validate(s.propertyNames, key, [...path, key], sub);
          for (const e of sub) errors.push({ ...e, key: true, message: `key ${e.message}` });
        }
        if (key in props) validate(props[key], value[key], [...path, key], errors);
        else if (s.additionalProperties === false) {
          const guess = didYouMean(key, Object.keys(props));
          errors.push({ pointer: pointerOf([...path, key]), key: true, message: `unknown key${guess ? `; did you mean "${guess}"?` : `; allowed here: ${Object.keys(props).join(", ")}`}` });
        } else if (typeof s.additionalProperties === "object") validate(s.additionalProperties, value[key], [...path, key], errors);
      }
    }
  }

  function oneOf(s, value, path, errors) {
    const branches = s.oneOf.map(deref);
    // Action-keyed objects (a story step): pick the branch by the one action key it has.
    const actionKeyed = branches.every((b) => b.type === "object" && b.required?.length === 1);
    if (actionKeyed && typeOf(value) === "object") {
      const actions = branches.map((b) => b.required[0]);
      const present = actions.filter((a) => a in value);
      if (present.length === 0) {
        const unknown = Object.keys(value).filter((k) => k !== "note");
        const guess = unknown.length ? didYouMean(unknown[0], actions) : null;
        errors.push({
          pointer: pointerOf(unknown.length ? [...path, unknown[0]] : path),
          key: unknown.length > 0,
          message: unknown.length ? `"${unknown[0]}" is not an action${guess ? `; did you mean "${guess}"?` : ""}` : "has no action",
          hint: `a step takes exactly one of: ${actions.join(", ")}`,
        });
        return;
      }
      if (present.length > 1) {
        errors.push({ pointer: pointerOf([...path, present[1]]), key: true, message: `a step takes exactly one action, but this one has ${present.map((p) => `"${p}"`).join(" and ")}`, hint: "split it into two steps" });
        return;
      }
      return validate(branches[actions.indexOf(present[0])], value, path, errors);
    }
    const tries = branches.map((b) => {
      const sub = [];
      validate(b, value, path, sub);
      return { b, sub };
    });
    const passing = tries.filter((t) => t.sub.length === 0);
    if (passing.length >= 1) return;
    // Report the branch of the value's own type, else the one with the fewest complaints.
    const sameType = tries.filter((t) => !t.b.type || isType(value, t.b.type));
    if (sameType.length === 1 || (sameType.length > 1 && typeOf(value) === "object")) {
      const best = sameType.sort((a, b) => a.sub.length - b.sub.length)[0];
      errors.push(...best.sub);
      return;
    }
    errors.push({ pointer: pointerOf(path), message: `doesn't fit${s.description ? `: ${s.description}` : ` any of: ${branches.map((b) => b.type ?? "?").join(", ")}`}` });
  }

  return (value) => {
    const errors = [];
    validate(rootSchema, value, [], errors);
    return errors;
  };
}

/** Every keyword a schema (and its subschemas) uses. */
export function schemaKeywords(schema, out = new Set()) {
  if (Array.isArray(schema)) {
    schema.forEach((s) => schemaKeywords(s, out));
    return out;
  }
  if (!schema || typeof schema !== "object") return out;
  for (const [k, v] of Object.entries(schema)) {
    out.add(k);
    if (k === "properties" || k === "$defs") Object.values(v).forEach((s) => schemaKeywords(s, out));
    else if (k === "items" || k === "additionalProperties" || k === "propertyNames") schemaKeywords(v, out);
    else if (k === "oneOf") v.forEach((s) => schemaKeywords(s, out));
  }
  return out;
}

// ---- helpers shared with load-story --------------------------------------------------------------

export const text = (t) => (Array.isArray(t) ? t.join("\n") : t);
export const STEP_ACTIONS = ["user", "say", "read", "edit", "write", "bash", "align", "decide", "worktree", "spawn", "wait", "show_changes", "tool", "error", "hold"];
export const actionOf = (step) => STEP_ACTIONS.find((a) => a in step);
/** Steps a static (written-to-disk) session may hold. */
export const STATIC_ACTIONS = new Set(["user", "say", "read", "bash", "align", "decide", "error"]);
const MODEL_ACTIONS = new Set(["say", "read", "edit", "write", "bash", "align", "decide", "worktree", "spawn", "wait", "show_changes", "tool"]);

export function durationMs(d) {
  const m = /^([0-9]+)(ms|s)$/.exec(d);
  return m ? Number(m[1]) * (m[2] === "s" ? 1000 : 1) : 0;
}
export function offsetMs(o) {
  if (o === "now") return 0;
  const m = /^-([0-9]+)([smhd])$/.exec(o);
  return m ? Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]] : 0;
}

/** A file body: Text, or { file } read from story/files (the caller has checked the path). */
export function fileBody(body, storyDir) {
  if (body && typeof body === "object" && !Array.isArray(body)) return readFileSync(join(storyDir, body.file), "utf8");
  const t = text(body);
  return t.endsWith("\n") ? t : `${t}\n`;
}

// ---- cross-checks --------------------------------------------------------------------------------

/**
 * The checks beyond shape. `story` has passed the schema. Returns { errors, warnings, facts }, facts
 * being what the summary and the compiler reuse (spawn owners, holds per session, repo states).
 */
export async function crossCheck(story, { storyDir, repoRoot, banned = runtimeBanned() }) {
  const errors = [];
  const warnings = [];
  const err = (path, message, hint) => errors.push({ pointer: pointerOf(path), message, ...(hint ? { hint } : {}) });
  const warn = (path, message) => warnings.push({ pointer: pointerOf(path), message });

  const models = new Set(Object.keys(story.models));
  const workers = story.workers ?? {};
  const sessions = story.sessions;
  const byId = new Map();

  // ids and models
  sessions.forEach((s, i) => {
    if (byId.has(s.id)) err(["sessions", i, "id"], `duplicate session id "${s.id}" (also sessions/${byId.get(s.id).i})`);
    else byId.set(s.id, { s, i });
    if (["overseer", "access", "end", "start"].includes(s.id)) err(["sessions", i, "id"], `"${s.id}" is reserved`);
    if (!models.has(s.model)) err(["sessions", i, "model"], `unknown model "${s.model}"`, `models are: ${[...models].join(", ")}`);
    const has = ["messages", "script"].filter((k) => k in s);
    if (has.length !== 1) err(["sessions", i], has.length ? "has both messages and script; a session is static or live, not both" : "needs messages (a static session) or script (a live one)");
    if (s.modes && !s.script) err(["sessions", i, "modes"], "modes apply to a live session (one with a script)");
    if (s.title.length > 38) warn(["sessions", i, "title"], `title is ${s.title.length} characters; the sidebar shows about 38 before it cuts`);
  });
  for (const [id, w] of Object.entries(workers)) if (!models.has(w.model)) err(["workers", id, "model"], `unknown model "${w.model}"`, `models are: ${[...models].join(", ")}`);
  if (story.overseer && !models.has(story.overseer.model)) err(["overseer", "model"], `unknown model "${story.overseer.model}"`);

  // file bodies
  const fileRef = (body, path) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) return true;
    const abs = resolve(storyDir, body.file);
    const base = resolve(storyDir, "story", "files");
    if (!abs.startsWith(base + sep)) {
      err([...path, "file"], "must stay inside story/files/");
      return false;
    }
    if (!existsSync(abs)) {
      err([...path, "file"], `no such file: ${body.file}`);
      return false;
    }
    if (realpathSync(abs) !== abs) {
      err([...path, "file"], "must be a regular file, not a link");
      return false;
    }
    return true;
  };

  // The demo repo, replayed in memory: committed state, then each scene's edits.
  const committed = new Map();
  story.project.commits.forEach((c, ci) => {
    for (const [p, body] of Object.entries(c.files)) if (fileRef(body, ["project", "commits", ci, "files", p])) committed.set(p, fileBody(body, storyDir));
  });

  // Turn structure and per-script rules.
  const scripts = []; // { path, steps, kind: "static"|"live"|"worker"|"overseer", owner }
  sessions.forEach((s, i) => {
    if (s.messages) scripts.push({ path: ["sessions", i, "messages"], steps: s.messages, kind: "static", owner: s.id });
    if (s.script) scripts.push({ path: ["sessions", i, "script"], steps: s.script, kind: "live", owner: s.id });
  });
  for (const [id, w] of Object.entries(workers)) scripts.push({ path: ["workers", id, "script"], steps: w.script, kind: "worker", owner: id });
  if (story.overseer) scripts.push({ path: ["overseer", "script"], steps: story.overseer.script, kind: "overseer", owner: "overseer" });

  const firstUser = new Map(); // first user text -> where
  const holdsOf = new Map(); // owner -> Set(hold)
  for (const sc of scripts) {
    const holds = new Set();
    holdsOf.set(sc.owner, holds);
    let prev = null; // last non-hold action
    sc.steps.forEach((step, k) => {
      const a = actionOf(step);
      const at = [...sc.path, k];
      if (sc.kind === "static" && !STATIC_ACTIONS.has(a)) err([...at, a], `a static session can't hold a ${a} step`, `static sessions take: ${[...STATIC_ACTIONS].join(", ")}`);
      if (sc.kind !== "static" && a === "error") err([...at, a], "error steps are for static sessions only");
      if (sc.kind === "worker" && ["user", "spawn", "wait"].includes(a)) err([...at, a], `a worker's script can't hold a ${a} step`, a === "user" ? "its task is its first message" : "workers can't start workers");
      if (sc.kind === "overseer" && ["spawn", "wait", "worktree", "edit", "write", "bash", "read", "show_changes", "align", "decide"].includes(a)) err([...at, a], `the Overseer has no ${a} tool`, "use a tool step with one of its sova_* tools");
      if (k === 0 && sc.kind !== "worker" && a !== "user") err(at, "must start with a user step");
      if (a === "user" && k > 0 && prev && prev !== "say" && prev !== "error") err(at, "the reply before this user step ends in a tool call", "a turn ends with a say step");
      if (a === "user" && k === 0) {
        const key = norm(text(step.user));
        if (firstUser.has(key)) err([...at, "user"], `same first message as ${firstUser.get(key)}`, "the director tells live sessions apart by their first message");
        firstUser.set(key, pointerOf(at));
      }
      if (a === "hold") {
        if (holds.has(step.hold)) err([...at, "hold"], `hold "${step.hold}" appears twice in this script`);
        if (["end", "start"].includes(step.hold)) err([...at, "hold"], `"${step.hold}" is reserved`);
        holds.add(step.hold);
        const next = sc.steps.slice(k + 1).find((x) => actionOf(x) !== "hold");
        if (sc.kind === "static") err([...at, "hold"], "holds belong in live scripts");
        else if (next && actionOf(next) === "hold") err([...at, "hold"], "two holds in a row");
        void next;
      }
      if (a === "edit" && text(step.edit.old) === text(step.edit.new)) err([...at, "edit"], "old and new are the same");
      if (a === "write") fileRef(step.write.content, [...at, "write", "content"]);
      if (a !== "hold") prev = a;
    });
    const last = [...sc.steps].reverse().find((x) => actionOf(x) !== "hold");
    if (last && !["say", "error"].includes(actionOf(last)) && sc.kind !== "static") err([...sc.path, sc.steps.length - 1], "the script ends in a tool call", "end it with a say step");
    if (sc.kind === "worker") {
      const key = norm(text(workers[sc.owner].task));
      if (firstUser.has(key)) err(["workers", sc.owner, "task"], `same text as ${firstUser.get(key)}`, "the director tells workers apart by their task");
      firstUser.set(key, pointerOf(["workers", sc.owner, "task"]));
    }
  }
  // A task that contains another scene's key would match both.
  const keys = [...firstUser.keys()];
  for (const a of keys) for (const b of keys) if (a !== b && a.includes(b)) err([], `${firstUser.get(a)} contains ${firstUser.get(b)} word for word`, "make every first message and task distinct");

  // Spawns: who spawns which worker, and worker worktrees.
  const spawnedBy = new Map(); // worker -> session id
  const worktreesOf = new Map(); // session -> Set(created worktree names, in order seen)
  for (const sc of scripts.filter((x) => x.kind === "live")) {
    const trees = new Set();
    worktreesOf.set(sc.owner, trees);
    sc.steps.forEach((step, k) => {
      const at = [...sc.path, k];
      const a = actionOf(step);
      if (a === "worktree" && step.worktree.create) {
        if (trees.has(step.worktree.create)) err([...at, "worktree", "create"], `worktree "${step.worktree.create}" is created twice`);
        trees.add(step.worktree.create);
      }
      if (a === "worktree" && step.worktree.merge && !trees.has(step.worktree.merge)) err([...at, "worktree", "merge"], `no worktree "${step.worktree.merge}" was created before this step`);
      if (a === "spawn")
        [step.spawn].flat().forEach((w, j) => {
          const p = Array.isArray(step.spawn) ? [...at, "spawn", j] : [...at, "spawn"];
          if (!workers[w]) return err(p, `unknown worker "${w}"`, `workers are: ${Object.keys(workers).join(", ") || "(none)"}`);
          if (spawnedBy.has(w)) return err(p, `worker "${w}" is already spawned by ${spawnedBy.get(w)}`);
          spawnedBy.set(w, sc.owner);
          if (workers[w].in && !trees.has(workers[w].in)) err(["workers", w, "in"], `worktree "${workers[w].in}" isn't created in ${sc.owner}'s script before worker "${w}" is spawned`);
        });
      if (a === "wait")
        step.wait.forEach((w, j) => {
          if (!workers[w]) err([...at, "wait", j], `unknown worker "${w}"`);
          else if (spawnedBy.get(w) !== sc.owner) err([...at, "wait", j], `worker "${w}" isn't spawned before this step`);
        });
      if (a === "show_changes" && step.show_changes.worktree && !trees.has(step.show_changes.worktree)) err([...at, "show_changes", "worktree"], `no worktree "${step.show_changes.worktree}" was created before this step`);
    });
  }
  for (const id of Object.keys(workers)) if (!spawnedBy.has(id)) warn(["workers", id], "no session spawns this worker");

  // Repo replay per live session, workers replayed where they're spawned, in their own worktree.
  const alignMod = await loadAlign(repoRoot);
  if (!alignMod) warnings.push({ pointer: "", message: "pi-config/extensions/mode/align.ts not found: align steps checked by shape only" });
  for (const sc of scripts) {
    if (sc.kind === "worker") continue;
    const trees = new Map([["", { base: committed, work: new Map(committed) }]]);
    const alignDocs = { docs: [] };
    const run = (steps, path, where) => {
      steps.forEach((step, k) => {
        const at = [...path, k];
        const a = actionOf(step);
        const tree = trees.get(where);
        if (a === "read" && !tree.work.has(step.read)) err([...at, "read"], `${step.read} doesn't exist at this point`, `files: ${[...tree.work.keys()].join(", ")}`);
        if (a === "edit") {
          const { path: p } = step.edit;
          const old = text(step.edit.old);
          const cur = tree.work.get(p);
          if (cur === undefined) err([...at, "edit", "path"], `${p} doesn't exist at this point`);
          else {
            const n = cur.split(old).length - 1;
            if (n === 0) err([...at, "edit", "old"], `not found in ${p}${where ? ` (worktree ${where})` : ""}`, closest(cur, old));
            else if (n > 1) err([...at, "edit", "old"], `found ${n} times in ${p}; the edit tool needs it to be unique`, "include more surrounding lines");
            else tree.work.set(p, cur.replace(old, () => text(step.edit.new)));
          }
        }
        if (a === "write") tree.work.set(step.write.path, fileBody(step.write.content, storyDir));
        if (a === "worktree" && step.worktree.create) trees.set(step.worktree.create, { base: new Map(committed), work: new Map(committed) });
        if (a === "spawn")
          for (const w of [step.spawn].flat()) if (workers[w] && spawnedBy.get(w) === sc.owner) run(workers[w].script, ["workers", w, "script"], workers[w].in ?? "");
        if (a === "show_changes") {
          const sct = step.show_changes;
          const t = trees.get(sct.worktree ?? "");
          if (!t) return;
          const changed = [...new Set([...t.work.keys(), ...t.base.keys()])].filter((f) => t.work.get(f) !== t.base.get(f)).sort();
          const owner = new Map();
          sct.steps.forEach((st, si) => {
            st.files.forEach((f, fi) => {
              if (!changed.includes(f)) err([...at, "show_changes", "steps", si, "files", fi], `${f} has no change at this point`, `changed: ${changed.join(", ") || "(nothing)"}`);
              else if (owner.has(f)) err([...at, "show_changes", "steps", si, "files", fi], `${f} is already in step ${owner.get(f) + 1}; each change sits in exactly one step`);
              else owner.set(f, si);
            });
            (st.buildsOn ?? []).forEach((b, bi) => {
              if (b > si) err([...at, "show_changes", "steps", si, "buildsOn", bi], `${b} is not an earlier step (this is step ${si + 1})`);
            });
            for (const [k2, v] of Object.entries({ title: st.title, why: st.why })) if (v && v.length > 2000) err([...at, "show_changes", "steps", si, k2], "longer than show_changes' 2000 characters");
          });
          for (const f of changed) if (!owner.has(f)) err([...at, "show_changes", "steps"], `${f} is changed but in no step`, "the show_changes tool refuses a call that leaves a change out");
        }
        if (alignMod && a === "align") {
          try {
            const out = alignMod.applyAlignCall(alignDocs.docs, { ops: [{ op: "create", ...step.align }] }, { now: "2026-01-01T00:00:00.000Z", readFile: () => "" });
            if (out.details.doc) alignDocs.docs = [...alignDocs.docs, out.details.doc];
          } catch (e) {
            err([...at, "align"], `the align tool would refuse it: ${e.message}`);
          }
        }
        if (alignMod && a === "decide") {
          const doc = alignDocs.docs.at(-1);
          if (!doc) err([...at, "decide"], "no alignment was created before this step");
          else
            try {
              const ops = Object.entries(step.decide.answers).map(([q, decision]) => ({ op: "decide", q, decision }));
              if (step.decide.status) ops.push({ op: "status", to: step.decide.status });
              const out = alignMod.applyAlignCall(alignDocs.docs, { doc: doc.id, ops }, { now: "2026-01-01T00:00:00.000Z", readFile: () => "" });
              alignDocs.docs = alignDocs.docs.map((d) => (d.id === out.details.doc?.id ? out.details.doc : d));
            } catch (e) {
              err([...at, "decide"], `the align tool would refuse it: ${e.message}`);
            }
        }
      });
    };
    run(sc.steps, sc.path, "");
  }

  // Shots, slots, video.
  const liveIds = new Set(sessions.filter((s) => s.script).map((s) => s.id));
  const holdsFor = (sid) => {
    const out = new Set(holdsOf.get(sid) ?? []);
    for (const [w, owner] of spawnedBy) if (owner === sid) for (const h of holdsOf.get(w) ?? []) out.add(h);
    return out;
  };
  const shotIds = new Set();
  story.shots.forEach((shot, i) => {
    const at = ["shots", i];
    if (shotIds.has(shot.id)) err([...at, "id"], `duplicate shot id "${shot.id}"`);
    shotIds.add(shot.id);
    const page = shot.session === "overseer" || shot.session === "access";
    if (shot.session === "overseer" && !story.overseer) err([...at, "session"], "the story has no overseer");
    if (!page && !byId.has(shot.session)) return err([...at, "session"], `unknown session "${shot.session}"`, `sessions are: ${[...byId.keys()].join(", ")}`);
    const live = shot.session === "overseer" ? true : liveIds.has(shot.session);
    if (shot.at === "start") {
      if (live && shot.session !== "overseer") err([...at, "at"], `"start" is for a static session or a page; ${shot.session} is live`, `its holds: ${[...holdsFor(shot.session)].join(", ") || "(none)"}, or "end"`);
    } else if (!live) err([...at, "at"], `${shot.session} is static, so the only point is "start"`);
    else if (shot.at !== "end" && !holdsFor(shot.session === "overseer" ? "overseer" : shot.session).has(shot.at))
      err([...at, "at"], `no hold "${shot.at}" in ${shot.session}'s script or its workers'`, `holds: ${[...holdsFor(shot.session)].join(", ") || "(none)"}, or "end"`);
    if (shot.view === "workers" && !shot.worker) err([...at], 'view "workers" needs a worker to select');
    if (shot.worker && spawnedBy.get(shot.worker) !== shot.session) err([...at, "worker"], `worker "${shot.worker}" isn't one of ${shot.session}'s`);
    if (shot.worker && shot.view !== "workers") err([...at, "worker"], 'worker goes with view "workers"');
    const vp = story.viewports[shot.viewport];
    if (!vp) err([...at, "viewport"], `unknown viewport "${shot.viewport}"`, `${didYouMean(shot.viewport, Object.keys(story.viewports)) ? `did you mean "${didYouMean(shot.viewport, Object.keys(story.viewports))}"? ` : ""}viewports are: ${Object.keys(story.viewports).join(", ")}`);
    else if (shot.view === "workers" && vp.width < 768) warn([...at, "view"], "under 768px Sova shows the workers pane as its own screen, not beside the chat");
  });
  for (const [slot, id] of Object.entries(story.pageShots)) if (!shotIds.has(id)) err(["pageShots", slot], `unknown shot "${id}"`, didYouMean(id, [...shotIds]) ? `did you mean "${didYouMean(id, [...shotIds])}"?` : undefined);

  if (story.video) {
    const v = story.video;
    if (!liveIds.has(v.session)) err(["video", "session"], `"${v.session}" isn't a live session`);
    if (!story.viewports[v.viewport]) err(["video", "viewport"], `unknown viewport "${v.viewport}"`, `viewports are: ${Object.keys(story.viewports).join(", ")}`);
    const holds = holdsFor(v.session);
    const script = byId.get(v.session)?.s.script ?? [];
    let ms = 0;
    v.beats.forEach((b, i) => {
      const at = ["video", "beats", i];
      const need = { type: [], send: [], release: ["until"], click: ["target"], pause: ["for"] }[b.do];
      for (const k of need) if (b[k] === undefined) err(at, `do "${b.do}" needs "${k}"`);
      for (const k of ["step", "until", "target", "for", "worker"]) if (b[k] !== undefined && !({ type: ["step"], release: ["until"], click: ["target", "worker"], pause: ["for"] }[b.do] ?? []).includes(k)) err([...at, k], `"${k}" doesn't go with do "${b.do}"`);
      if (b.do === "type") {
        if (b.step === undefined) err(at, 'do "type" needs "step"');
        else if (!script[b.step] || actionOf(script[b.step]) !== "user") err([...at, "step"], `step ${b.step} of ${v.session}'s script is not a user step`);
        else ms += text(script[b.step].user).length * durationMs(v.typing);
      }
      if (b.do === "release" && b.until && b.until !== "end" && !holds.has(b.until)) err([...at, "until"], `no hold "${b.until}" in ${v.session}'s script or its workers'`, `holds: ${[...holds].join(", ")}, or "end"`);
      if (b.do === "click" && b.target === "worker" && !b.worker) err(at, 'click "worker" needs "worker"');
      if (b.do === "pause") ms += durationMs(b.for);
    });
    // Streaming: about 4 characters per chunk.
    const streamed = [script, ...[...spawnedBy].filter(([, o]) => o === v.session).map(([w]) => workers[w].script)].flat().filter((s) => "say" in s).reduce((n, s) => n + text(s.say).length, 0);
    ms += (streamed / 4) * durationMs(v.chunk);
    if (ms > 40_000) warn(["video"], `estimated length ${Math.round(ms / 1000)}s (typing, pauses and streaming) is over 40s`);
    if (v.poster && !shotIds.has(v.poster)) err(["video", "poster"], `unknown shot "${v.poster}"`);
    if (!v.poster && !story.pageShots["hero.desk"]) err(["video"], "needs a poster: a shot id, or a hero.desk slot");
  }

  // Privacy: every string in the story, and the bodies it points at.
  const each = (v, path) => {
    if (typeof v === "string") privacy(v, path, banned, err);
    else if (Array.isArray(v)) v.forEach((x, i) => each(x, [...path, i]));
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        privacy(k, [...path, k], banned, err);
        if (k === "file" && typeof x === "string" && existsSync(resolve(storyDir, x)) && resolve(storyDir, x).startsWith(resolve(storyDir, "story", "files") + sep))
          privacy(readFileSync(resolve(storyDir, x), "utf8"), [...path, k], banned, err);
        each(x, [...path, k]);
      }
  };
  each(story, []);

  return { errors, warnings, facts: { spawnedBy, holdsOf, worktreesOf, liveIds } };
}

const norm = (s) => s.replace(/\s+/g, " ").trim();

function closest(content, old) {
  const want = old.split("\n").find((l) => l.trim()) ?? old;
  let best = null;
  let score = Infinity;
  content.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    const s = lev(line.trim(), want.trim()) / Math.max(line.trim().length, want.trim().length);
    if (s < score) [best, score] = [{ line, i }, s];
  });
  return best && score < 0.6 ? `closest line ${best.i + 1}: ${JSON.stringify(best.line)}` : undefined;
}

async function loadAlign(repoRoot) {
  const p = join(repoRoot, "pi-config", "extensions", "mode", "align.ts");
  if (!existsSync(p)) return null;
  try {
    return await import(p);
  } catch {
    return null;
  }
}

/** This machine's own names, held in memory only: a story must never carry them. */
export function runtimeBanned() {
  const out = [];
  const add = (v, what) => v && v.length >= 4 && !["root", "user", "demo", "localhost"].includes(v.toLowerCase()) && out.push({ v, what });
  try { add(userInfo().username, "this machine's user name"); } catch {}
  add(hostname(), "this machine's host name");
  add(homedir(), "this machine's home directory");
  return out;
}

const PRIVACY = [
  [/(^|[\s"'`(=])\/(home|Users|root|mnt|media|srv|var\/home)\/[^\s"']+/, "an absolute path; use ~/ or a repo-relative path"],
  [/[A-Za-z0-9._%+-]+@(?!example\.(com|org|net)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "an email address outside example.com"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/, "an IP address"],
  [/\.ts\.net\b/i, "a tailnet (.ts.net) name"],
];
function privacy(s, path, banned, err) {
  for (const [re, what] of PRIVACY) {
    const m = re.exec(s);
    if (m && !(what === "an IP address" && /^(127\.0\.0\.1|0\.0\.0\.0)$/.test(m[0]))) err(path, `contains ${what}: ${JSON.stringify(m[0].trim())}`);
  }
  for (const b of banned) if (s.toLowerCase().includes(b.v.toLowerCase())) err(path, `contains ${b.what}`, "the story is public; keep this machine out of it");
}
