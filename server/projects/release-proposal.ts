import { createHash } from "node:crypto";
import { CONTRACT_FILE, DefinitionError, parseDefinition } from "../../shared/project-contract";
import type { ReleaseSetupReview } from "../../shared/project-runtime";
import { ManifestError, parseReleaseManifest, RELEASE_MANIFEST_FILE } from "../../shared/release";
import { realGit } from "../project-services/engine";

type GitRun = typeof realGit;

/**
 * What a Release playbook maker run's branch proposes (`proposes: release`, §app.project-runtime/verb-playbooks):
 * the definition's `release` section and the project's release playbook folder, read at the branch's tip from git
 * (never the worktree's files). Its hash pins exactly what the operator read on the review: the section's
 * canonical JSON and the git tree of the playbook folder, so a changed setting, step, line or script is a new hash.
 */

/** JSON with every object's keys sorted: the same section always hashes the same. Pure. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** The release setup's hash: the raw section and the playbook folder's tree id (null: the folder is missing). Pure. */
export function releaseHashOf(section: unknown, tree: string | null): string {
  return `sha256:${createHash("sha256").update(`release\0${canonicalJson(section)}\0${tree ?? "-"}\n`).digest("hex")}`;
}

/**
 * The release setup at `ref`: its hash and what the review shows, or null when the definition there declares no
 * `release` (or can't be read). A setup the parsers refuse still has a hash only when the section parses: the
 * manifest's problem is shown beside it, and nothing invalid is offered to land.
 */
export async function releaseSetupAt(root: string, ref: string, git: GitRun = realGit): Promise<ReleaseSetupReview | null> {
  const sha = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], root);
  if (sha.code !== 0) return null;
  const commit = sha.stdout.trim();
  const shown = await git(["show", `${commit}:${CONTRACT_FILE}`], root);
  if (shown.code !== 0) return null;
  let raw: unknown;
  try {
    raw = (JSON.parse(shown.stdout) as Record<string, unknown>)?.release;
  } catch {
    return null;
  }
  if (raw === undefined) return null;
  let decl;
  try {
    decl = parseDefinition(shown.stdout).release;
  } catch (err) {
    return { hash: "", settings: null, steps: [], files: [], problem: err instanceof DefinitionError ? err.message : String(err) };
  }
  if (!decl) return null;
  const settings = { playbook: decl.playbook, tag: decl.tag, scheme: decl.scheme, channels: [...decl.channels], commit: decl.commit, checks: [...decl.checkIds], quietMin: decl.quietMin };
  const dir = decl.playbook.replace(/\/+$/, "");
  const treeR = await git(["rev-parse", "--verify", "--quiet", `${commit}:${dir}`], root);
  const tree = treeR.code === 0 ? treeR.stdout.trim() : null;
  const listed = tree ? await git(["ls-tree", "-r", "--name-only", commit, "--", `${dir}/`], root) : null;
  const files = listed && listed.code === 0 ? listed.stdout.split("\n").filter(Boolean).map((f) => f.slice(dir.length + 1)) : [];
  if (!tree) return { hash: "", settings, steps: [], files, problem: `${dir} is missing on the branch: the release playbook folder holds PLAYBOOK.md and ${RELEASE_MANIFEST_FILE}` };
  const m = await git(["show", `${commit}:${dir}/${RELEASE_MANIFEST_FILE}`], root);
  if (m.code !== 0) return { hash: "", settings, steps: [], files, problem: `${dir}/${RELEASE_MANIFEST_FILE} is missing on the branch` };
  let steps;
  try {
    steps = parseReleaseManifest(m.stdout).steps.map((s) => ({ ...s }));
  } catch (err) {
    return { hash: "", settings, steps: [], files, problem: `${dir}/${RELEASE_MANIFEST_FILE}: ${err instanceof ManifestError ? err.message : String(err)}` };
  }
  if (!files.includes("PLAYBOOK.md")) return { hash: "", settings, steps, files, problem: `${dir}/PLAYBOOK.md is missing on the branch` };
  return { hash: releaseHashOf(raw, tree), settings, steps, files };
}
