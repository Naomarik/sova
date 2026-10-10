import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DraftToolRunner, ToolResult } from "./spec-draft-writer";

/**
 * Tests only (nothing in the server imports this). The spec draft tool's commands the decisions
 * layer runs (`new`, `check`, `status`, `evidence`, `promote` preview and `--write`), in-process
 * over the same files, for `setDraftToolForTest`: the decisions logic tests run without a child
 * process per call. It writes what the real tool writes for that path (a draft's literal copy of
 * the current spec, its draft.json evidence and promotions, a promotion's records and whole claim
 * files), and checks nothing the real tool checks. reconcile.integration.test.ts holds it to the
 * real tool's output for one draft-and-promotion.
 */
export function fakeDraftTool(): DraftToolRunner {
  return async (root, args) => {
    try {
      return run(root, args);
    } catch (err) {
      return { exit: 2, json: { exit: 2, findings: [{ severity: "error", code: "fake", message: err instanceof Error ? err.message : String(err) }] } };
    }
  };
}

const SPEC = join(".sova", "spec");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ok = (more: Record<string, unknown> = {}): ToolResult => ({ exit: 0, json: { exit: 0, findings: [], ...more } });
const refused = (exit: 1 | 2, code: string, message: string): ToolResult => ({ exit, json: { exit, findings: [{ severity: exit === 2 ? "error" : "warn", code, message }] } });

type Manifest = { formatVersion?: number; claimsRoot?: string; claims: Record<string, Record<string, unknown>> };
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const writeJson = (file: string, v: unknown) => writeFileSync(file, `${JSON.stringify(v, null, 2)}\n`);

/** `--flag value` pairs (repeatable), and the bare flags. */
function parse(args: string[]): { cmd: string; name: string; values: Map<string, string[]>; flags: Set<string> } {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let i = 2; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--write" || a === "--doc-only" || a === "--all" || a === "--json") flags.add(a);
    else if (a.startsWith("--")) values.set(a, [...(values.get(a) ?? []), args[++i] ?? ""]);
  }
  return { cmd: args[0] ?? "", name: args[1] ?? "", values, flags };
}

// The real tool's withNewRecords (sova-spec-draft.mjs), mirrored; spec-tool-fake.test.ts holds the two together.
// New records go right before the first record of the same area (the id up to "/") that sorts after them, else
// right after that area's last record; an area's first record goes right before the first record whose area sorts
// after its own, or last. Records already there keep their place.
const areaOf = (id: string) => id.slice(0, id.indexOf("/") >>> 0);
export function withNewRecords<T>(claims: Record<string, T>, added: Record<string, T>): Record<string, T> {
  const keys = Object.keys(claims);
  for (const id of Object.keys(added).sort()) {
    const area = areaOf(id);
    const own = keys.flatMap((k, i) => (areaOf(k) === area ? [i] : []));
    let at = own.length ? (own.find((i) => keys[i]! > id) ?? own.at(-1)! + 1) : keys.findIndex((k) => areaOf(k) > area);
    if (at < 0) at = keys.length;
    keys.splice(at, 0, id);
  }
  return Object.fromEntries(keys.map((k) => [k, k in added ? added[k]! : claims[k]!]));
}

/** The claim file (relative to the spec dir) that declares `id`: `§ns/area` and `§ns.area/x` live in claims/ns/area.md. */
function fileOf(id: string, claimsRoot: string): string {
  const lede = /^§([^./]+)\/([^/]+)$/.exec(id);
  const rec = /^§([^./]+)\.([^/]+)\//.exec(id);
  const [ns, area] = lede ? [lede[1], lede[2]] : rec ? [rec[1], rec[2]] : [null, null];
  if (!ns) throw new Error(`no claim file for ${id}`);
  return join(claimsRoot, ns, `${area}.md`);
}

/** The declaration text of `id` in a claim file (its H1 lede or H2 block), for evidence hashes. */
function textOf(file: string, id: string): string {
  if (!existsSync(file)) return "";
  const lines = readFileSync(file, "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith(`# ${id} `) || l.startsWith(`## ${id} `));
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length && !/^##? §/.test(lines[end]!)) end++;
  return lines.slice(start, end).join("\n");
}

function run(root: string, args: string[]): ToolResult {
  const { cmd, name, values, flags } = parse(args);
  const spec = join(root, SPEC);
  const draft = join(spec, "drafts", name);
  const draftJson = join(draft, "draft.json");
  const draftSpec = join(draft, "spec");
  const write = flags.has("--write");
  if (cmd === "new") {
    if (existsSync(draft)) return refused(1, "draft-exists", `draft ${name} exists`);
    if (!write) return ok({ written: false, name });
    const existed = existsSync(join(spec, "manifest.json"));
    const current: Manifest = existed ? readJson<Manifest>(join(spec, "manifest.json")) : { formatVersion: 1, claims: {} };
    const claimsRoot = (current.claimsRoot ?? "claims").replace(/\/+$/, "");
    // The edit copy, and (when there was a spec) the base it started from: literal copies both.
    for (const to of existed ? [draftSpec, join(draft, "base")] : [draftSpec]) {
      mkdirSync(to, { recursive: true });
      if (existsSync(join(spec, claimsRoot))) cpSync(join(spec, claimsRoot), join(to, claimsRoot), { recursive: true });
      if (existed) cpSync(join(spec, "manifest.json"), join(to, "manifest.json"));
      else writeJson(join(to, "manifest.json"), current);
    }
    const purpose = values.get("--purpose")?.[0] ?? "";
    writeJson(draftJson, { format: "sova-spec-draft/1", name, createdAt: new Date().toISOString(), purpose, base: { specExisted: existed, claimsRoot, files: {} }, evidence: [], promotions: [] });
    return ok({ written: true, name, specExisted: existed, claimsRoot });
  }
  if (!existsSync(draftJson)) return refused(2, "draft-missing", `no draft ${name}`);
  const dj = readJson<{ evidence: unknown[]; promotions: unknown[] }>(draftJson);
  const dm = readJson<Manifest>(join(draftSpec, "manifest.json"));
  const claimsRoot = (dm.claimsRoot ?? "claims").replace(/\/+$/, "");
  const ids = [...(values.get("--id") ?? [])].sort();
  if (cmd === "check" || cmd === "status") return ok({ name });
  if (cmd === "evidence") {
    if (!flags.has("--doc-only")) return refused(2, "usage", "the fake records --doc-only evidence only");
    if (!write) return ok({ written: false });
    const by = values.get("--by")?.[0] ?? "";
    const verification = values.get("--verification")?.[0] ?? "";
    const entry = {
      recordedAt: new Date().toISOString(),
      by,
      verification,
      mode: "doc-only",
      ids: ids.map((id) => ({ id, kind: dm.claims[id]?.["kind"] ?? null, deleted: !dm.claims[id], recordSha: sha(JSON.stringify(dm.claims[id] ?? null)), textSha256: sha(textOf(join(draftSpec, fileOf(id, claimsRoot)), id)) })),
      inputs: [],
    };
    writeJson(draftJson, { ...dj, evidence: [...dj.evidence, entry] });
    return ok({ written: true });
  }
  if (cmd === "promote") {
    const files = [...new Set(ids.map((id) => fileOf(id, claimsRoot)))].sort();
    const plan = sha(JSON.stringify({ ids, records: ids.map((id) => dm.claims[id] ?? null), files: files.map((f) => [f, existsSync(join(draftSpec, f)) ? readFileSync(join(draftSpec, f), "utf8") : null]) }));
    if (!write) return ok({ written: false, name, ids, plan });
    if (values.get("--plan")?.[0] !== plan) return refused(1, "plan-stale", "the draft changed since the preview");
    const existed = existsSync(join(spec, "manifest.json"));
    const current: Manifest = existed ? readJson<Manifest>(join(spec, "manifest.json")) : { formatVersion: dm.formatVersion ?? 1, ...(dm.claimsRoot ? { claimsRoot: dm.claimsRoot } : {}), claims: {} };
    const added: Manifest["claims"] = {};
    for (const id of ids) {
      if (!dm.claims[id]) delete current.claims[id];
      else if (id in current.claims) current.claims[id] = dm.claims[id]!;
      else added[id] = dm.claims[id]!;
    }
    current.claims = withNewRecords(current.claims, added);
    for (const f of files) {
      mkdirSync(dirname(join(spec, f)), { recursive: true });
      cpSync(join(draftSpec, f), join(spec, f));
    }
    writeJson(join(spec, "manifest.json"), current);
    writeJson(draftJson, { ...dj, promotions: [...dj.promotions, { at: new Date().toISOString(), plan, ids, meta: ["formatVersion"], files: [...files, "manifest.json"] }] });
    return ok({ written: true, name, ids, plan });
  }
  return refused(2, "usage", `the fake does not run ${cmd}`);
}
