import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Context, Hono } from "hono";
import { adoptedService, CONTRACT_FILE, httpStatusOf, parseDefinition, type InstanceSummary, type ProjectDef, type ServiceView } from "../../shared/project-contract";
import { isStarting, SERVICES_UI_VERBS, type CopyView, type EntryView, type HostServicesView, type ProjectServicesView, type RunningProject, type ServiceRowView } from "../../shared/services-view";
import { OrgError } from "../org-error";
import { canonicalPath } from "../paths";
import { listProjects, readProject } from "../projects/spaces";
import { projectEngine } from "./routes";
import { readRegistry } from "./store";

/**
 * The Branches tab's and Running branches' routes (§app.project-services/services-ui):
 * `GET /api/projects/:pid/services` (the project's status, joined with its definitions),
 * `POST /api/projects/:pid/services/:verb` (one verb on the project as the operator, answered with the
 * status of its exit class) and `GET /api/services` (what runs on this host now, every project's).
 */

const NO_STORE = { "Cache-Control": "no-store" };

const handle =
  (fn: (c: Context) => Promise<Response>) =>
  async (c: Context): Promise<Response> => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof OrgError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  };

/** The definition at a checkout, or null (absent or invalid: the tab still lists what runs). */
function definitionAt(checkout: string): ProjectDef | null {
  const file = join(checkout, CONTRACT_FILE);
  if (!existsSync(file)) return null;
  try {
    return parseDefinition(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The unit slot 0 adopts under this definition (§app.project-services/adopt), else null. */
const adoptedUnit = (slot: number, def: ProjectDef | null): string | null => (slot === 0 && def ? (adoptedService(def)?.adopt?.unit ?? null) : null);

/** The copy's entry point under its own definition: the `open` endpoint's port among its checkout services' ports, else null. */
export function entryOf(services: readonly ServiceView[], def: ProjectDef | null): EntryView | null {
  if (!def?.open) return null;
  const { endpoint, path } = def.open;
  const dot = endpoint.indexOf(".");
  const port = services.find((s) => s.name === endpoint.slice(0, dot) && s.scope === "checkout")?.ports[endpoint.slice(dot + 1)];
  return port ? { endpoint, port, path } : null;
}

/** Each service with the port its readiness probes over HTTP (a static service's first port, at `/`). */
export function withHttp(services: ServiceView[], def: ProjectDef | null): ServiceRowView[] {
  return services.map((s) => {
    const d = def?.services.find((x) => x.name === s.name);
    if (!d) return s;
    if (d.ready && "http" in d.ready) {
      const port = s.ports[d.ready.http];
      return port ? { ...s, http: { port, path: d.ready.path } } : s;
    }
    if (d.static !== undefined) {
      const port = Object.values(s.ports)[0];
      return port ? { ...s, http: { port, path: "/" } } : s;
    }
    return s;
  });
}

/** The tab's view of a project's status: copies slot 0 first, the shared services once each. */
export function servicesView(projectId: string, root: string, instances: InstanceSummary[], defs: (checkout: string) => ProjectDef | null): Omit<ProjectServicesView, "supervisor"> {
  const main = defs(root);
  const shared = new Map<string, ServiceRowView>();
  const copies: CopyView[] = [];
  for (const i of [...instances].sort((a, b) => a.slot - b.slot)) {
    const def = defs(i.checkout);
    const rows = withHttp(i.services, def);
    for (const s of rows) if (s.scope === "shared" && !shared.has(s.name)) shared.set(s.name, s);
    const adopted = adoptedUnit(i.slot, def);
    const open = entryOf(i.services, def);
    copies.push({ ...i, services: rows.filter((s) => s.scope === "checkout"), ...(adopted ? { adopted } : {}), ...(open ? { open } : {}) });
  }
  return { projectId, root, sensitive: !!main?.data.some((d) => d.sensitive), copies, shared: [...shared.values()] };
}

const sumRss = (services: ServiceView[]): number | null => {
  const r = services.filter((s) => typeof s.rssBytes === "number");
  return r.length ? r.reduce((n, s) => n + s.rssBytes!, 0) : null;
};
const RUNNING_COPY = new Set(["running", "degraded"]);
const RUNNING_SERVICE = new Set(["ready", "starting", "degraded"]);

/** What runs now of one project's status: copies running or degraded, shared services up. */
export function runningOf(base: Omit<RunningProject, "copies" | "shared">, instances: InstanceSummary[], defs: (checkout: string) => ProjectDef | null = () => null): RunningProject | null {
  const copies = instances
    .filter((i) => RUNNING_COPY.has(i.state))
    .sort((a, b) => a.slot - b.slot)
    .map((i) => {
      const own = i.services.filter((s) => s.scope === "checkout");
      const def = defs(i.checkout);
      const adopted = adoptedUnit(i.slot, def);
      const open = entryOf(i.services, def);
      return {
        instance: i.instance,
        slot: i.slot,
        branch: i.branch,
        state: i.state,
        rssBytes: sumRss(own),
        createdBy: i.createdBy,
        ...(isStarting(i.state, own) ? { starting: true as const } : {}),
        ...(adopted ? { adopted } : {}),
        ...(open ? { open: { ...open, ready: own.some((s) => s.name === open.endpoint.slice(0, open.endpoint.indexOf(".")) && s.state === "ready") } } : {}),
      };
    });
  const shared = new Map<string, RunningProject["shared"][number]>();
  for (const i of instances)
    for (const s of i.services)
      if (s.scope === "shared" && RUNNING_SERVICE.has(s.state) && !shared.has(s.name)) shared.set(s.name, { name: s.name, state: s.state, rssBytes: s.rssBytes ?? null, via: i.instance });
  if (!copies.length && !shared.size) return null;
  return { ...base, copies, shared: [...shared.values()] };
}

async function statusOf(root: string): Promise<{ instances: InstanceSummary[]; supervisor: ProjectServicesView["supervisor"]; error?: string }> {
  const r = await projectEngine().run("status", { project: root }, { kind: "operator" });
  return { instances: r.instances ?? [], supervisor: r.checks?.find((c) => c.id === "supervisor") ?? null, ...(r.error ? { error: r.error.message } : {}) };
}

export function registerServicesViewRoutes(app: Hono<any>): void {
  app.get(
    "/api/projects/:pid/services",
    handle(async (c) => {
      const pid = c.req.param("pid") ?? "";
      const root = readProject(pid).root;
      const st = await statusOf(root);
      const view: ProjectServicesView = { ...servicesView(pid, root, st.instances, definitionAt), supervisor: st.supervisor, ...(st.error ? { error: st.error } : {}) };
      return c.json(view, 200, NO_STORE);
    }),
  );

  app.post(
    "/api/projects/:pid/services/:verb",
    handle(async (c) => {
      const verb = c.req.param("verb") ?? "";
      if (!(SERVICES_UI_VERBS as readonly string[]).includes(verb)) return c.json({ error: `The Branches tab doesn't run ${verb}.` }, 400);
      const root = readProject(c.req.param("pid") ?? "").root;
      const body = await c.req.json().catch(() => ({}));
      const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
      const r = await projectEngine().run(verb, { ...b, project: root }, { kind: "operator" });
      return c.json(r, httpStatusOf(r) as 200, NO_STORE);
    }),
  );

  app.get(
    "/api/services",
    handle(async (c) => {
      const projects = listProjects();
      const byRoot = new Map(projects.map((p) => [canonicalPath(p.root), p]));
      const roots = [...new Set(readRegistry().instances.filter((i) => !i.confined).map((i) => i.project))];
      const out: RunningProject[] = [];
      for (const root of roots) {
        const p = byRoot.get(canonicalPath(root));
        const st = await statusOf(root).catch(() => null);
        if (!st) continue;
        const base = p ? { projectId: p.id, name: p.name, root, ...(p.space.kind === "org" ? { orgName: p.space.orgName } : {}) } : { projectId: null, name: basename(root) || root, root };
        const run = runningOf(base, st.instances, definitionAt);
        if (run) out.push(run);
      }
      out.sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
      return c.json({ projects: out } satisfies HostServicesView, 200, NO_STORE);
    }),
  );
}
