// Run: pnpm exec tsx --test server/project-previews.test.ts. A project's preview links
// (§app.project-overseer/previews, §mesh.public/preview, /preview-serve) against the real engine host and
// routes: the overseer's guard (L1, the hold, the operator's turn), the target checks, the kept link and
// where it may go, the worktree match, and folder previews across a restart. Throwaway workspace and
// PI_CODING_AGENT_DIR; the preview address is pinned by env; no model is called; ~/.pi untouched.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { Hono } from "hono";
import type { PreviewList, PreviewMinted } from "../shared/preview-links";
import type { PortOwner } from "./port-owner";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-po-previews-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.SOVA_SHARE_PREVIEW_URL = "https://*.preview.example.invalid";
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
symlinkSync(resolve(import.meta.dirname, "..", "pi-config", "extensions"), join(agentDir, "extensions"));

const orgs = await import("./orgs");
const po = await import("./project-overseer");
const store = await import("./project-overseer-store");
const { registerOrgRoutes } = await import("./org-routes");
const { mountPreviewLinks } = await import("./preview-links-routes");
const { disposeAllChats } = await import("./chat-manager");
const { settled } = await import("./workspace-git");
const { holdRef, hostOf, setOrgClockForTest } = await import("./org-engine");
const { fakeLooks } = await import("./org-test-fixtures");
const previews = await import("./project-previews");
const kept = await import("./preview-kept");
const links = await import("./preview-links");
const { stopStaticServe, staticServes } = await import("./preview-serve");
const { createPreviewProxy } = await import("./share/preview-proxy");
const { PREVIEW_IN_GATHERING, previewLinkFree } = await import("./project-overseer-tools");

after(async () => {
  for (const s of staticServes()) await stopStaticServe(s.id);
  previews.setPreviewDepsForTest(null);
  await disposeAllChats();
  await settled(join(root, "ws"));
});

const org = await orgs.createOrg({ name: "Shopfront", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
const project = await orgs.addProject(org.id, { name: "Shop", root: join(root, "proj") });
await orgs.addPerson(org.id, { name: "Ana Ruiz", role: "Owner", decides: ["shop"] });
await po.ensureProjectOverseer(org.id, project.id);
fakeLooks(org.id);
const app = new Hono();
registerOrgRoutes(app);
mountPreviewLinks(app);

// A coding session's worktree: built files, and what must never be served.
const wt = join(root, ".worktrees", "proj-shop-abc123");
mkdirSync(join(wt, "dist", "assets"), { recursive: true });
writeFileSync(join(wt, "dist", "index.html"), "<h1>Shop</h1>");
writeFileSync(join(wt, "dist", "assets", "app.js"), "console.log(1)");
mkdirSync(join(wt, "dist", ".git"));
writeFileSync(join(wt, "dist", ".git", "config"), "[core]");
writeFileSync(join(wt, "dist", ".env"), "SECRET=1");
mkdirSync(join(wt, ".git"));
mkdirSync(join(root, "outside"));
writeFileSync(join(root, "outside", "secret.txt"), "outside");
symlinkSync(join(root, "outside"), join(wt, "dist", "out"));
const tree = { sessionId: "c-shop", branch: "sova/shop-abc123", path: wt, title: "Shop front", sessionPath: null };
let owner: PortOwner = "none";
previews.setPreviewDepsForTest({ trees: async () => [tree], owner: () => owner });

const tools = (attended: boolean) => po.toolsForTest(org.id, project.id, { attended });
const run = (name: string, params: Record<string, unknown>, attended = false) => {
  const t = tools(attended).find((x) => x.name === name);
  assert.ok(t, name);
  return t.execute("call-1", params as never, undefined, undefined, undefined as never) as Promise<{ content: { text: string }[]; details: Record<string, unknown> }>;
};
const settings = (patch: Parameters<typeof po.patchProjectOverseer>[2]) => po.patchProjectOverseer(org.id, project.id, patch);
const holdsOf = () => hostOf(org.id).holds().filter((h) => (h.projectId ?? h.sessionId.split("/")[2]) === project.id).map((h) => ({ ...h, id: holdRef(h) }));
const cancel = (id: string) => app.request(`/api/orgs/${org.id}/held/${encodeURIComponent(id)}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const mine = () => links.listPreviews({ orgId: org.id, projectId: project.id });
const list = async () => ((await (await app.request(`/api/previews?orgId=${org.id}&projectId=${project.id}`)).json()) as PreviewList).previews;
const labelOf = (url: string) => new URL(url).hostname.split(".")[0]!;
const folderStart = { op: "start", session: "c-shop", folder: "dist", purpose: "The shop for Ana" };

/** A preview proxy on a local server: requests go to the preview a label names, as the share listener's Host split does. */
let proxyServer: Server;
let proxyPort = 0;
const proxy = createPreviewProxy({ origin: (l) => `https://${l}.preview.example.invalid`, sweepMs: 0 });
before(async () => {
  proxyServer = createServer((req, res) => proxy.dispatch(req, res, String(req.headers["x-test-label"])));
  await new Promise<void>((r) => proxyServer.listen(0, "127.0.0.1", () => r()));
  proxyPort = (proxyServer.address() as { port: number }).port;
});
after(() => {
  proxy.dispose();
  proxyServer.close();
});
const fetchVia = (label: string, path: string): Promise<{ status: number; body: string }> =>
  new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port: proxyPort, path, headers: { "x-test-label": label, accept: "text/html" } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => ok({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", fail);
    req.end();
  });

describe("the overseer's guard: L1, the hold, the operator's turn (§app.project-overseer/previews)", () => {
  test("below L1 in a run of its own: the statechart's refusal; nothing is made or held", async () => {
    await settings({ autonomy: "L0", holdMin: 10 });
    await assert.rejects(() => run("sova_preview", folderStart), /This run was not started by the operator, and your autonomy here is L0; sova_preview needs L1\./);
    assert.equal(holdsOf().length, 0);
    assert.equal(mine().length, 0);
  });

  test("at L1 in a run of its own: it waits in the hold, cancellable by the operator; nothing is made", async () => {
    await settings({ autonomy: "L1", holdMin: 10 });
    const out = await run("sova_preview", folderStart);
    assert.match(out.content[0]!.text, /^Held: the preview link "The shop for Ana" waits until .* so the operator can cancel it/);
    const h = holdsOf();
    assert.equal(h.length, 1);
    assert.equal(out.details.held, h[0]!.id);
    assert.equal(h[0]!.what, "A preview link: The shop for Ana");
    assert.equal(mine().length, 0, "not before the hold ends");
    const r = await cancel(h[0]!.id);
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(holdsOf().length, 0);
    assert.equal(mine().length, 0, "cancelled: never made");
  });

  test("released when its hold ends (preview not on the confirm list): it is made then", async () => {
    await settings({ autonomy: "L1", holdMin: 10, confirmKinds: [] });
    const t0 = Date.now() + 2 * 86_400_000;
    setOrgClockForTest(() => t0);
    try {
      await run("sova_preview", folderStart);
      assert.equal(mine().length, 0);
      setOrgClockForTest(() => t0 + 10 * 60_000);
      hostOf(org.id).fireDue();
      for (let i = 0; i < 50 && !mine().length; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(mine().length, 1, "the hold ended: minted");
      const [v] = await list();
      assert.equal(v!.createdBy.startsWith("session:"), true);
      assert.ok(v!.url, "its link is kept");
      await previews.turnOffPreview(v!.id);
    } finally {
      setOrgClockForTest(null);
      await settings({ confirmKinds: [...store.defaultPoSettings().confirmKinds] });
    }
  });

  test("with preview on the confirm list, its hold waits for the overseer's approval past its end", async () => {
    await settings({ autonomy: "L1", holdMin: 10 });
    assert.ok(store.readPoSettings(store.projectOverseerPaths(org.id, project.id)).confirmKinds.includes("preview"));
    const before = mine().length;
    const t0 = Date.now() + 4 * 86_400_000;
    setOrgClockForTest(() => t0);
    try {
      await run("sova_preview", folderStart);
      setOrgClockForTest(() => t0 + 11 * 60_000);
      hostOf(org.id).fireDue();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(mine().length, before, "unapproved: still waiting");
      assert.equal(holdsOf().length, 1);
      await cancel(holdsOf()[0]!.id);
    } finally {
      setOrgClockForTest(null);
    }
  });

  test("in the operator's own turn it runs at once, even at L0; the result is the fixed shape, never the link", async () => {
    await settings({ autonomy: "L0", holdMin: 10 });
    const out = await run("sova_preview", folderStart, true);
    assert.equal(holdsOf().length, 0, "never held in the operator's turn");
    const p = out.details.preview as Record<string, unknown>;
    assert.deepEqual(Object.keys(p).sort(), ["branch", "createdBy", "expiresAt", "id", "linkKept", "orgId", "projectId", "purpose", "running", "sessionId", "state", "target", "v"]);
    assert.deepEqual([p.v, p.sessionId, p.branch, p.state, p.running, p.purpose], [1, "c-shop", "sova/shop-abc123", "active", true, "The shop for Ana"]);
    assert.deepEqual(p.target, { kind: "static", folder: "dist" });
    assert.equal(p.linkKept, true);
    const url = (await list()).find((v) => v.id === p.id)!.url!;
    assert.match(url, /^https:\/\/[a-z2-7]{52}\.preview\.example\.invalid\/$/, "kept, for the operator's list");
    assert.ok(!JSON.stringify(out).includes(labelOf(url)), "never in the overseer's result");
  });

  test("turning one off is never held: at L0, in a run of its own, at once", async () => {
    await settings({ autonomy: "L0", holdMin: 10 });
    const id = mine().find((v) => v.state === "active")!.id;
    const out = await run("sova_preview", { op: "off", id });
    assert.equal(holdsOf().length, 0);
    assert.equal((out.details.preview as { state: string }).state, "off");
    assert.equal(links.listPreviews({ orgId: org.id, projectId: project.id }).find((v) => v.id === id)!.state, "off");
    assert.ok(!staticServes().some((s) => s.id === id), "its folder is no longer served");
    await assert.rejects(() => run("sova_preview", { op: "off", id: "pv_ZZZZZZZZZZZZZZZZ" }), /No preview pv_ZZZZZZZZZZZZZZZZ in this project/);
  });
});

describe("what it may show (§mesh.public/preview-serve)", () => {
  test("a port only when the program listening there runs from a worktree of the project's coding sessions", async () => {
    await settings({ autonomy: "L1", holdMin: 0 });
    const start = { op: "start", session: "c-shop", port: 5173, purpose: "The shop for Ana" };
    owner = "none";
    await assert.rejects(() => run("sova_preview", start, true), /Nothing listens on port 5173\. Have its coding session start the app first\./);
    owner = "unknown";
    await assert.rejects(() => run("sova_preview", start, true), /Sova can't tell which program listens on port 5173/);
    owner = { pid: 42, cwd: join(root, "outside") };
    await assert.rejects(() => run("sova_preview", start, true), /Port 5173 isn't served from a worktree of this project's coding sessions\./);
    await assert.rejects(() => run("sova_preview", { ...start, port: 4800 }, true), /Port 4800 is Sova's own, so it can't be previewed\./);
    assert.equal(mine().filter((v) => v.port === 5173).length, 0);
    owner = { pid: 42, cwd: join(wt, "dist") };
    const out = await run("sova_preview", start, true);
    assert.deepEqual((out.details.preview as { target: unknown }).target, { kind: "port", port: 5173 });
    await previews.turnOffPreview((out.details.preview as { id: string }).id);
  });

  test("a folder of its worktree: never a dot-folder, never outside it, never another session's", async () => {
    await assert.rejects(() => run("sova_preview", { ...folderStart, folder: "dist/.git" }, true), /A folder whose name starts with a dot \(\.git, \.sova, …\) is never served\./);
    await assert.rejects(() => run("sova_preview", { ...folderStart, folder: ".git" }, true), /starts with a dot/);
    await assert.rejects(() => run("sova_preview", { ...folderStart, folder: "dist/out" }, true), /outside its worktree/);
    await assert.rejects(() => run("sova_preview", { ...folderStart, folder: "../../outside" }, true), /outside its worktree/);
    await assert.rejects(() => run("sova_preview", { ...folderStart, folder: "nope" }, true), /No folder nope in its worktree\./);
    await assert.rejects(() => run("sova_preview", { ...folderStart, session: "c-other" }, true), /No coding session c-other of this project has a worktree on this host\./);
    await assert.rejects(() => run("sova_preview", { ...folderStart, purpose: " " }, true), /Say what it shows and to whom \(purpose\): one line\./);
  });

  test("through the preview: the folder's files, never a dot-file, a symlink out or a listing; another program on its port is never shown", async () => {
    const out = await run("sova_preview", folderStart, true);
    const p = out.details.preview as { id: string };
    const label = labelOf((await list()).find((v) => v.id === p.id)!.url!);
    assert.deepEqual(await fetchVia(label, "/"), { status: 200, body: "<h1>Shop</h1>" });
    assert.equal((await fetchVia(label, "/assets/app.js")).status, 200);
    for (const path of ["/.git/config", "/.env", "/%2egit/config", "/out/secret.txt", "/assets/", "/../outside/secret.txt", "/assets/%2e%2e/.env"]) assert.equal((await fetchVia(label, path)).status, 404, path);
    // A restart: the serve is gone; the preview answers not running until it is bound again.
    const port = links.listPreviews({}).find((v) => v.id === p.id)!.port;
    await stopStaticServe(p.id);
    assert.equal((await fetchVia(label, "/")).status, 502);
    // Another program takes the port: it is never shown, and the rebind fails.
    const intruder = createServer((_q, s) => s.end("intruder"));
    await new Promise<void>((r) => intruder.listen(port, "127.0.0.1", () => r()));
    try {
      const r1 = await previews.rebindStaticPreviews();
      assert.ok(r1.failed.includes(p.id));
      const seen = await fetchVia(label, "/");
      assert.equal(seen.status, 502);
      assert.ok(!seen.body.includes("intruder"));
    } finally {
      await new Promise<void>((r) => intruder.close(() => r()));
    }
    // The port is free again: bound on its recorded port, serving as before.
    const r2 = await previews.rebindStaticPreviews();
    assert.ok(r2.bound.includes(p.id));
    assert.equal(staticServes().find((s) => s.id === p.id)?.port, port);
    assert.deepEqual(await fetchVia(label, "/"), { status: 200, body: "<h1>Shop</h1>" });
    await previews.turnOffPreview(p.id);
    assert.equal((await fetchVia(label, "/")).status, 410);
  });

  test("a port preview's port is refused when Sova serves a folder on it", async () => {
    const out = await run("sova_preview", folderStart, true);
    const port = links.listPreviews({}).find((v) => v.id === (out.details.preview as { id: string }).id)!.port;
    const r = await app.request("/api/previews", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgId: org.id, projectId: project.id, port }) });
    assert.equal(r.status, 400);
    assert.equal(((await r.json()) as { code: string }).code, "forbidden-port");
    await previews.turnOffPreview((out.details.preview as { id: string }).id);
  });
});

describe("the kept link is a secret (§mesh.public/preview, §app.project-overseer/previews)", () => {
  test("kept 0600 beside preview-links.json, whose keys never change; only its hash there", async () => {
    const r = await app.request("/api/previews", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgId: org.id, projectId: project.id, sessionId: "c-shop", folder: "dist", purpose: "For Ana" }) });
    assert.equal(r.status, 200, await r.clone().text());
    const made = (await r.json()) as PreviewMinted;
    const label = labelOf(made.url);
    assert.equal(statSync(kept.previewKeptFile()).mode & 0o777, 0o600);
    assert.ok(readFileSync(kept.previewKeptFile(), "utf8").includes(made.url));
    const linksText = readFileSync(links.previewLinksFile(), "utf8");
    assert.ok(!linksText.includes(label), "preview-links.json never holds the label");
    for (const l of (JSON.parse(linksText) as { links: Record<string, unknown>[] }).links) assert.deepEqual(Object.keys(l).filter((k) => !["id", "hash", "orgId", "projectId", "port", "createdAt", "expiresAt", "revokedAt", "createdBy"].includes(k)), []);
    assert.ok(links.validatePreviewFile(JSON.parse(linksText)) && !("why" in links.validatePreviewFile(JSON.parse(linksText))), "an older Sova still reads it");
    assert.equal((await list()).find((v) => v.id === made.preview.id)?.url, made.url, "the operator's list carries it");
    // Never through the peer listener or a peer's relay; a reverse proxy in front of this host is served.
    const listPath = `/api/previews?orgId=${org.id}&projectId=${project.id}`;
    assert.equal((await app.request(listPath, { headers: { "x-sova-relayed": "1", "x-forwarded-host": "x" } })).status, 404);
    assert.equal((await app.request(listPath, {}, { meshPeer: { id: "p" } })).status, 404);
    assert.equal((await app.request(listPath, { headers: { "x-forwarded-host": "host.example.ts.net:8443" } })).status, 200);
  });

  test("never in an owner update or a gathering's texts; the session list shows [preview link] in its place", async () => {
    const [v] = (await list()).filter((x) => x.url);
    const url = v!.url!;
    assert.equal(po.ownerUpdateLeak(org.id, project.id, `See it at ${url}`), po.PREVIEW_IN_OWNER_UPDATE);
    assert.equal(po.ownerUpdateLeak(org.id, project.id, `See it at ${labelOf(url)}`), po.PREVIEW_IN_OWNER_UPDATE);
    await assert.rejects(() => run("sova_start_gathering", { gap: "none", person: "Ana Ruiz", why: "She should see it.", public_title: "The shop", goal: "Ana's view", question: `Does ${url} look right?` }, true), new RegExp(PREVIEW_IN_GATHERING.replace(/[.?]/g, "\\$&")));
    const row = { id: "s1", title: `Preview at ${url}`, outline: { now: `made ${url} for Ana` }, cwd: "/x" };
    const shown = kept.redactPreviewLinksDeep(row);
    assert.equal(shown.title, "Preview at [preview link]");
    assert.equal(shown.outline.now, "made [preview link] for Ana");
    assert.ok(!JSON.stringify(shown).includes(labelOf(url)));
    assert.equal(kept.redactPreviewLinksDeep({ title: "nothing here" }).title, "nothing here");
  });

  test("no overseer tool result or error carries a kept link, even text that holds one", async () => {
    const urls = (await list()).map((v) => v.url).filter(Boolean) as string[];
    assert.ok(urls.length);
    const seen: string[] = [];
    for (const [name, params] of [
      ["sova_previews", {}],
      ["sova_project", {}],
      ["sova_idea", { op: "list" }],
      ["sova_pipeline", {}],
      ["sova_list_sessions", {}],
      ["sova_preview", folderStart],
    ] as [string, Record<string, unknown>][]) {
      try {
        seen.push(JSON.stringify(await run(name, params, true)));
      } catch (err) {
        seen.push(String(err));
      }
    }
    const all = (await list()).map((v) => v.url).filter(Boolean) as string[];
    for (const u of all) for (const out of seen) assert.ok(!out.includes(labelOf(u)), `a kept link in a tool result: ${out.slice(0, 120)}`);
    // The backstop every overseer tool passes through: a result or error that holds a kept link shows [preview link].
    const leaky = previewLinkFree({ name: "t", label: "t", description: "", parameters: {}, execute: async () => ({ content: [{ type: "text", text: `see ${urls[0]}` }], details: { u: urls[0] } }) } as never);
    const r = await leaky.execute("c", {} as never, undefined, undefined, undefined as never);
    assert.deepEqual(r, { content: [{ type: "text", text: "see [preview link]" }], details: { u: "[preview link]" } });
    const failing = previewLinkFree({ name: "t", label: "t", description: "", parameters: {}, execute: async () => { throw new Error(`no ${urls[0]} here`); } } as never);
    await assert.rejects(() => failing.execute("c", {} as never, undefined, undefined, undefined as never), /^Error: no \[preview link\] here$/);
  });

  test("the transition log and the activity log never hold it", async () => {
    const urls = (await list()).map((v) => v.url).filter(Boolean) as string[];
    assert.ok(urls.length);
    const logs: string[] = [];
    const walk = (d: string) => {
      for (const n of listDir(d)) {
        const p = join(d, n.name);
        if (n.isDirectory()) walk(p);
        else if (n.isFile() && !p.endsWith(kept.PREVIEW_KEPT_FILE)) logs.push(`${p}\n${readFileSync(p, "latin1")}`);
      }
    };
    walk(join(root, "ws"));
    walk(agentDir);
    for (const u of urls) for (const text of logs) assert.ok(!text.includes(labelOf(u)), `a kept link outside preview-kept.json: ${text.split("\n")[0]}`);
  });
});

describe("an older preview is matched by its worktree when read, never written (§app.project-overseer/previews)", () => {
  test("no recorded session: the listener's cwd names it; nothing is written", async () => {
    owner = { pid: 7, cwd: join(root, "outside") };
    // An operator's port preview made with nothing to match (as an older one reads: no session).
    const r = await app.request("/api/previews", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgId: org.id, projectId: project.id, port: 8732 }) });
    assert.equal(r.status, 200, await r.clone().text());
    const id = ((await r.json()) as PreviewMinted).preview.id;
    assert.equal(kept.keptPreview(id)?.sessionId, undefined);
    let v = (await list()).find((x) => x.id === id)!;
    assert.deepEqual([v.sessionId, v.branch, v.sessionFrom], [null, null, undefined]);
    const linksBefore = readFileSync(links.previewLinksFile(), "utf8");
    const keptBefore = readFileSync(kept.previewKeptFile(), "utf8");
    owner = { pid: 7, cwd: join(wt, "dist") };
    v = (await list()).find((x) => x.id === id)!;
    assert.deepEqual([v.sessionId, v.branch, v.sessionFrom, v.sessionTitle], ["c-shop", "sova/shop-abc123", "worktree", "Shop front"]);
    assert.equal(readFileSync(links.previewLinksFile(), "utf8"), linksBefore);
    assert.equal(readFileSync(kept.previewKeptFile(), "utf8"), keptBefore, "never written");
    // One with no kept entry at all (made before preview-kept.json): no link, matched the same way.
    const old = links.mintPreview({ orgId: org.id, projectId: project.id, port: 8733 }, new Set()).record;
    const ov = (await list()).find((x) => x.id === old.id)!;
    assert.deepEqual([ov.url, ov.sessionId, ov.sessionFrom], [null, "c-shop", "worktree"]);
    assert.deepEqual(ov.target, { kind: "port", port: 8733 });
  });
});

describe("confirm kinds: preview, and lists saved before it (§app.project-overseer/reviews)", () => {
  test("a list saved without confirmKindsKnown gets preview on (send as saved); one saved after keeps it off", () => {
    // Every kind there was before confirmKindsKnown was written, send (outreach's) included.
    const old = ["gather", "offer", "close", "promote", "build", "prompt", "owner-update", "send", "roster-approve", "roster-decline"];
    assert.ok(store.parsePoSettings({ confirmKinds: old }).confirmKinds.includes("preview"));
    assert.deepEqual(store.parsePoSettings({ confirmKinds: ["gather"] }).confirmKinds, ["gather", "preview"], "send stays as saved: off");
    assert.deepEqual(store.parsePoSettings({ confirmKinds: ["gather"], confirmKindsKnown: [...old, "preview"] }).confirmKinds, ["gather"]);
    const p = store.projectOverseerPaths(org.id, project.id);
    store.patchPoSettings(p, { confirmKinds: ["build"] });
    assert.deepEqual(JSON.parse(readFileSync(p.settings, "utf8")).confirmKindsKnown, [...old, "preview"]);
    assert.deepEqual(store.readPoSettings(p).confirmKinds, ["build"], "unticked after it existed: stays off");
  });
});

function listDir(d: string) {
  try {
    return readdirSync(d, { withFileTypes: true });
  } catch {
    return [];
  }
}

describe("outreach sends a folder preview by its id (§app.outreach/links, §mesh.public/preview-serve)", () => {
  test("the resolver finds it, the person's sibling serves the folder, never another program on its port, and goes off with it", async () => {
    const { RESOLVERS } = await import("./outreach/links");
    const person = orgs.readRoster(org.id)[0]!;
    const r = await app.request("/api/previews", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgId: org.id, projectId: project.id, sessionId: "c-shop", folder: "dist", purpose: "For Ana" }) });
    assert.equal(r.status, 200, await r.clone().text());
    const made = (await r.json()) as PreviewMinted;
    const ref = { kind: "preview" as const, preview: made.preview.id };
    const ctx = { orgId: org.id, projectId: project.id, personId: person.id };
    const refused = RESOLVERS.preview.check(ctx, ref);
    assert.ok(refused === null || !/No such preview|another project|turned off|expired/.test(refused.why), JSON.stringify(refused));
    const sent = await RESOLVERS.preview.resolve({ ...ctx, key: "k1" }, ref);
    const label = labelOf(sent.url);
    assert.notEqual(label, labelOf(made.url), "the person's own link");
    assert.deepEqual(await fetchVia(label, "/"), { status: 200, body: "<h1>Shop</h1>" });
    assert.equal((await fetchVia(label, "/.git/config")).status, 404);
    const sib = (await list()).find((v) => v.id === sent.log.previewId)!;
    assert.deepEqual([sib.siblingOf, sib.target, sib.url, sib.sessionId, sib.purpose], [made.preview.id, { kind: "static", folder: "dist" }, null, "c-shop", "For Ana"], "its original's target and session, never a link");
    // The folder's serve is gone and another program took its port: the sibling never shows it.
    const port = made.preview.port;
    await stopStaticServe(made.preview.id);
    const intruder = createServer((_q, s) => s.end("intruder"));
    await new Promise<void>((ok) => intruder.listen(port, "127.0.0.1", () => ok()));
    try {
      const seen = await fetchVia(label, "/");
      assert.equal(seen.status, 502);
      assert.ok(!seen.body.includes("intruder"));
    } finally {
      await new Promise<void>((ok) => intruder.close(() => ok()));
    }
    await previews.rebindStaticPreviews();
    assert.equal((await fetchVia(label, "/")).status, 200);
    await previews.turnOffPreview(made.preview.id);
    assert.equal((await fetchVia(label, "/")).status, 410, "turned off with its original");
  });
});

describe("the session list never shows part of a kept link (§app.session-list/content-rules)", () => {
  test("a link across the title's or the summary line's cut is redacted before the cut", async () => {
    const { getSessionSummary } = await import("./sessions-index");
    const { setSessionTitle } = await import("./session-titles");
    const url = (await list()).map((v) => v.url).find(Boolean)!;
    const label = labelOf(url);
    const id = "0199dddd-straddle-q7x";
    const dir = join(agentDir, "sessions", "--straddle--");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `2026-09-30T05-00-00-000Z_${id}.jsonl`);
    // The label starts before the title's 80th character and ends after it; the same across the summary's 200.
    const first = `${"a".repeat(60)} ${url} and more`;
    const now = `${"b".repeat(180)} ${url} and more`;
    const rows = [
      { type: "session", version: 3, id, timestamp: "2026-09-30T05:00:00.000Z", cwd: dir },
      { type: "message", id: "s-u1", parentId: null, timestamp: "2026-09-30T05:00:01.000Z", message: { role: "user", content: first, timestamp: 1 } },
      { type: "message", id: "s-a1", parentId: "s-u1", timestamp: "2026-09-30T05:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }], provider: "zai", model: "glm-5.3", stopReason: "stop", timestamp: 2 } },
      { type: "custom", id: "s-o1", parentId: "s-a1", timestamp: "2026-09-30T05:00:03.000Z", customType: "topic-outline", data: { now, overall: `gist ${url}` } },
    ];
    writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
    // Renamed: the derived title rides along as originalTitle, as the checker found it.
    setSessionTitle(id, "Renamed by the operator");
    const s = await getSessionSummary(path);
    assert.ok(s);
    assert.equal(s.title, "Renamed by the operator");
    assert.ok(s.originalTitle?.includes("[preview link]"), s.originalTitle);
    const body = JSON.stringify(s);
    assert.ok(!body.includes(label.slice(0, 8)), `part of a kept link in the summary: ${body.slice(0, 300)}`);
  });
});
