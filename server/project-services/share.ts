import { portsFor, SHARE_DAYS_DEFAULT, SHARE_DAYS_MAX, type ErrorCode, type LinkView, type ProjectDef, type ServiceDecl } from "../../shared/project-contract";
import { keepPreview, keptPreview, type KeptPreview } from "../preview-kept";
import { listPreviews, mintPreview, PreviewRefused, renewPreview, revokePreview } from "../preview-links";
import { staticServes } from "../preview-serve";
import { awaitShareLinks } from "../share/links-events";
import { previewAddress, previewOrigin } from "../share/preview-address";
import { holdsSensitive, SENSITIVE_REFUSAL } from "./sensitive";
import { readRegistry, type InstanceRecord } from "./store";

/**
 * Share links to a running copy (§app.project-services/share): `share` mints a port preview
 * (§mesh.public/preview) of one declared endpoint of a running instance, kept in preview-kept.json with the
 * target `instance` (preview-links.json's keys never change); `revoke` ends them; teardown ends every one of
 * an instance's. A link is bound to the instance id and the endpoint (the generation is only recorded), so
 * it survives down, up and restarts; nothing here ever starts anything.
 */

/** A share or revoke refused: the engine answers it as that code. */
export class ShareFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ShareFailure";
  }
}

export const UNREGISTERED_REFUSAL = "Only a registered project's copies can be shared.";
export const OVERSEER_SHARE_REFUSAL = "The operator shares it from the project's Branches tab.";

/** Why no copy of this definition can be shared, or null. */
export function shareRefusal(def: ProjectDef): string | null {
  if (def.share?.allow === false) return "This project's definition says its copies are never shared (share.allow: false).";
  if (!def.share || !def.share.endpoints.length) return "This project's definition lists no share endpoints (share.endpoints), so its copies are never shared.";
  if (holdsSensitive(def)) return SENSITIVE_REFUSAL;
  return null;
}

/** The endpoint's service and its port in the instance's slot. */
export function endpointOf(def: ProjectDef, rec: Pick<InstanceRecord, "ports" | "slot">, endpoint: string): { service: ServiceDecl; port: number } | null {
  const [svc, p] = endpoint.split(".");
  const service = def.services.find((s) => s.name === svc);
  if (!service || !p || !(p in service.ports) || service.scope !== "checkout") return null;
  const port = rec.ports[service.name]?.[p] ?? portsFor(def, rec.slot)[service.name]?.[p];
  return port === undefined ? null : { service, port };
}

const stateOf = (s: "active" | "off" | "expired"): LinkView["state"] => (s === "off" ? "revoked" : s);

/** An instance's links (the originals, never a person's sibling), newest last; `url` only when `withUrl`. */
export function linksOf(instance: string, opts: { activeOnly?: boolean; withUrl?: boolean } = {}, now = Date.now()): LinkView[] {
  const out: LinkView[] = [];
  for (const v of listPreviews({}, now)) {
    if (v.siblingOf) continue;
    const kept = keptPreview(v.id);
    if (kept?.target.kind !== "instance" || kept.target.instance !== instance) continue;
    if (opts.activeOnly && v.state !== "active") continue;
    out.push(viewOf(v, kept, opts.withUrl ?? false));
  }
  return out;
}

function viewOf(v: { id: string; port: number; createdAt: string; expiresAt: string; state: "active" | "off" | "expired"; createdBy: string }, kept: KeptPreview, withUrl: boolean): LinkView {
  const t = kept.target as Extract<KeptPreview["target"], { kind: "instance" }>;
  return {
    id: v.id,
    instance: t.instance,
    endpoint: t.endpoint,
    port: v.port,
    createdAt: v.createdAt,
    expiresAt: v.expiresAt,
    state: stateOf(v.state),
    createdBy: v.createdBy,
    ...(withUrl && kept.url ? { url: kept.url } : {}),
  };
}

/** The instance a link belongs to (its kept target), or null when it is no share link. */
export function instanceOfLink(id: string): string | null {
  const kept = keptPreview(id);
  return kept?.target.kind === "instance" ? kept.target.instance : null;
}

/** Whether the endpoint's service answers now: a static copy's own serve on its port, else a listener on it. */
async function serving(serve: string | null, port: number): Promise<boolean> {
  if (serve) return staticServes().some((s) => s.id === serve && s.port === port);
  const { dialLoopback } = await import("../share/preview-proxy");
  const s = await dialLoopback(port);
  if (s === "refused") return false;
  s.destroy();
  return true;
}

export interface ShareInput {
  rec: InstanceRecord;
  def: ProjectDef;
  /** The registered project's id, null when the root is not registered. */
  projectId: string | null;
  endpoint: string | undefined;
  days: number | undefined;
  /** `operator`, or the caller's tag. */
  createdBy: string;
  /** The serve a static service runs as (its unit name), or null for a process service. */
  serveOf: (service: ServiceDecl) => string | null;
  /** Every port this Sova process binds or names (project-previews.ts sovaPorts). */
  sovaPorts: ReadonlySet<number>;
}

/** Every check a share makes before anything changes; the endpoint's service and port, and the days. */
export async function checkShare(i: Omit<ShareInput, "createdBy" | "sovaPorts">): Promise<{ service: ServiceDecl; port: number; days: number; serve: string | null }> {
  if (!i.projectId) throw new ShareFailure("share-denied", UNREGISTERED_REFUSAL);
  const refused = shareRefusal(i.def);
  if (refused) throw new ShareFailure("share-denied", refused);
  const listed = i.def.share!.endpoints;
  if (!i.endpoint) throw new ShareFailure("invalid-request", `name the endpoint to share (one of ${listed.join(", ")})`);
  const ep = listed.includes(i.endpoint) ? endpointOf(i.def, i.rec, i.endpoint) : null;
  if (!ep) throw new ShareFailure("share-denied", `${i.endpoint} is not one of this project's share endpoints (${listed.join(", ")}).`);
  const max = i.def.share!.maxDays ?? SHARE_DAYS_MAX;
  const days = i.days ?? Math.min(SHARE_DAYS_DEFAULT, max);
  if (!Number.isInteger(days) || days < 1 || days > max) throw new ShareFailure("invalid-request", `a running copy's link lasts 1 to ${max} day${max === 1 ? "" : "s"}`);
  const serve = ep.service.static !== undefined ? i.serveOf(ep.service) : null;
  if (i.rec.desired[ep.service.name] !== "running" || !(await serving(serve, ep.port)))
    throw new ShareFailure("share-denied", `This copy isn't running ${ep.service.name}: start it first (up); sharing never starts anything.`);
  return { ...ep, days, serve };
}

/** Share one endpoint of a running copy: its active link again (expiry moved to the later), else a new one. With its url. */
export async function shareInstance(i: ShareInput, now = Date.now()): Promise<{ link: LinkView; changed: boolean }> {
  const c = await checkShare(i);
  const same = linksOf(i.rec.id, { activeOnly: true, withUrl: true }, now).find((l) => l.endpoint === i.endpoint);
  if (same) {
    const before = same.expiresAt;
    const r = renewPreview(same.id, c.days, now);
    return { link: { ...same, expiresAt: r?.expiresAt ?? before }, changed: (r?.expiresAt ?? before) !== before };
  }
  const address = previewAddress();
  if (!address.url) throw new ShareFailure("share-denied", address.message ?? "No preview address is set.");
  // A static copy's own serve holds its port: that one port is not "Sova's own" for its link.
  const ports = c.serve ? new Set([...i.sovaPorts].filter((p) => p !== c.port)) : i.sovaPorts;
  let minted: ReturnType<typeof mintPreview>;
  try {
    minted = (await awaitShareLinks(() => mintPreview({ projectId: i.projectId!, port: c.port, days: c.days, createdBy: i.createdBy }, ports, now))).result;
  } catch (err) {
    if (err instanceof PreviewRefused) throw new ShareFailure("share-denied", err.message);
    throw err;
  }
  const kept: KeptPreview = {
    url: `${previewOrigin(address.url, minted.label)}/`,
    target: { kind: "instance", instance: i.rec.id, endpoint: i.endpoint!, generation: i.rec.generation, ...(c.serve ? { serve: c.serve } : {}) },
    ...(i.rec.branch ? { branch: i.rec.branch } : {}),
  };
  keepPreview(minted.record.id, kept);
  return { link: viewOf({ ...minted.record, state: "active" }, kept, true), changed: true };
}

/** End links: one by id, or an instance's (only its endpoint's when given). Each person's sibling ends with it. The ended ones, without url. */
export function revokeLinks(sel: { link?: string; instance?: string; endpoint?: string }, now = Date.now()): { links: LinkView[]; changed: boolean } {
  const all = sel.link ? listPreviews({}, now).filter((v) => v.id === sel.link) : [];
  const targets = sel.link
    ? all.filter((v) => !v.siblingOf && instanceOfLink(v.id) !== null)
    : linksOf(sel.instance ?? "", {}, now).filter((l) => !sel.endpoint || l.endpoint === sel.endpoint);
  if (sel.link && !targets.length) throw new ShareFailure("not-found", `no share link ${sel.link}`);
  let changed = false;
  const out: LinkView[] = [];
  for (const t of targets) {
    const wasActive = listPreviews({}, now).some((v) => v.id === t.id && v.state === "active") || listPreviews({}, now).some((v) => v.siblingOf === t.id && v.state === "active");
    revokePreview(t.id, now);
    changed ||= wasActive;
    const v = listPreviews({}, now).find((x) => x.id === t.id)!;
    out.push(viewOf(v, keptPreview(t.id)!, false));
  }
  return { links: out, changed };
}

/** The project overseer's share, as its statechart's `services/share` effect runs it (taken, or released from its hold): every check again, then the link. Returns its id only (an effect's result is logged). */
export async function shareFromAct(a: { projectId: string; instance: string; endpoint: string; days?: number; overseerId: string }): Promise<{ id: string }> {
  const rec = readRegistry().instances.find((r) => r.id === a.instance);
  if (!rec) throw new Error(`No running copy ${a.instance}: it was torn down.`);
  const { listProjects } = await import("../projects/spaces");
  if (listProjects().find((p) => p.id === a.projectId)?.root !== rec.project) throw new Error(`${a.instance} is not a copy of this project.`);
  const { projectEngine } = await import("./routes");
  const r = await projectEngine().run(
    "share",
    { instance: a.instance, endpoint: a.endpoint, ...(a.days !== undefined ? { days: a.days } : {}) },
    { kind: "project-overseer", id: a.overseerId || "overseer", root: rec.project, act: async () => undefined },
  );
  if (r.error) throw new Error(r.error.message);
  const id = r.links[0]?.id;
  if (!id) throw new Error("The link was made, but it can't be read back.");
  return { id };
}

/**
 * Whether a share endpoint answers through the preview proxy's own request path, in this process, with no
 * link minted (§app.project-services/conform, suite 3): a GET of `/` as a visitor's would reach the app,
 * answered below 500. The proxy's own refusals (nothing listening, a Sova port) are 502s, so they fail it.
 */
export async function endpointAnswers(port: number, timeoutMs = 10_000): Promise<{ ok: boolean; detail: string }> {
  const { createServer, request } = await import("node:http");
  const { createPreviewProxy } = await import("../share/preview-proxy");
  const label = "c".repeat(52);
  const now = Date.now();
  const record = { id: "pv_conformendpoints", hash: "0".repeat(64), projectId: "conform", port, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(), createdBy: "operator" };
  const proxy = createPreviewProxy({ find: () => record, findByHash: () => record, origin: (l) => `http://${l}.conform.invalid`, dialable: () => true, sweepMs: 0 });
  const server = createServer((req, res) => proxy.dispatch(req, res, label));
  try {
    await new Promise<void>((ok, fail) => {
      server.once("error", fail);
      server.listen(0, "127.0.0.1", () => ok());
    });
    const at = (server.address() as { port: number }).port;
    const status = await new Promise<number>((ok, fail) => {
      // Not a navigation: the host's visitor log never records it.
      const q = request({ host: "127.0.0.1", port: at, path: "/", method: "GET", headers: { host: `${label}.conform.invalid`, accept: "*/*" }, timeout: timeoutMs }, (r) => {
        r.resume();
        ok(r.statusCode ?? 0);
      });
      q.on("timeout", () => q.destroy(new Error(`no answer in ${timeoutMs / 1000}s`)));
      q.on("error", fail);
      q.end();
    });
    return { ok: status > 0 && status < 500, detail: `GET / through the preview proxy answered ${status}` };
  } catch (err) {
    return { ok: false, detail: `GET / through the preview proxy failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    proxy.dispose();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}
