import { isDeepStrictEqual } from "node:util";
import type { MergeSettingsChange } from "../../shared/merge-queue-settings";
import { HOOK_TIMEOUT_MAX, parseDefinition } from "../../shared/project-contract";
import type { LandHow } from "../../shared/merge-queue";
import { isLandHow } from "./strategy";

/**
 * A merge-settings save as a text edit of `.sova/project.json` (§app.merge-queue/settings): only the values the
 * change names move; every other byte of the file stays as it was (its order, spacing, one-line checks). Pure.
 *
 * The edit is checked twice: the result must parse as a definition, and must equal the file's own JSON with the
 * change applied as data; otherwise it is refused (nothing is guessed).
 */

export class SettingsEditError extends Error {}

/** The merge section's keys a save may change. */
/** How it lands, in a commit message's words. */
const LAND_WORDS: Record<LandHow, string> = { local: "merging locally", "github-pr": "pull request on GitHub", "gitlab-mr": "merge request on GitLab", "push-branch": "pushing the branch only" };

const EDITABLE = new Set(["push", "review", "checks", "land", "reuse", "deleteBranches"]);

/** The kit folder `review: on` sets back. */
export const REVIEW_KIT_DIR = ".sova/playbooks/review";

// ---- a JSON reader that keeps where each value sits ---------------------------------------------

type Node =
  | { t: "obj"; start: number; end: number; members: Member[] }
  | { t: "arr"; start: number; end: number; items: Node[] }
  | { t: "val"; start: number; end: number };
interface Member {
  key: string;
  /** Where the key's opening quote is. */
  start: number;
  value: Node;
}

function parseSpans(text: string): Node {
  let i = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const fail = (why: string): never => {
    throw new SettingsEditError(`.sova/project.json can't be edited in place (${why} at ${i})`);
  };
  const str = (): string => {
    const s = i;
    if (text[i] !== '"') fail("expected a string");
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    if (i >= text.length) fail("an unclosed string");
    i++;
    return JSON.parse(text.slice(s, i)) as string;
  };
  const value = (): Node => {
    ws();
    const s = i;
    const c = text[i];
    if (c === "{") {
      i++;
      const members: Member[] = [];
      ws();
      if (text[i] === "}") return { t: "obj", start: s, end: ++i, members };
      for (;;) {
        ws();
        const ks = i;
        const key = str();
        ws();
        if (text[i] !== ":") fail("expected :");
        i++;
        members.push({ key, start: ks, value: value() });
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") return { t: "obj", start: s, end: ++i, members };
        fail("expected , or }");
      }
    }
    if (c === "[") {
      i++;
      const items: Node[] = [];
      ws();
      if (text[i] === "]") return { t: "arr", start: s, end: ++i, items };
      for (;;) {
        items.push(value());
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") return { t: "arr", start: s, end: ++i, items };
        fail("expected , or ]");
      }
    }
    if (c === '"') {
      str();
      return { t: "val", start: s, end: i };
    }
    const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 40));
    if (!m) fail("an unexpected character");
    i += m![0].length;
    return { t: "val", start: s, end: i };
  };
  const root = value();
  ws();
  if (i !== text.length) fail("text after the end");
  return root;
}

// ---- edits as splices ----------------------------------------------------------------------------

interface Splice {
  at: number;
  end: number;
  text: string;
}

const find = (o: Extract<Node, { t: "obj" }>, key: string): Member | undefined => o.members.find((m) => m.key === key);

/** Set `key` to `json` (a value's text) in `o`: its value replaced in place, or a member added after the last. */
function setMember(text: string, o: Extract<Node, { t: "obj" }>, key: string, json: string): Splice {
  const m = find(o, key);
  if (m) return { at: m.value.start, end: m.value.end, text: json };
  const entry = `${JSON.stringify(key)}: ${json}`;
  const last = o.members[o.members.length - 1];
  if (!last) return { at: o.start + 1, end: o.end - 1, text: entry };
  // Reuse the object's own separator between members (", " or ",\n<indent>"); with one member, follow how it opens.
  let sep: string;
  if (o.members.length >= 2) {
    const prev = o.members[o.members.length - 2]!;
    sep = text.slice(prev.value.end, last.start);
  } else {
    const lead = text.slice(o.start + 1, last.start);
    sep = lead.includes("\n") ? `,${lead.slice(lead.lastIndexOf("\n"))}` : ", ";
  }
  return { at: last.value.end, end: last.value.end, text: `${sep}${entry}` };
}

/** Remove `key` from `o` with its separator; nothing when it isn't there. */
function removeMember(text: string, o: Extract<Node, { t: "obj" }>, key: string): Splice | null {
  const idx = o.members.findIndex((m) => m.key === key);
  if (idx < 0) return null;
  const m = o.members[idx]!;
  const next = o.members[idx + 1];
  if (next) return { at: m.start, end: next.start, text: "" };
  const prev = o.members[idx - 1];
  if (prev) return { at: prev.value.end, end: m.value.end, text: "" };
  return { at: o.start + 1, end: o.end - 1, text: "" };
}

/** The change applied to the file's data (what the text edit must equal). Pure. */
export function applyToData(raw: Record<string, unknown>, c: MergeSettingsChange): Record<string, unknown> {
  const out = structuredClone(raw);
  const merge = ((out.merge as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
  if (c.push !== undefined) merge.push = c.push;
  if (c.review === false) delete merge.review;
  if (c.review === true && merge.review === undefined) merge.review = REVIEW_KIT_DIR;
  if (c.land === "local") delete merge.land;
  else if (c.land !== undefined) merge.land = c.land;
  if (c.reuse === true) delete merge.reuse;
  else if (c.reuse === false) merge.reuse = false;
  if (c.deleteBranches === false) delete merge.deleteBranches;
  else if (c.deleteBranches === true) merge.deleteBranches = true;
  if (c.checks) {
    const list = merge.checks as Record<string, unknown>[];
    for (const [id, ch] of Object.entries(c.checks)) {
      const x = list.find((y) => y.id === id)!;
      if (ch.timeoutSec !== undefined) x.timeout = ch.timeoutSec;
      if (ch.rerun === true) x.rerun = true;
      if (ch.rerun === false) delete x.rerun;
      if (ch.optional === true) x.optional = true;
      if (ch.optional === false) delete x.optional;
    }
  }
  out.merge = merge;
  return out;
}

/** What the change says, for the commit's message ("push off; review on; unit: 25 min"). Pure. */
export function changeWords(c: MergeSettingsChange): string {
  const parts: string[] = [];
  if (c.push !== undefined) parts.push(`push ${c.push ? "on" : "off"}`);
  if (c.review !== undefined) parts.push(`review ${c.review ? "on" : "off"}`);
  if (c.land !== undefined) parts.push(`lands by ${LAND_WORDS[c.land]}`);
  if (c.reuse !== undefined) parts.push(`reuse passes from identical code ${c.reuse ? "on" : "off"}`);
  if (c.deleteBranches !== undefined) parts.push(`delete branches ${c.deleteBranches ? "on" : "off"}`);
  for (const [id, ch] of Object.entries(c.checks ?? {})) {
    const w: string[] = [];
    if (ch.timeoutSec !== undefined) w.push(`${Math.round(ch.timeoutSec / 60)} min`);
    if (ch.rerun !== undefined) w.push(ch.rerun ? "reruns failed files" : "no rerun");
    if (ch.optional !== undefined) w.push(ch.optional ? "only when picked" : "always");
    if (w.length) parts.push(`${id}: ${w.join(", ")}`);
  }
  return parts.join("; ");
}

/** Whether the change asks for nothing. Pure. */
export const isEmptyChange = (c: MergeSettingsChange): boolean =>
  c.push === undefined && c.review === undefined && c.land === undefined && c.reuse === undefined && c.deleteBranches === undefined && !Object.values(c.checks ?? {}).some((x) => x.timeoutSec !== undefined || x.rerun !== undefined || x.optional !== undefined);

/** A change from a request body, checked. Pure. */
export function parseChange(v: unknown): MergeSettingsChange {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new SettingsEditError("changes is an object: {push?, review?, checks?}");
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!EDITABLE.has(k)) throw new SettingsEditError(`"${k}" can't be changed here (push, review, land, reuse, deleteBranches and each check's timeout, rerun and optional can)`);
  const out: MergeSettingsChange = {};
  if (o.push !== undefined) {
    if (typeof o.push !== "boolean") throw new SettingsEditError("push is true or false");
    out.push = o.push;
  }
  if (o.review !== undefined) {
    if (typeof o.review !== "boolean") throw new SettingsEditError("review is true or false");
    out.review = o.review;
  }
  if (o.reuse !== undefined) {
    if (typeof o.reuse !== "boolean") throw new SettingsEditError("reuse is true or false");
    out.reuse = o.reuse;
  }
  if (o.deleteBranches !== undefined) {
    if (typeof o.deleteBranches !== "boolean") throw new SettingsEditError("deleteBranches is true or false");
    out.deleteBranches = o.deleteBranches;
  }
  if (o.land !== undefined) {
    if (!isLandHow(o.land)) throw new SettingsEditError('land is "local", "github-pr", "gitlab-mr" or "push-branch"');
    out.land = o.land;
  }
  if (o.checks !== undefined) {
    if (!o.checks || typeof o.checks !== "object" || Array.isArray(o.checks)) throw new SettingsEditError("checks is an object by check id");
    out.checks = {};
    for (const [id, x] of Object.entries(o.checks as Record<string, unknown>)) {
      if (!x || typeof x !== "object" || Array.isArray(x)) throw new SettingsEditError(`checks.${id} is an object`);
      const c = x as Record<string, unknown>;
      for (const k of Object.keys(c)) if (!["timeoutSec", "rerun", "optional"].includes(k)) throw new SettingsEditError(`checks.${id}.${k} can't be changed here (timeoutSec, rerun and optional can)`);
      const e: NonNullable<MergeSettingsChange["checks"]>[string] = {};
      if (c.timeoutSec !== undefined) {
        if (typeof c.timeoutSec !== "number" || !Number.isInteger(c.timeoutSec) || c.timeoutSec < 1 || c.timeoutSec > HOOK_TIMEOUT_MAX)
          throw new SettingsEditError(`checks.${id}.timeoutSec is a whole number of seconds, 1–${HOOK_TIMEOUT_MAX}`);
        e.timeoutSec = c.timeoutSec;
      }
      for (const k of ["rerun", "optional"] as const) {
        if (c[k] === undefined) continue;
        if (typeof c[k] !== "boolean") throw new SettingsEditError(`checks.${id}.${k} is true or false`);
        e[k] = c[k] as boolean;
      }
      out.checks[id] = e;
    }
  }
  return out;
}

/**
 * The file's new text with `c` applied: each named value edited where it sits. Throws SettingsEditError when the
 * change can't apply (a check that isn't declared, review on without the kit, checks that come from test.run) or
 * the result isn't a valid definition.
 */
export function editSettingsText(text: string, c: MergeSettingsChange, opts: { kitExists?: boolean } = {}): string {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new SettingsEditError(".sova/project.json isn't JSON");
  }
  const root = parseSpans(text);
  if (root.t !== "obj") throw new SettingsEditError(".sova/project.json isn't an object");
  const rawMerge = raw.merge as Record<string, unknown> | undefined;
  const ids = Object.keys(c.checks ?? {});
  if (ids.length) {
    if (!Array.isArray(rawMerge?.checks)) throw new SettingsEditError("this project's checks aren't declared in its merge section, so they can't be changed here");
    for (const id of ids) if (!(rawMerge.checks as { id?: unknown }[]).some((x) => x?.id === id)) throw new SettingsEditError(`no check "${id}" in the merge section`);
  }
  if (c.review === true && rawMerge?.review === undefined && !opts.kitExists) throw new SettingsEditError(`there is no review kit at ${REVIEW_KIT_DIR} on the target: add one in a branch first`);

  // Each edit is made on the text the previous one left, its places read afresh: no two ever overlap.
  const splice = (t: string, sp: Splice | null) => (sp ? t.slice(0, sp.at) + sp.text + t.slice(sp.end) : t);
  const obj = (t: string, path: (string | { check: string })[]): Extract<Node, { t: "obj" }> => {
    let n: Node = parseSpans(t);
    for (const p of path) {
      if (typeof p === "string") {
        if (n.t !== "obj") throw new SettingsEditError(`${p}'s parent isn't an object`);
        const m = find(n, p);
        if (!m) throw new SettingsEditError(`no ${p}`);
        n = m.value;
      } else {
        if (n.t !== "arr") throw new SettingsEditError("merge.checks isn't a list");
        const hit: Node | undefined = n.items.find((x) => x.t === "obj" && (() => {
          const id = find(x, "id");
          return !!id && JSON.parse(t.slice(id.value.start, id.value.end)) === p.check;
        })());
        if (!hit) throw new SettingsEditError(`no check "${p.check}" in the merge section`);
        n = hit;
      }
    }
    if (n.t !== "obj") throw new SettingsEditError("not an object");
    return n;
  };
  let out = text;
  const hasMerge = !!find(root, "merge");
  if (!hasMerge) {
    // No merge section yet: one is added holding only what the change sets.
    const m: string[] = [];
    if (c.push !== undefined) m.push(`"push": ${c.push}`);
    if (c.review === true) m.push(`"review": ${JSON.stringify(REVIEW_KIT_DIR)}`);
    if (c.land !== undefined && c.land !== "local") m.push(`"land": ${JSON.stringify(c.land)}`);
    if (c.reuse === false) m.push(`"reuse": false`);
    if (c.deleteBranches === true) m.push(`"deleteBranches": true`);
    if (m.length) out = splice(out, setMember(out, obj(out, []), "merge", `{${m.join(", ")}}`));
  } else {
    if (find(root, "merge")!.value.t !== "obj") throw new SettingsEditError("the merge section isn't an object");
    if (c.push !== undefined) out = splice(out, setMember(out, obj(out, ["merge"]), "push", String(c.push)));
    if (c.review === false) out = splice(out, removeMember(out, obj(out, ["merge"]), "review"));
    if (c.review === true && !find(obj(out, ["merge"]), "review")) out = splice(out, setMember(out, obj(out, ["merge"]), "review", JSON.stringify(REVIEW_KIT_DIR)));
    if (c.land === "local") out = splice(out, removeMember(out, obj(out, ["merge"]), "land"));
    else if (c.land !== undefined) out = splice(out, setMember(out, obj(out, ["merge"]), "land", JSON.stringify(c.land)));
    if (c.reuse === true) out = splice(out, removeMember(out, obj(out, ["merge"]), "reuse"));
    else if (c.reuse === false) out = splice(out, setMember(out, obj(out, ["merge"]), "reuse", "false"));
    if (c.deleteBranches === false) out = splice(out, removeMember(out, obj(out, ["merge"]), "deleteBranches"));
    else if (c.deleteBranches === true) out = splice(out, setMember(out, obj(out, ["merge"]), "deleteBranches", "true"));
    for (const id of ids) {
      const ch = c.checks![id]!;
      const at = ["merge", "checks", { check: id }];
      if (ch.timeoutSec !== undefined) out = splice(out, setMember(out, obj(out, at), "timeout", String(ch.timeoutSec)));
      for (const k of ["rerun", "optional"] as const) {
        if (ch[k] === true) out = splice(out, setMember(out, obj(out, at), k, "true"));
        if (ch[k] === false) out = splice(out, removeMember(out, obj(out, at), k));
      }
    }
  }
  let after: unknown;
  try {
    after = JSON.parse(out);
  } catch {
    throw new SettingsEditError("the edit didn't leave valid JSON");
  }
  const want = hasMerge || c.push !== undefined || c.review === true || (c.land !== undefined && c.land !== "local") || c.reuse === false || c.deleteBranches === true ? applyToData(raw, c) : raw;
  if (!isDeepStrictEqual(after, want)) throw new SettingsEditError("the edit didn't come out as asked");
  try {
    parseDefinition(out);
  } catch (err) {
    throw new SettingsEditError(`that change doesn't leave a valid definition: ${err instanceof Error ? err.message : err}`);
  }
  return out;
}
