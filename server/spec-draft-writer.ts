import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REQUIREMENTS_NS, type DecisionRow } from "../shared/decisions";
import { provenanceOf, specSlug } from "./decisions";

/**
 * The deterministic spec writer (§app.requirements/drafts-with-provenance, /promotion): decisions
 * become `note` records under `§requirements/<area>` in the PROJECT's own `.sova/spec`, through
 * the spec tools Sova ships (pi-config/extensions/spec/core/sova-spec-draft.mjs), run as a child
 * process without a shell. No model writes anything: the prose is the decision's own statement
 * and quote. It edits only drafts; `claims/` and `manifest.json` change only by `promote`.
 *
 * - The project draft `sova-decisions` shows every reconciled decision not yet promoted. It is
 *   Sova's own and is rebuilt from current each time (a draft's base is frozen at `new`, so an old
 *   one would conflict with every later promotion).
 * - A promotion builds a fresh draft holding exactly the selected decisions (claim files move
 *   whole), records `--doc-only` evidence per record, promotes with the previewed plan hash, and
 *   removes the draft.
 * - A project with no spec starts from the tool's empty baseline: no Git and no prior docs needed.
 */

const DRAFT_TOOL = join(import.meta.dirname, "..", "pi-config", "extensions", "spec", "core", "sova-spec-draft.mjs");
export const PROJECT_DRAFT = "sova-decisions";
const BATCH_PREFIX = "sova-promote-";
const TOOL_TIMEOUT_MS = 60_000;

export class SpecToolError extends Error {
  constructor(
    message: string,
    readonly codes: string[] = [],
  ) {
    super(message);
  }
}

export interface ToolResult {
  exit: number;
  json: Record<string, any>;
}

/** Run the draft tool: argv only, `--root` and `--json` appended. Never throws on exit 1/2. */
export function runDraftTool(root: string, args: string[], tool = DRAFT_TOOL): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [tool, ...args, "--root", root, "--json"], { timeout: TOOL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } }, (err, stdout) => {
      let json: Record<string, any>;
      try {
        json = JSON.parse(stdout);
      } catch {
        reject(new SpecToolError(`spec tool failed: ${err?.message ?? "no output"}`));
        return;
      }
      const exit = typeof json.exit === "number" ? json.exit : err ? 2 : 0;
      resolve({ exit, json });
    });
  });
}

const findingText = (r: ToolResult): string =>
  [...(r.json.findings ?? []), ...(r.json.refusals ?? [])]
    .map((f: any) => `${f.code ?? "?"}: ${f.message ?? f.reason ?? ""}`.trim())
    .join("; ") || `exit ${r.exit}`;
const findingCodes = (r: ToolResult): string[] => [...(r.json.findings ?? []), ...(r.json.refusals ?? [])].map((f: any) => String(f.code ?? ""));

async function must(root: string, args: string[]): Promise<ToolResult> {
  const r = await runDraftTool(root, args);
  if (r.exit !== 0) throw new SpecToolError(`${args[0]}: ${findingText(r)}`, findingCodes(r));
  return r;
}

// ---- paths ----------------------------------------------------------------------------------------

export const specDirOf = (root: string): string => join(root, ".sova", "spec");
const draftsDir = (root: string) => join(specDirOf(root), "drafts");
const draftSpecDir = (root: string, name: string) => join(draftsDir(root), name, "spec");

/** Drafts, reviews and pilot data are local only: a client repo gets the same ignore rule Sova's has. */
/** The `.sova/spec/.gitignore` Sova adds when a project has none (a promotion commits it as its own). */
export const LOCAL_ONLY_IGNORE = "# Local only: proposals, review packets and session metrics are never committed.\ndrafts/\nreviews/\npilot/\n";

function ensureLocalOnlyIgnore(root: string): void {
  const file = join(specDirOf(root), ".gitignore");
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, LOCAL_ONLY_IGNORE);
}

/** Remove one of Sova's own drafts. Refuses while any promotion is in flight. */
function removeOwnDraft(root: string, name: string): void {
  if (name !== PROJECT_DRAFT && !name.startsWith(BATCH_PREFIX)) throw new Error(`not a Sova draft: ${name}`);
  if (existsSync(join(draftsDir(root), ".txn"))) throw new SpecToolError("A spec promotion is pending recovery in this project (drafts/.txn); run the draft tool's recover first.", ["pending-transaction"]);
  rmSync(join(draftsDir(root), name), { recursive: true, force: true });
}

// ---- rendering --------------------------------------------------------------------------------------

export const areaId = (areaKey: string): string => `§${REQUIREMENTS_NS}/${areaKey}`;
export const recordIdOf = (areaKey: string, slug: string): string => `§${REQUIREMENTS_NS}.${areaKey}/${slug}`;

const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/** Text that can never declare, open a fence or break the claim file's structure. */
function safeProse(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => (/^\s{0,3}(#|`{3,}|~{3,})/.test(l) ? `\\${l.trimStart()}` : l))
    .join("\n")
    .trim();
}

const quoteBlock = (quote: string): string =>
  safeProse(quote)
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");

/** A record slug for a decision, unique among `taken` (letters only: `-b`, `-c`… on a clash). */
export function recordSlug(statement: string, taken: ReadonlySet<string>): string {
  const base = specSlug(statement, 40) || "decision";
  if (!taken.has(base)) return base;
  for (let i = 1; i < 26 * 26; i++) {
    const suffix = i < 26 ? String.fromCharCode(97 + i) : String.fromCharCode(96 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26));
    if (!taken.has(`${base}-${suffix}`)) return `${base}-${suffix}`;
  }
  throw new Error("no free record slug");
}

const dateOf = (iso: string): string => (iso.length >= 10 ? iso.slice(0, 10) : iso);

export function renderLede(areaKey: string, area: string): string {
  return `# ${areaId(areaKey)} — ${oneLine(area, 80) || areaKey}\n\nDecisions about ${oneLine(area, 120) || areaKey}, each in the words of the person who made it. Sova's reconciler files and promotes them; change them only through it.\n`;
}

const said = (d: Pick<DecisionRow, "quote" | "name" | "at">): string => `${quoteBlock(d.quote)}\n\n— ${oneLine(d.name, 80)}, ${dateOf(d.at)}`;

/** A record's prose: the statement, then each quote with who said it and when (the decision's own
    first, then any that restated it), then the supersede line. */
export function renderRecord(d: DecisionRow, supersededByRecord?: string, also: DecisionRow[] = []): string {
  const lines = [`## ${d.recordId} — ${oneLine(d.statement, 80)}`, "", safeProse(d.statement), "", said(d)];
  for (const a of also) lines.push("", said(a));
  if (supersededByRecord) lines.push("", `Superseded by ${supersededByRecord}.`);
  return `${lines.join("\n")}\n`;
}

/** The manifest fields the decisions layer owns (§app.requirements/decisions). `kind` and
    `authority` are written only when it creates a record; every other field is the spec layer's. */
export const DECISION_FIELDS = ["decision", "provenance", "supersededBy"] as const;

/** A record's decisions-owned fields, in a fixed order: what the reconciler compares. */
export const decisionPart = (rec: unknown): Record<string, unknown> => {
  const r = (rec && typeof rec === "object" ? rec : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of DECISION_FIELDS) if (r[k] !== undefined) out[k] = r[k];
  return out;
};

/** A record as the reconciler writes it over `existing`: its own fields replaced, the rest kept. */
export function mergeRecord(existing: Record<string, unknown> | undefined, rec: Record<string, unknown>): Record<string, unknown> {
  if (!existing) return rec;
  const out: Record<string, unknown> = { ...existing };
  for (const k of DECISION_FIELDS) {
    if (rec[k] === undefined) delete out[k];
    else out[k] = rec[k];
  }
  return out;
}

export function manifestRecord(d: DecisionRow, supersededByRecord?: string, also: DecisionRow[] = []): Record<string, unknown> {
  return {
    kind: "note",
    authority: "accepted",
    provenance: [provenanceOf(d), ...also.map(provenanceOf)],
    decision: d.id,
    ...(supersededByRecord ? { supersededBy: supersededByRecord } : {}),
  };
}

// ---- editing a spec directory (a draft's spec/) ------------------------------------------------------------

interface ClaimFile {
  /** The lines before the first H2, joined; null when the file opens with one. */
  lede: string | null;
  /** Each H2 through the line before the next, trailing blank lines included. */
  blocks: { id: string; text: string }[];
}

function parseClaimFile(text: string): ClaimFile {
  const lines = text.split("\n");
  const out: ClaimFile = { lede: null, blocks: [] };
  let cur: { id: string; lines: string[] } | null = null;
  const lede: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) fence = fence === null ? f[1]![0]! : fence === f[1]![0] ? null : fence;
    const h = fence === null ? /^## (§\S+)/.exec(line) : null;
    if (h) {
      if (cur) out.blocks.push({ id: cur.id, text: cur.lines.join("\n") });
      cur = { id: h[1]!, lines: [line] };
    } else if (cur) cur.lines.push(line);
    else lede.push(line);
  }
  if (cur) out.blocks.push({ id: cur.id, text: cur.lines.join("\n") });
  if (lede.length) out.lede = lede.join("\n");
  return out;
}

const trimBlock = (s: string) => s.replace(/\n+$/, "");
/** The file's bytes again: parse then join is the identity, so untouched blocks stay as they were. */
const joinClaimFile = (f: ClaimFile): string => [...(f.lede === null ? [] : [f.lede]), ...f.blocks.map((b) => b.text)].join("\n");
/** A block's text with `text`'s content and `old`'s trailing blank lines (its place in the layout). */
const keepLayout = (old: string, text: string): string => `${trimBlock(text)}${/\n*$/.exec(old)![0]}`;
/** Append a block after the file's bytes, a blank line between (the join adds one newline; a file
    not ending in one gets it), and the file ends with a newline. */
function appendBlock(f: ClaimFile, id: string, text: string): void {
  const last = f.blocks.at(-1);
  const prev = last ? last.text : f.lede;
  if (prev !== null && !prev.endsWith("\n")) {
    if (last) last.text += "\n";
    else f.lede += "\n";
  }
  f.blocks.push({ id, text: `${trimBlock(text)}\n` });
}

/** SHA-256 of a record's prose block, its trailing blank lines left out (`DecisionRow.promotedText`). */
export const proseHash = (block: string): string => createHash("sha256").update(trimBlock(block)).digest("hex");

/** A record's prose block in the current spec (`claims/requirements/<area>.md`), or null. */
export function currentBlock(root: string, recordId: string): string | null {
  const m = /^§[^.]+\.([^/]+)\//.exec(recordId);
  if (!m) return null;
  let claimsRoot = "claims";
  try {
    const manifest = JSON.parse(readFileSync(join(specDirOf(root), "manifest.json"), "utf8")) as { claimsRoot?: string };
    if (typeof manifest.claimsRoot === "string") claimsRoot = manifest.claimsRoot.replace(/\/+$/, "");
  } catch {
    return null;
  }
  try {
    const f = parseClaimFile(readFileSync(join(specDirOf(root), claimsRoot, REQUIREMENTS_NS, `${m[1]}.md`), "utf8"));
    return f.blocks.find((b) => b.id === recordId)?.text ?? null;
  } catch {
    return null;
  }
}

export interface SpecEdit {
  /** Decision rows to write as records (their recordId set). */
  rows: DecisionRow[];
  /** recordId → the record that supersedes it, for rows written as superseded. */
  supersededBy: Map<string, string>;
  /** recordId → decisions folded into it (their quotes and provenance join the record). */
  also?: Map<string, DecisionRow[]>;
}

/**
 * Write the records into a spec directory (manifest + claims): an area file gets its lede once,
 * then one H2 per record, appended or replaced in place. Only what changes is written: a record
 * keeps the fields the spec layer owns, a replaced block keeps its layout, other blocks keep their
 * bytes, and a file with nothing to change is not written (the spec tools move files whole, so a
 * byte changed outside any record would pull all of the file's records into a promotion).
 * `proseOnly`: rewrite only the records' prose, never their manifest fields. Returns the ids whose
 * bytes changed.
 */
export function applyToSpecDir(specDir: string, edit: SpecEdit, opts: { proseOnly?: boolean } = {}): string[] {
  const manifestPath = join(specDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { claimsRoot?: string; claims: Record<string, Record<string, unknown>> };
  const claimsRoot = join(specDir, (manifest.claimsRoot ?? "claims").replace(/\/+$/, ""));
  const changed = new Set<string>();
  let manifestChanged = false;
  const byArea = new Map<string, DecisionRow[]>();
  for (const d of edit.rows) {
    if (!d.recordId) throw new Error(`decision ${d.id} has no record id`);
    byArea.set(d.areaKey, [...(byArea.get(d.areaKey) ?? []), d]);
  }
  for (const [areaKey, rows] of byArea) {
    const file = join(claimsRoot, REQUIREMENTS_NS, `${areaKey}.md`);
    const lid = areaId(areaKey);
    let parsed: ClaimFile;
    let fileChanged = false;
    if (existsSync(file)) parsed = parseClaimFile(readFileSync(file, "utf8"));
    else {
      parsed = { lede: renderLede(areaKey, rows[0]!.area), blocks: [] };
      changed.add(lid);
      fileChanged = true;
    }
    if (!manifest.claims[lid]) {
      manifest.claims[lid] = { kind: "note", authority: "accepted" };
      changed.add(lid);
      manifestChanged = true;
    }
    for (const d of rows) {
      const sup = edit.supersededBy.get(d.recordId!);
      const also = edit.also?.get(d.recordId!) ?? [];
      const text = renderRecord(d, sup, also);
      const i = parsed.blocks.findIndex((b) => b.id === d.recordId);
      if (i < 0 || trimBlock(parsed.blocks[i]!.text) !== trimBlock(text)) {
        if (i < 0) appendBlock(parsed, d.recordId!, text);
        else parsed.blocks[i] = { id: d.recordId!, text: keepLayout(parsed.blocks[i]!.text, text) };
        fileChanged = true;
        changed.add(d.recordId!);
      }
      const existing = manifest.claims[d.recordId!];
      if (opts.proseOnly && existing) continue;
      const rec = mergeRecord(existing, manifestRecord(d, sup, also));
      if (JSON.stringify(existing) === JSON.stringify(rec)) continue;
      manifest.claims[d.recordId!] = rec;
      manifestChanged = true;
      changed.add(d.recordId!);
    }
    if (!fileChanged) continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, joinClaimFile(parsed));
  }
  if (manifestChanged) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return [...changed].sort();
}

// ---- reading the current spec ----------------------------------------------------------------------------

/** The current spec's manifest records by id (empty when there is none). */
export function currentClaims(root: string): Record<string, unknown> {
  try {
    const m = JSON.parse(readFileSync(join(specDirOf(root), "manifest.json"), "utf8"));
    return m && typeof m.claims === "object" && m.claims !== null ? m.claims : {};
  } catch {
    return {};
  }
}

/** Record ids of the current spec (empty when there is none). */
export const currentRecordIds = (root: string): Set<string> => new Set(Object.keys(currentClaims(root)));

export const specExists = (root: string): boolean => existsSync(join(specDirOf(root), "manifest.json"));
export const projectDraftExists = (root: string): boolean => existsSync(join(draftsDir(root), PROJECT_DRAFT, "draft.json"));

// ---- the two writers -------------------------------------------------------------------------------------

/** Rebuild the project draft from current plus `edit`. Returns the ids it changed. */
export async function writeProjectDraft(root: string, edit: SpecEdit): Promise<{ draft: string | null; changed: string[] }> {
  ensureLocalOnlyIgnore(root);
  removeOwnDraft(root, PROJECT_DRAFT);
  if (!edit.rows.length) return { draft: null, changed: [] };
  await must(root, ["new", PROJECT_DRAFT, "--purpose", "Decisions recorded in conversations, reconciled and not yet promoted", "--write"]);
  const changed = applyToSpecDir(draftSpecDir(root, PROJECT_DRAFT), edit);
  const check = await runDraftTool(root, ["check", PROJECT_DRAFT]);
  if (check.exit === 2) throw new SpecToolError(`the draft does not load: ${findingText(check)}`, findingCodes(check));
  return { draft: PROJECT_DRAFT, changed };
}

export interface PromoteOutcome {
  /** Record ids now current. */
  promoted: string[];
  plan: string | null;
  /** The kept batch draft holding the evidence, when something was promoted. */
  draft: string | null;
}

/**
 * Promote exactly `edit` into the project's current spec: a fresh batch draft, `--doc-only`
 * evidence per changed record (`verification(id)`), preview, then write with that plan's hash.
 * A promoted batch draft is kept: its draft.json is the evidence and promotion record (local only,
 * like every draft). One that promoted nothing is removed.
 */
export async function promoteEdit(root: string, edit: SpecEdit, verification: (id: string) => string, now = new Date(), opts: { proseOnly?: boolean } = {}): Promise<PromoteOutcome> {
  ensureLocalOnlyIgnore(root);
  const name = `${BATCH_PREFIX}${now.toISOString().replace(/[^0-9]/g, "").slice(0, 17)}`;
  removeOwnDraft(root, name);
  let promoted = false;
  try {
    await must(root, ["new", name, "--purpose", "Promote reconciled decisions", "--write"]);
    const changed = applyToSpecDir(draftSpecDir(root, name), edit, opts);
    if (!changed.length) return { promoted: [], plan: null, draft: null };
    for (const id of changed) await must(root, ["evidence", name, "--id", id, "--by", "reconciler", "--verification", verification(id), "--doc-only", "--write"]);
    const ids = changed.flatMap((id) => ["--id", id]);
    const preview = await must(root, ["promote", name, ...ids]);
    const plan = typeof preview.json.plan === "string" ? preview.json.plan : null;
    if (!plan) throw new SpecToolError("promote printed no plan");
    await must(root, ["promote", name, ...ids, "--plan", plan, "--write"]);
    promoted = true;
    return { promoted: changed, plan, draft: name };
  } finally {
    if (!promoted)
      try {
        removeOwnDraft(root, name);
      } catch {
        // a pending transaction keeps its draft for `recover`
      }
  }
}
