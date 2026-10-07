// Run: pnpm exec tsx --test server/project-overseer-tools-statecharts.test.ts. The project overseer's tools and the
// Pipeline/held-act routes against the real engine host: the level, the allowances and the holds are the
// statecharts' (§app.project-overseer/autonomy-levels, /limits, /holds, /pipeline, /corrections). Throwaway
// workspace and PI_CODING_AGENT_DIR; no model is called.
// sova_project_verbs against a real served project; the statecharts' decisions in-process are project-overseer-tools-statecharts.test.ts.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import type { PipelineInfo, PipelineTimeline } from "../shared/pipeline";
import { reservePorts } from "./test-ports";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-po-statecharts-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
symlinkSync(resolve(import.meta.dirname, "..", "pi-config", "extensions"), join(agentDir, "extensions"));

const orgs = await import("./orgs");
const baton = await import("./baton");
const po = await import("./project-overseer");
const store = await import("./project-overseer-store");
const { registerOrgRoutes } = await import("./org-routes");
const { disposeAllChats } = await import("./chat-manager");
const { settled } = await import("./workspace-git");
const { envelopeFor, holdRef, hostOf, setOrgClockForTest } = await import("./org-engine");
const { pipelineInfo, LINES } = await import("./project-pipeline");
const { heldAttention } = await import("./project-holds");
const { registerProjectRoutes } = await import("./projects/routes");
const { registerProjectOverseerRoutes } = await import("./project-overseer-routes");
const sids = await import("./projects/sids");
const orgPart = await import("./overseer-org-part");
const { statechartInfo } = await import("./statecharts");
const pipelineInfoOf = () => pipelineInfo(org.id, project.id);
const { fakeLooks } = await import("./org-test-fixtures");

after(async () => {
  await disposeAllChats();
  await settled(join(root, "ws"));
});

const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
const tony = await orgs.addPerson(org.id, { name: "Tony Reyes", role: "IT", decides: ["hosting"] });
const toni = await orgs.addPerson(org.id, { name: "Toni Diaz", role: "Payroll", decides: ["payroll"] });
await po.ensureProjectOverseer(project.id);
fakeLooks(org.id);
const app = new Hono();
registerOrgRoutes(app);
registerProjectRoutes(app);
registerProjectOverseerRoutes(app);

const placement = orgs.placementSid(org.id, project.id);
const tools = (attended: boolean) => po.toolsForTest(project.id, { attended });
const run = (name: string, params: Record<string, unknown>, attended = false) => {
  const t = tools(attended).find((x) => x.name === name);
  assert.ok(t, name);
  return t.execute("call-1", params as never, undefined, undefined, undefined as never);
};
const textOf = (r: { content: unknown[] }): string => (r.content[0] as { text: string }).text;
const actions = () =>
  existsSync(store.projectOverseerPaths(project.id).actions)
    ? readFileSync(store.projectOverseerPaths(project.id).actions, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    : [];
const gather = (title: string, person = "Tony Reyes") => ({ gap: "none", person, why: "Nobody has said this yet.", public_title: title, goal: "Who hosts the portal", question: "Who hosts the portal?" });
const settings = (patch: Record<string, unknown>) => po.patchProjectOverseer(project.id, patch);
/** The project's holds, each under the id the server names it by (F19: `${sessionId}:${holdId}`). */
const holdsOf = () => hostOf(org.id).holds().filter((h) => h.projectId === project.id).map((h) => ({ ...h, id: holdRef(h) }));
/** Cancel every held act of the project (a test's leftovers), as the operator. */
const clearHolds = async () => {
  for (const h of holdsOf()) {
    const r = await app.request(`/api/projects/${project.id}/held/${encodeURIComponent(h.id)}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 200, await r.text());
  }
};

describe("sova_project_verbs goes through the project statechart (§app.project-services/callers)", () => {
  test("unattended: down from L0, up only at L3, any verb in the operator's run; each verb but the reads is an act", async () => {
    const { approve, defHashOf } = await import("./project-services/trust");
    const { parseDefinition } = await import("../shared/project-contract");
    const { stopStaticServe, staticServes } = await import("./preview-serve");
    const { writeFileSync } = await import("node:fs");
    const port = await reservePorts(1); // held across the run's processes, not a free port picked and let go
    const dir = realpathSync(join(root, "proj"));
    mkdirSync(join(dir, ".sova"), { recursive: true });
    mkdirSync(join(dir, "public"), { recursive: true });
    writeFileSync(join(dir, "public", "index.html"), "portal");
    const def = { version: 1, services: { site: { static: "public", ports: { http: { base: port } } } } };
    writeFileSync(join(dir, ".sova", "project.json"), JSON.stringify(def));
    const h = defHashOf(parseDefinition(JSON.stringify(def)));
    approve(dir, h, h);
    type Result = { ok: boolean; state: string; instance: string | null; error?: { code: string } };
    const verb = async (params: Record<string, unknown>, attended = false) => ((await run("sova_project_verbs", params, attended)) as { details: { result: Result } }).details.result;
    const acts = () => hostOf(org.id).feed(project.id, { newestFirst: false, limit: 500 }).filter((e) => e.event.startsWith("services/")).map((e) => [e.event, e.refused ? "refused" : "taken"]);
    const seen = acts().length;
    try {
      await settings({ autonomy: "L0" });
      await assert.rejects(() => verb({ verb: "up" }), /^Error: This run was not started by the operator, and your autonomy here is L0; sova_project_verbs needs L3\. Do not retry it\./);
      assert.deepEqual(actions().at(-1) && [actions().at(-1).tool, actions().at(-1).outcome], ["sova_project_verbs", "refused"]);
      assert.equal((await verb({ verb: "status" })).state, "absent", "nothing was made; a read runs at any level");
      await settings({ autonomy: "L3" });
      const upOut = (await run("sova_project_verbs", { verb: "up" })) as { content: { text: string }[]; details: { result: Result } };
      const up = upOut.details.result;
      assert.equal(up.ok, true, JSON.stringify(up.error));
      assert.equal(up.state, "running");
      // The main checkout gets no instance note (§app.project-services/instance-note: a builder's own worktrees only).
      assert.doesNotMatch(upOut.content[0]!.text, /Sova instance note/);
      assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "portal");
      await settings({ autonomy: "L0" });
      const down = await verb({ verb: "down", instance: up.instance });
      assert.equal(down.ok, true, JSON.stringify(down.error));
      assert.equal(down.state, "stopped");
      const again = await verb({ verb: "up" }, true);
      assert.equal(again.state, "running", "the operator's own run, at L0");
      assert.equal((await verb({ verb: "down", instance: up.instance }, true)).state, "stopped");
      assert.deepEqual(acts().slice(seen), [
        ["services/run", "refused"],
        ["services/run", "taken"],
        ["services/down", "taken"],
        ["services/run", "taken"],
        ["services/down", "taken"],
      ]);
      // test runs project code: services/run, so L3 (§app.project-services/test); this project declares none.
      const before = acts().length;
      await assert.rejects(() => verb({ verb: "test" }), /your autonomy here is L0; sova_project_verbs needs L3/);
      await settings({ autonomy: "L3" });
      const t = await verb({ verb: "test" });
      assert.equal(t.error?.code, "unsupported", "taken, then the engine's own answer");
      assert.deepEqual(acts().slice(before), [
        ["services/run", "refused"],
        ["services/run", "taken"],
      ]);
    } finally {
      for (const s of staticServes()) await stopStaticServe(s.id).catch(() => false);
    }
  });
});

describe("sova_project_verbs share is the project's services/share (§app.project-overseer/previews)", () => {
  test("L0 refused; L1 unattended held, then approved: the link is minted, never in a result; revoke at L0, never held", async () => {
    const { approve, defHashOf } = await import("./project-services/trust");
    const { parseDefinition } = await import("../shared/project-contract");
    const { stopStaticServe, staticServes } = await import("./preview-serve");
    const { writeFileSync } = await import("node:fs");
    const port = await reservePorts(1); // held across the run's processes, not a free port picked and let go
    const pin = process.env.SOVA_SHARE_PREVIEW_URL;
    process.env.SOVA_SHARE_PREVIEW_URL = "https://*.preview.example.invalid";
    const dir = realpathSync(join(root, "proj"));
    mkdirSync(join(dir, ".sova"), { recursive: true });
    mkdirSync(join(dir, "public"), { recursive: true });
    writeFileSync(join(dir, "public", "index.html"), "portal");
    const def = { version: 1, services: { site: { static: "public", ports: { http: { base: port } } } }, share: { endpoints: ["site.http"] } };
    writeFileSync(join(dir, ".sova", "project.json"), JSON.stringify(def));
    const h = defHashOf(parseDefinition(JSON.stringify(def)));
    approve(dir, h, h);
    type Result = { ok: boolean; state: string; instance: string | null; error?: { code: string; message: string }; links: { id: string; endpoint: string; url?: string }[]; steps: { id: string; result: string; detail?: string }[] };
    const verb = async (params: Record<string, unknown>, attended = false) => {
      const out = (await run("sova_project_verbs", params, attended)) as { content: { text: string }[]; details: { result: Result } };
      return { text: out.content[0]!.text, result: out.details.result, json: JSON.stringify(out) };
    };
    const acts = () => hostOf(org.id).feed(project.id, { newestFirst: false, limit: 500 }).filter((e) => e.event === "services/share").map((e) => [e.event, e.refused ? "refused" : "taken"]);
    const seen = acts().length;
    try {
      await settings({ autonomy: "L3", holdMin: 10 });
      const up = (await verb({ verb: "up" }, true)).result;
      assert.equal(up.ok, true, JSON.stringify(up.error));
      const instance = up.instance!;
      await settings({ autonomy: "L0" });
      await assert.rejects(() => verb({ verb: "share", instance, endpoint: "site.http" }), /your autonomy here is L0; sova_project_verbs needs L1/);
      assert.equal(holdsOf().length, 0, "refused above its level: nothing held");
      const notDeclared = (await verb({ verb: "share", instance, endpoint: "site.admin" }, true)).result;
      assert.equal(notDeclared.error?.code, "share-denied", "the engine's own checks come first: no act, nothing held");
      await settings({ autonomy: "L1" });
      const held = await verb({ verb: "share", instance, endpoint: "site.http" });
      assert.equal(held.result.ok, true, JSON.stringify(held.result.error));
      assert.deepEqual(held.result.links, [], "nothing minted while held");
      assert.match(held.result.steps.find((s) => s.id === "share")?.detail ?? "", /^Held: the link to site\.http of a running copy .*waits until /);
      assert.match(held.text, /^share: Held: the link to site\.http of a running copy .*so the operator can cancel it/, "the model reads the hold first");
      const holds = holdsOf();
      assert.equal(holds.length, 1);
      assert.equal(holds[0]!.what, "A preview link: site.http of a running copy (" + instance + ")");
      // The overseer approves it (confirm kind preview): the effect mints it.
      const approved = textOf(await run("sova_hold", { op: "approve", id: holds[0]!.id, reason: "Ana asked to see it" }));
      assert.doesNotMatch(approved, /not sent|refused/i);
      const status = await verb({ verb: "status", instance });
      assert.doesNotMatch(status.json, /preview\.example\.invalid/, "the overseer never sees the link");
      const listed = textOf(await run("sova_previews", {}));
      const id = /^- (pv_[A-Za-z0-9_-]{16}) · running copy /m.exec(listed)?.[1];
      assert.ok(id, listed);
      assert.doesNotMatch(listed, /preview\.example\.invalid/);
      // Attended at once: the same link again (idempotent per copy and endpoint), with no URL in the result.
      const again = await verb({ verb: "share", instance, endpoint: "site.http" }, true);
      assert.equal(again.result.links[0]?.id, id);
      assert.doesNotMatch(again.json, /preview\.example\.invalid/);
      await settings({ autonomy: "L0" });
      const revoked = await verb({ verb: "revoke", link: id });
      assert.equal(revoked.result.ok, true, JSON.stringify(revoked.result.error));
      assert.equal(holdsOf().length, 0, "revoke is never held");
      assert.match(textOf(await run("sova_previews", {})), new RegExp(`^- ${id} · .* · revoked · `, "m"));
      // refused at L0; held at L1; released by the approval; at once in the operator's run. Revoke is no act.
      assert.deepEqual(acts().slice(seen), [["services/share", "refused"], ["services/share", "taken"], ["services/share", "taken"], ["services/share", "taken"]]);
      assert.equal(LINES["services/share"], "A running copy of the project was shared.");
      const down = await verb({ verb: "down", instance });
      assert.equal(down.result.state, "stopped", "the overseer stops any copy from L0");
    } finally {
      if (pin === undefined) delete process.env.SOVA_SHARE_PREVIEW_URL;
      else process.env.SOVA_SHARE_PREVIEW_URL = pin;
      for (const s of staticServes()) await stopStaticServe(s.id).catch(() => false);
    }
  });
});
