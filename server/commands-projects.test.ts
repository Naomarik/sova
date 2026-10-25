// Run: pnpm test -- server/commands-projects.test.ts
// The projects sweep (§app.project-commands/projects-sweep) against the real app, in-process: each
// entry builds exactly the request the web app's own control sends (src/lib/api.ts), so its answer
// is the route's own on the same fixture, refusals word for word, and an entry that changes
// something changes it as the route does. A throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or
// written. Nothing here starts a chat or connects to a port.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { buildRequest, COMMANDS, findCommand } from "../shared/commands-catalog";

const agentDir = mkdtempSync(join(tmpdir(), "sova-commands-projects-"));
/** The folders registered as projects: never inside Sova's own state. */
const folders = mkdtempSync(join(tmpdir(), "sova-commands-projects-folders-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const { testApp } = await import("./mesh/app-test-fixtures");
const app = await testApp();
const { canonicalPath } = await import("./paths");
after(() => {
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(folders, { recursive: true, force: true });
});

const SWEEP = [
  "project.list",
  "project.get",
  "project.create",
  "project.update",
  "project.archive",
  "project.unarchive",
  "project.preview.off",
  "project.worktree.list",
  "project.worktree.merge",
  "project.worktree.remove",
  "project.files.list",
  "project.costs",
];

async function send(method: string, url: string, body?: unknown): Promise<[number, unknown]> {
  const res = await app.request(url, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  return [res.status, await res.json()];
}
const entry = (id: string) => findCommand(id)!;
const via = (id: string, values: Record<string, unknown>) => {
  const r = buildRequest(entry(id), values);
  return send(r.method, r.url, r.body);
};

let n = 0;
/** A fresh folder registered as a project: its id and root. */
async function project(): Promise<{ pid: string; root: string }> {
  const root = join(folders, `folder-${++n}`);
  mkdirSync(root, { recursive: true });
  const [status, body] = await send("POST", "/api/projects", { root });
  assert.equal(status, 201, JSON.stringify(body));
  return { pid: (body as { project: { id: string } }).project.id, root };
}

/** What src/lib/api.ts sends for each sweep entry, by the same values. */
const WEB: Record<string, (v: Record<string, unknown>) => { method: string; url: string; body?: unknown }> = {
  "project.list": () => ({ method: "GET", url: "/api/projects" }),
  "project.get": (v) => ({ method: "GET", url: `/api/projects/${encodeURIComponent(String(v.pid))}` }),
  // Add Project sends the folder, Clone from GitHub the clone: one of the two.
  "project.create": (v) => ({ method: "POST", url: "/api/projects", body: v.clone !== undefined ? { clone: v.clone } : { root: v.root } }),
  "project.update": (v) => ({ method: "PATCH", url: `/api/projects/${v.pid}`, body: { name: v.name, root: v.root } }),
  "project.archive": (v) => ({ method: "POST", url: `/api/projects/${v.pid}/archive`, body: {} }),
  "project.unarchive": (v) => ({ method: "POST", url: `/api/projects/${v.pid}/unarchive`, body: {} }),
  "project.preview.off": (v) => ({ method: "POST", url: `/api/previews/${v.id}/off`, body: {} }),
  "project.worktree.list": (v) => ({ method: "GET", url: `/api/projects/${v.pid}/overseer/worktrees` }),
  "project.worktree.merge": (v) => ({ method: "POST", url: `/api/projects/${v.pid}/overseer/worktrees/merge`, body: { sessionId: v["session-id"] } }),
  "project.worktree.remove": (v) => ({ method: "POST", url: `/api/projects/${v.pid}/overseer/worktrees/remove`, body: { sessionId: v["session-id"] } }),
  "project.files.list": (v) => ({ method: "GET", url: `/api/projects/${v.pid}/files` }),
  "project.costs": (v) => ({ method: "GET", url: `/api/projects/${v.pid}/costs${v.fresh ? "?fresh=1" : ""}` }),
};
/** One full set of values per entry: every param it has. */
const VALUES: Record<string, Record<string, unknown>> = {
  "project.list": {},
  "project.get": { pid: "prj_abc" },
  "project.create": { root: "/srv/folder", clone: undefined },
  "project.update": { pid: "prj_abc", name: "New name", root: "/srv/elsewhere" },
  "project.archive": { pid: "prj_abc" },
  "project.unarchive": { pid: "prj_abc" },
  "project.preview.off": { id: "pv_abc" },
  "project.worktree.list": { pid: "prj_abc" },
  "project.worktree.merge": { pid: "prj_abc", "session-id": "s1" },
  "project.worktree.remove": { pid: "prj_abc", "session-id": "s1" },
  "project.files.list": { pid: "prj_abc" },
  "project.costs": { pid: "prj_abc", fresh: "1" },
};

describe("the projects sweep", () => {
  test("every sweep id is in the catalogue, in the projects area, and the kept file's download is not", () => {
    for (const id of SWEEP) assert.ok(findCommand(id), id);
    assert.deepEqual(COMMANDS.filter((c) => c.route.path === "/api/projects/:pid/files/:id").map((c) => c.id), []);
  });

  test("nothing that hands out a preview link: no mint, no extension, no list of live links; only turning one off", () => {
    // A preview link lets someone outside this machine reach a local app, and the lists carry live
    // links (bearer secrets): granting that is the operator's, on the page, never a command.
    const handsOut = (c: { route: { method: string; path: string } }) =>
      (c.route.method === "POST" && (c.route.path === "/api/previews" || c.route.path === "/api/previews/:id/extend")) ||
      (c.route.method === "GET" && (c.route.path === "/api/previews" || c.route.path === "/api/projects/:pid/previews"));
    assert.deepEqual(COMMANDS.filter(handsOut).map((c) => c.id), []);
    assert.deepEqual(COMMANDS.filter((c) => c.route.path.startsWith("/api/previews")).map((c) => c.id), ["project.preview.off"]);
  });

  test("each entry's request is the web app's own, param for param", () => {
    for (const id of SWEEP) {
      const v = VALUES[id]!;
      assert.deepEqual(Object.keys(entry(id).params).sort(), Object.keys(v).sort(), `${id}: the values name every param (undefined: the other of two)`);
      assert.deepEqual(buildRequest(entry(id), v), WEB[id]!(v), id);
    }
    const clone = { clone: { repo: "https://github.com/o/r", parent: "/srv", folder: "r" } };
    assert.deepEqual(buildRequest(entry("project.create"), clone), WEB["project.create"]!(clone));
  });
});

describe("answers: the route's own, on the same fixture", () => {
  test("reads answer as their route does; a missing project is the route's own 404", async () => {
    const { pid } = await project();
    for (const id of ["project.list", "project.get", "project.worktree.list", "project.files.list"]) {
      for (const p of [pid, "prj_missing0"]) {
        const v = id === "project.list" ? {} : { pid: p };
        const w = WEB[id]!(v);
        assert.deepEqual(await via(id, v), await send(w.method, w.url), `${id} ${p}`);
      }
    }
    // The cost card answers 404 for a project that isn't one before it asks the usage helper.
    assert.deepEqual(await via("project.costs", { pid: "prj_missing0" }), await send("GET", "/api/projects/prj_missing0/costs"));
    assert.equal((await via("project.costs", { pid: "prj_missing0" }))[0], 404);
  });

  test("refusals are the route's own, word for word", async () => {
    const { pid, root } = await project();
    const cases: [string, Record<string, unknown>][] = [
      ["project.create", { root }],
      ["project.create", { root: join(folders, "no-such-folder") }],
      ["project.create", { clone: { repo: "not a repository" } }],
      ["project.update", { pid, name: "" }],
      ["project.update", { pid: "prj_missing0", name: "x" }],
      ["project.unarchive", { pid: "prj_missing0" }],
      ["project.preview.off", { id: "pv_missing" }],
      ["project.worktree.merge", { pid, "session-id": "s1" }],
      ["project.worktree.remove", { pid, "session-id": "s1" }],
    ];
    for (const [id, v] of cases) {
      const w = WEB[id]!(v);
      const mine = await via(id, v);
      assert.ok(mine[0] >= 400 && mine[0] < 500, `${id} ${JSON.stringify(v)}: ${JSON.stringify(mine)}`);
      assert.deepEqual(mine, await send(w.method, w.url, w.body), `${id} ${JSON.stringify(v)}`);
    }
  });
});

describe("changes: the route's own effect", () => {
  test("create registers the folder; update renames; archive and unarchive put it away and back", async () => {
    const root = join(folders, "made-by-entry");
    mkdirSync(root);
    const [status, body] = await via("project.create", { root });
    assert.equal(status, 201, JSON.stringify(body));
    const pid = (body as { project: { id: string } }).project.id;
    assert.equal(((await send("GET", `/api/projects/${pid}`))[1] as { root: string }).root, canonicalPath(root));

    assert.equal((await via("project.update", { pid, name: "Renamed by an entry" }))[0], 200);
    assert.equal(((await send("GET", `/api/projects/${pid}`))[1] as { name: string }).name, "Renamed by an entry");

    assert.equal((await via("project.archive", { pid }))[0], 200);
    assert.ok(((await send("GET", `/api/projects/${pid}`))[1] as { archived?: unknown }).archived);
    assert.equal((await via("project.unarchive", { pid }))[0], 200);
    assert.equal(((await send("GET", `/api/projects/${pid}`))[1] as { archived?: unknown }).archived, undefined);
  });
});
