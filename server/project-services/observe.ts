import { createHash } from "node:crypto";
import { CONTRACT_FILE, DefinitionError, parseDefinition, portsFor, type IsolationDecl, type ProjectDef, type ServiceDecl } from "../../shared/project-contract";
import { readStamp, SUITE_VERSION, type Stamp } from "./conform";
import { realGit } from "./engine";
import { defHashOf, deployHashOf } from "./def-hash";

/**
 * What a project's software registry reads (§app.project-services/facts): main's definition at
 * HEAD (never the working tree, which may be dirty), its software, its `sources` at HEAD, and this
 * host's conformance stamps. Pure reads of git and Sova's state; the host turns them
 * into the `runtime/<p>` statechart's facts and compares what drifted.
 */

type Git = typeof realGit;

export type DefFact = { state: "absent" } | { state: "invalid"; error: string } | { state: "present"; hash: string };

export interface SoftwareFact {
  name: string;
  kind: "process" | "static" | "container";
  scope: "checkout" | "shared";
  /** Slot 0's, in declaration order. */
  ports: { name: string; port: number }[];
  requires: string[];
  start: "up" | "on-demand";
  isolation?: IsolationDecl;
}

/** A data resource main's definition declares; `sensitive`: its copies are never shared. */
export interface DataFact {
  name: string;
  kind: "dir" | "hook";
  sensitive: boolean;
}

export interface ProofFact {
  hash: string;
  suite: number;
  pass: boolean;
  at: string;
  /** The report file. */
  report: string;
  failed?: { check: string; detail: string };
  memory?: Stamp["memory"];
}

export interface SourcesFact {
  paths: string[];
  /** Each path's blob at the commit; null where it is missing there. */
  files: Record<string, string | null>;
  /** `sha256:` over the paths and blobs; null when the definition lists no sources. */
  fingerprint: string | null;
}

export interface RuntimeFacts {
  v: 1;
  root: string;
  /** The commit read (main's HEAD); null in a repository with no commit. */
  commit: string | null;
  def: DefFact;
  software: SoftwareFact[];
  /** In declaration order. */
  data: DataFact[];
  sources: SourcesFact;
  /** The newest conformance of `def.hash` with the current suite. */
  proof: ProofFact | null;
  suite: number;
}

export interface BranchFacts {
  ref: string;
  commit: string | null;
  def: DefFact;
  /** The newest conformance of the branch's definition with the current suite. */
  proof: ProofFact | null;
  /** Its deploy recipe's own hash; null when it declares none. */
  deploy: { hash: string } | null;
}

const kindOf = (s: ServiceDecl): SoftwareFact["kind"] => (s.static !== undefined ? "static" : s.container ? "container" : "process");

export function softwareOf(def: ProjectDef): SoftwareFact[] {
  const slot0 = portsFor(def, 0);
  return def.services.map((s) => ({
    name: s.name,
    kind: kindOf(s),
    scope: s.scope,
    ports: Object.entries(slot0[s.name] ?? {}).map(([name, port]) => ({ name, port })),
    requires: [...s.requires],
    start: s.start,
    ...(s.isolation ? { isolation: { ...s.isolation } } : {}),
  }));
}

function proofOf(root: string, hash: string): ProofFact | null {
  const s = readStamp(root, hash);
  if (!s || s.suiteVersion !== SUITE_VERSION) return null;
  return { hash, suite: s.suiteVersion, pass: s.pass, at: s.at, report: s.report, ...(s.failed ? { failed: s.failed } : {}), ...(s.memory ? { memory: s.memory } : {}) };
}

/** The definition at `ref` of `root`: its commit, and the parsed definition or why not. */
async function defAt(root: string, ref: string, git: Git): Promise<{ commit: string | null; def: ProjectDef | null; fact: DefFact }> {
  const sha = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], root);
  if (sha.code !== 0) return { commit: null, def: null, fact: { state: "absent" } };
  const commit = sha.stdout.trim();
  const shown = await git(["show", `${commit}:${CONTRACT_FILE}`], root);
  if (shown.code !== 0) return { commit, def: null, fact: { state: "absent" } };
  try {
    const def = parseDefinition(shown.stdout);
    return { commit, def, fact: { state: "present", hash: defHashOf(def) } };
  } catch (err) {
    return { commit, def: null, fact: { state: "invalid", error: err instanceof DefinitionError ? err.message : String(err) } };
  }
}

/** `paths`' blobs at `commit` (`git ls-tree`), and their fingerprint. */
export async function sourcesAt(root: string, commit: string | null, paths: string[], git: Git = realGit): Promise<SourcesFact> {
  const files: Record<string, string | null> = Object.fromEntries(paths.map((p) => [p, null]));
  if (!paths.length) return { paths: [], files, fingerprint: null };
  if (commit) {
    const r = await git(["ls-tree", "-z", commit, "--", ...paths], root);
    for (const entry of r.stdout.split("\0")) {
      const m = /^\d+ \w+ ([0-9a-f]+)\t(.+)$/s.exec(entry);
      if (m && m[2]! in files) files[m[2]!] = m[1]!;
    }
  }
  const h = createHash("sha256");
  for (const p of [...paths].sort()) h.update(`${p}\0${files[p] ?? "-"}\n`);
  return { paths, files, fingerprint: `sha256:${h.digest("hex")}` };
}

/** The registry's facts for `root` (a project's main checkout) at its HEAD. */
export async function observeRuntime(root: string, git: Git = realGit): Promise<RuntimeFacts> {
  const { commit, def, fact } = await defAt(root, "HEAD", git);
  const hash = fact.state === "present" ? fact.hash : null;
  return {
    v: 1,
    root,
    commit,
    def: fact,
    software: def ? softwareOf(def) : [],
    data: (def?.data ?? []).map((d) => ({ name: d.name, kind: d.kind, sensitive: d.sensitive === true })),
    sources: await sourcesAt(root, commit, def?.sources ?? [], git),
    proof: hash ? proofOf(root, hash) : null,
    suite: SUITE_VERSION,
  };
}

/** A branch's definition at its tip (the Project verbs playbook's proposal): its hash and proof. */
export async function branchFacts(root: string, ref: string, git: Git = realGit): Promise<BranchFacts> {
  const { commit, def, fact } = await defAt(root, ref, git);
  const hash = fact.state === "present" ? fact.hash : null;
  const dh = def?.deploy ? deployHashOf(def.deploy) : null;
  return {
    ref,
    commit,
    def: fact,
    proof: hash ? proofOf(root, hash) : null,
    deploy: dh ? { hash: dh } : null,
  };
}

