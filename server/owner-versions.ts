import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_FILE, parseDefinition, type ProjectDef } from "../shared/project-contract";
import type { OwnerVersionRow } from "../shared/project-assistant";
import { handleOf, onOwnerLinkEvent } from "./person-links";
import { keepPreview, keptPreview, keptPreviews } from "./preview-kept";
import { findPreviewByHash, listPreviews, mintPreview, previewState, revokePreview, setPreviewExpiry } from "./preview-links";
import { staticServes } from "./preview-serve";
import { projectTrees, sovaPorts, treeHolding, type CodingTree } from "./project-previews";
import { holdsSensitive } from "./project-services/sensitive";
import { endpointOf, shareRefusal } from "./project-services/share";
import { realGit } from "./project-services/engine";
import { readRegistry, type InstanceRecord } from "./project-services/store";
import { previewAddress, previewOrigin } from "./share/preview-address";
import { awaitShareLinks } from "./share/links-events";
import { orgRequests } from "./project-assistant-store";

/**
 * Versions you can try (§app.project-assistant/versions): each shown project's running copies the
 * owner may open, the main checkout's as "Current version", each coding worktree's as a fix. Opened
 * only through the owner link (`/i/<token>/v/<v_…>`), which sends the browser on to an owner-bound
 * preview link: minted here per copy and endpoint, kept with `owner` = the owner link's hash, its
 * expiry following the owner link's idle deadline, turned off with the owner link. No preview address
 * ever reaches an `/api/i` answer.
 */

/** A version as this host knows it (operator-side; the page gets OwnerVersionRow only). */
export interface OwnerVersion {
  handle: string;
  projectId: string;
  projectName: string;
  label: string;
  rec: InstanceRecord;
  /** Its first share endpoint and port, when the copy can be shared at all. */
  endpoint: string | null;
  port: number | null;
  /** The serve a static endpoint runs as, or null. */
  serve: string | null;
  running: boolean;
}

/** Tests: a stand-in for "does this port answer now". */
let dialForTest: ((port: number) => Promise<boolean>) | null = null;
export function setVersionDialForTest(fn: ((port: number) => Promise<boolean>) | null): void {
  dialForTest = fn;
}
/** Tests: stand-in coding trees. */
let treesForTest: ((projectId: string) => Promise<CodingTree[]>) | null = null;
export function setVersionTreesForTest(fn: ((projectId: string) => Promise<CodingTree[]>) | null): void {
  treesForTest = fn;
}

/** Whether the main checkout is on master (q10: the current version is always master's). The trunk is
    `master`, or `main` in a repository with no `master` branch. A detached HEAD, another branch or no Git
    at all: no current version is offered (fail-closed: never a branch served as the current version). */
async function onMaster(root: string): Promise<boolean> {
  const head = await realGit(["symbolic-ref", "--quiet", "--short", "HEAD"], root);
  const branch = head.code === 0 ? head.stdout.trim() : "";
  if (branch === "master") return true;
  if (branch !== "main") return false;
  return (await realGit(["show-ref", "--verify", "--quiet", "refs/heads/master"], root)).code !== 0;
}

function defAt(dir: string): ProjectDef | null {
  const file = join(dir, CONTRACT_FILE);
  if (!existsSync(file)) return null;
  try {
    return parseDefinition(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

async function answers(port: number): Promise<boolean> {
  if (dialForTest) return dialForTest(port);
  const { dialLoopback } = await import("./share/preview-proxy");
  const s = await dialLoopback(port);
  if (s === "refused") return false;
  s.destroy();
  return true;
}

const dateWord = (iso: string): string => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** A project's versions, the current one first, then fixes oldest first. */
export async function projectVersions(orgId: string, project: { id: string; name: string; root?: string }): Promise<OwnerVersion[]> {
  if (!project.root) return [];
  const root = real(project.root);
  const mainDef = defAt(project.root);
  const recs = readRegistry().instances.filter((r) => real(r.project) === root);
  if (!recs.length) return [];
  const trees = await (treesForTest ?? projectTrees)(project.id).catch((): CodingTree[] => []);
  const fixTitle = new Map<string, string>();
  for (const r of orgRequests(orgId)) if (r.projectId === project.id && r.kind === "fix" && r.sessionId) fixTitle.set(r.sessionId, r.title);
  const out: OwnerVersion[] = [];
  let n = 0;
  const mainOnMaster = await onMaster(project.root);
  const ordered = [...recs].sort((a, b) => (real(a.checkout) === root ? -1 : real(b.checkout) === root ? 1 : a.createdAt.localeCompare(b.createdAt)));
  for (const rec of ordered) {
    const main = real(rec.checkout) === root;
    const tree = main ? null : treeHolding(trees, rec.checkout);
    // A copy of neither the main checkout nor a coding worktree (an operator's own branch) is not offered.
    if (!main && !tree) continue;
    // The main checkout on any other branch is not the current version: no row for it.
    if (main && !mainOnMaster) continue;
    const label = main ? "Current version" : fixTitle.has(tree!.sessionId) ? `Fix: ${fixTitle.get(tree!.sessionId)}` : `Fix ${++n} · started ${dateWord(rec.createdAt)}`;
    const def = defAt(rec.checkout) ?? mainDef;
    // Never a copy whose definition (or the main one's) refuses sharing or holds sensitive data.
    const refused = !def || shareRefusal(def) !== null || (mainDef !== null && holdsSensitive(mainDef));
    const endpoint = refused ? null : (def!.share!.endpoints[0] ?? null);
    const ep = endpoint && def ? endpointOf(def, rec, endpoint) : null;
    const serve = ep && ep.service.static !== undefined ? (staticServes().find((s) => s.port === ep.port)?.id ?? null) : null;
    const running = !!ep && rec.desired[ep.service.name] === "running" && (ep.service.static !== undefined ? serve !== null : await answers(ep.port));
    out.push({ handle: handleOf("v", rec.id), projectId: project.id, projectName: project.name, label, rec, endpoint: ep ? endpoint : null, port: ep?.port ?? null, serve, running });
  }
  return out;
}

/** The rows the owner page shows (§app.owner-page/never): the project's name, the operator's text, through
    the secret redactor only, as on every other row of the page; the label, which may carry a request title a
    model wrote, through the outsider filter too. Never the project's name through `said`: its phrases hold the
    org's name, so a project named after its org read `[redacted]`. */
export const versionRows = (vs: OwnerVersion[], r: { redact: (t: string) => string; said: (t: string) => string }): OwnerVersionRow[] =>
  vs.map((v) => ({ handle: v.handle, project: r.redact(v.projectName), label: r.redact(r.said(v.label)), state: v.running ? "running" : "not-running" }));

/** The owner-bound preview of a version for this owner link, kept or made now; its URL, or null when it can't be opened. */
export async function openVersion(v: OwnerVersion, link: { hash: string; expiresAt: string }, now = Date.now()): Promise<string | null> {
  if (!v.running || !v.endpoint || v.port === null) return null;
  const kept = keptPreviews();
  for (const view of listPreviews({ projectId: v.projectId }, now)) {
    const k = kept[view.id];
    if (view.state !== "active" || k?.owner !== link.hash || k.target.kind !== "instance" || k.target.instance !== v.rec.id || k.target.endpoint !== v.endpoint || view.port !== v.port) continue;
    if (k.url) return k.url;
  }
  const address = previewAddress();
  if (!address.url) return null;
  const left = Math.max(1, Math.ceil((Date.parse(link.expiresAt) - now) / 86_400_000));
  const ports = v.serve ? new Set([...sovaPorts()].filter((p) => p !== v.port)) : sovaPorts();
  const minted = (await awaitShareLinks(() => mintPreview({ projectId: v.projectId, port: v.port, days: Math.min(7, left), createdBy: "session:owner-page" }, ports, now))).result;
  // Exactly the owner link's deadline, never later.
  setPreviewExpiry(minted.record.id, Date.parse(link.expiresAt), now);
  const url = `${previewOrigin(address.url, minted.label)}/`;
  keepPreview(minted.record.id, {
    url,
    target: { kind: "instance", instance: v.rec.id, endpoint: v.endpoint, generation: v.rec.generation, ...(v.serve ? { serve: v.serve } : {}) },
    ...(v.rec.branch ? { branch: v.rec.branch } : {}),
    purpose: "Owner page version",
    owner: link.hash,
  });
  return url;
}

/** The owner link's deadline moved (a use): its owner-bound previews follow it exactly. */
export function followOwnerLink(hash: string, expiresAt: string, now = Date.now()): void {
  for (const [id, k] of Object.entries(keptPreviews())) if (k.owner === hash) setPreviewExpiry(id, Date.parse(expiresAt), now);
}

/** The owner links whose hashes are given stopped (rotated, turned off, owner changed or left, org detached): every owner-bound preview of theirs ends now. Returns how many. */
export function endOwnerPreviews(hashes: readonly string[], now = Date.now()): number {
  if (!hashes.length) return 0;
  const want = new Set(hashes);
  let n = 0;
  for (const [id, k] of Object.entries(keptPreviews()))
    if (k.owner && want.has(k.owner)) {
      const r = listPreviews({}, now).find((x) => x.id === id);
      if (r && r.state === "active") {
        revokePreview(id, now);
        n++;
      }
    }
  return n;
}

/** Whether a preview id is an owner-bound version (the Branches tab may say so). */
export const isOwnerVersion = (id: string): boolean => !!keptPreview(id)?.owner;
export { findPreviewByHash, previewState };

// Every owner-bound version follows its link: a use moves their deadline, a stop ends them.
onOwnerLinkEvent((e) => {
  if (e.kind === "ended") endOwnerPreviews(e.hashes);
  else followOwnerLink(e.hash, e.expiresAt);
});
