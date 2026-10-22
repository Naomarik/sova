// Run: pnpm test server/project-assistant-default.test.ts. The Project Assistant's host default model
// (§app.project-assistant/models): the one resolution (project → org → default) and its sources, a kind's
// null = follow the default, the one-time adoption of exactly-matching org picks on the first default save,
// readiness (resolved + runnable here + allowed by Settings → Models), and that an org with no picks follows
// a vision default into the owner's photos (view and upload). Throwaway workspace and PI_CODING_AGENT_DIR; the
// host's model list is a stand-in (no model runtime); no model is called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { Hono } from "hono";
import { PHOTO_DEFAULTS } from "../shared/baton";
import type { AssistantInfo } from "../shared/project-assistant";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-pa-default-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions", "live"), { recursive: true });

const orgs = await import("./orgs");
const owner = await import("./owner");
const plinks = await import("./person-links");
const store = await import("./project-assistant-store");
const ready = await import("./project-assistant-ready");
const routes = await import("./project-assistant-routes");
const settings = await import("./baton-settings");
const policy = await import("./model-policy");
const pa = await import("./project-assistant");
const { registerOrgRoutes } = await import("./org-routes");
const { createShareApp } = await import("./share/routes");
const { settled } = await import("./workspace-git");

after(async () => {
  for (const d of ["ws-a", "ws-b", "ws-c", "ws-photo"]) await settled(join(root, d));
});

const OPUS = "claude-code-cli/claude-opus-5-5";
const GLM = "zai/glm-5.3";
const SEER = "vis/seer";
/** The host's runnable models: the stand-in for GET /api/models' list. */
ready.setAssistantModelListForTests(async () => [{ ref: OPUS, input: ["text", "image"] }, { ref: GLM, input: ["text"] }, { ref: SEER, input: ["text", "image"] }]);

const orgA = await orgs.createOrg({ name: "Org A", dir: join(root, "ws-a") });
const orgB = await orgs.createOrg({ name: "Org B", dir: join(root, "ws-b") });
const orgC = await orgs.createOrg({ name: "Org C", dir: join(root, "ws-c") });
const app = new Hono();
registerOrgRoutes(app);
const putModels = async (orgId: string, models: unknown) =>
  (await (await app.request(`/api/orgs/${orgId}/owner/assistant`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ models }) })).json()) as AssistantInfo;
const putSettings = (assistant: unknown) =>
  app.request("/api/baton/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ messagesMax: 60, ...(assistant === undefined ? {} : { assistant }) }) });

describe("the one resolution: project → org → default (§app.project-assistant/models)", () => {
  beforeEach(() => {
    settings.writeBatonSettings({ messagesMax: 60, assistant: null });
    store.setAssistantModels(orgA.id, { models: { reply: null, coding: null, gathering: null } });
  });

  test("nothing set resolves to nothing; a default resolves every kind with source default", () => {
    assert.equal(store.effectiveAssistantModel(orgA.id, "reply"), null);
    settings.writeBatonSettings({ messagesMax: 60, assistant: { model: OPUS, thinking: "medium" } });
    for (const k of ["reply", "coding", "gathering"] as const) assert.deepEqual(store.effectiveAssistantModel(orgA.id, k), { pick: { model: OPUS, thinking: "medium" }, source: "default" });
  });

  test("the org's own pick wins over the default; a project's override wins for coding and gathering only", () => {
    settings.writeBatonSettings({ messagesMax: 60, assistant: { model: OPUS, thinking: "medium" } });
    store.setAssistantModels(orgA.id, { models: { reply: { model: GLM, thinking: "high" }, coding: { model: GLM } } });
    assert.deepEqual(store.effectiveAssistantModel(orgA.id, "reply"), { pick: { model: GLM, thinking: "high" }, source: "org" });
    const override = { reply: { model: SEER }, coding: { model: SEER } };
    assert.deepEqual(store.effectiveAssistantModel(orgA.id, "coding", override), { pick: { model: SEER }, source: "project" });
    assert.equal(store.effectiveAssistantModel(orgA.id, "reply", override)?.source, "org", "a project never overrides replies");
    assert.equal(store.effectiveAssistantModel(orgA.id, "gathering", override)?.source, "default");
  });

  test("the Owner card's PUT keeps thinking, and a kind's null clears the org's pick so it follows the default", async () => {
    settings.writeBatonSettings({ messagesMax: 60, assistant: { model: OPUS, thinking: "medium" } });
    let info = await putModels(orgA.id, { reply: { model: GLM, thinking: "high" } });
    assert.deepEqual({ model: info.models.reply?.model, thinking: info.models.reply?.thinking, source: info.models.reply?.source }, { model: GLM, thinking: "high", source: "org" });
    assert.equal(info.models.coding?.source, "default");
    assert.equal(info.default?.model, OPUS);
    info = await putModels(orgA.id, { reply: null });
    assert.deepEqual({ model: info.models.reply?.model, thinking: info.models.reply?.thinking, source: info.models.reply?.source }, { model: OPUS, thinking: "medium", source: "default" });
    assert.equal(store.readAssistantStore(orgA.id).models.reply, undefined, "nothing of the org's own is left");
    assert.equal(info.ready, true);
  });

  test("with no default and no pick the card reads not set, not ready", async () => {
    const info = await putModels(orgA.id, { reply: null });
    assert.equal(info.models.reply, null);
    assert.equal(info.default, null);
    assert.equal(info.ready, false);
  });
});

describe("the default in Settings → Organizations (PUT /api/baton/settings)", () => {
  test("a bad model or thinking is refused (400); absent keeps the stored default; null clears it", async () => {
    assert.equal((await putSettings({ model: "no-slash" })).status, 400);
    assert.equal((await putSettings({ model: GLM, thinking: "loud" })).status, 400);
    settings.writeBatonSettings({ messagesMax: 60, assistant: { model: GLM } });
    assert.equal((await putSettings(undefined)).status, 200);
    assert.equal(settings.assistantDefault()?.model, GLM);
    const got = (await (await app.request("/api/baton/settings")).json()) as { assistant: { model: string } | null };
    assert.equal(got.assistant?.model, GLM);
    assert.equal((await putSettings(null)).status, 200);
    assert.equal(settings.assistantDefault(), null);
  });
});

describe("the first default adopts exactly-matching picks, once", () => {
  test("{model} alone is not {model, medium}; an exact match is cleared; other kinds and fields stay; later saves never clear", async () => {
    // A fresh host: no default has ever been saved.
    rmSync(join(root, "agent", "sova", "baton-settings.json"), { force: true });
    assert.equal(settings.assistantPicksAdopted(), false);
    store.setAssistantModels(orgA.id, { models: { reply: { model: OPUS }, coding: null, gathering: null } });
    store.setAssistantModels(orgB.id, { models: { reply: { model: OPUS, thinking: "medium" }, coding: { model: GLM, thinking: "high" }, gathering: { model: OPUS, thinking: "medium" } } });
    store.setConversation(orgB.id, "p_keep", "sess-keep");
    assert.equal((await putSettings({ model: OPUS, thinking: "medium" })).status, 200);
    assert.deepEqual(store.readAssistantStore(orgA.id).models, { reply: { model: OPUS } }, "no thinking ≠ medium: kept as the org's own");
    assert.deepEqual(store.readAssistantStore(orgB.id).models, { coding: { model: GLM, thinking: "high" } }, "exact matches cleared, the rest kept");
    assert.equal(store.readAssistantStore(orgB.id).conversations.p_keep, "sess-keep");
    assert.equal(settings.assistantPicksAdopted(), true);
    // A later save (even after clearing the default and setting it again) never clears a pick.
    store.setAssistantModels(orgC.id, { models: { reply: { model: GLM, thinking: "low" } } });
    assert.equal((await putSettings(null)).status, 200);
    assert.equal((await putSettings({ model: GLM, thinking: "low" })).status, 200);
    assert.deepEqual(store.readAssistantStore(orgC.id).models, { reply: { model: GLM, thinking: "low" } });
    const raw = JSON.parse(readFileSync(join(root, "agent", "sova", "baton-settings.json"), "utf8"));
    assert.equal(typeof raw.assistantAdoptedAt, "string");
  });
});

describe("ready = resolved, runnable here, and allowed by Settings → Models", () => {
  test("a default turned off in Settings → Models leaves orgs that follow it not ready; one this host can't run too", async () => {
    store.setAssistantModels(orgC.id, { models: { reply: null } });
    settings.writeBatonSettings({ messagesMax: 60, assistant: { model: GLM, thinking: "high" } });
    assert.deepEqual(await ready.assistantReplyState(orgC.id), { pick: { model: GLM, thinking: "high" }, source: "default", ready: true, problem: null, images: false });
    policy.writeModelPolicy({ disabledProviders: [], disabledModels: [GLM], subagentDisabledProviders: [], subagentDisabledModels: [] });
    assert.equal(await ready.assistantReady(orgC.id), false);
    assert.equal((await ready.assistantReplyState(orgC.id))?.problem, "turned-off");
    assert.equal((await putModels(orgC.id, {})).ready, false);
    policy.writeModelPolicy({ disabledProviders: [], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: [] });
    assert.equal(await ready.assistantReady(orgC.id), true);
    settings.writeBatonSettings({ messagesMax: 60, assistant: { model: "gone/model" } });
    assert.equal((await ready.assistantReplyState(orgC.id))?.problem, "unavailable");
    assert.equal(await ready.assistantReady(orgC.id), false);
  });
});

describe("an org with no picks follows a vision default into the owner's photos (§app.project-assistant/photos)", () => {
  test("the view carries photos and a photo upload is taken (not 409)", async () => {
    const org = await orgs.createOrg({ name: "Photo Org", dir: join(root, "ws-photo") });
    const alp = await orgs.addPerson(org.id, { name: "Alperen Kaya", role: "Founder" });
    await owner.setOwner(org.id, alp.id);
    const { token } = plinks.mintOwnerLink(org.id, alp.id);
    assert.deepEqual(store.readAssistantStore(org.id).models, {});
    settings.writeBatonSettings({ messagesMax: 60, photos: { ...PHOTO_DEFAULTS, enabled: true }, assistant: { model: SEER } });
    const view = await pa.assistantView(org.id);
    assert.equal(view.ready, true);
    assert.deepEqual(view.photos, { perMessage: PHOTO_DEFAULTS.perMessage, maxBytes: PHOTO_DEFAULTS.maxBytes });
    const share = createShareApp();
    const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
    const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const upload = () =>
      share.request(`/api/i/${token}/assistant/image`, { method: "POST", headers: { "content-type": "image/png", "content-length": String(PNG.length), "user-agent": UA }, body: new Uint8Array(PNG) });
    const r = await upload();
    assert.equal(r.status, 201, await r.clone().text());
    // A default without vision: no paperclip, and the upload refuses a photo.
    settings.writeBatonSettings({ messagesMax: 60, assistant: { model: GLM } });
    assert.equal((await pa.assistantView(org.id)).photos, undefined);
    const no = await upload();
    assert.equal(no.status, 409);
    assert.equal(((await no.json()) as { code: string }).code, "no-photos");
    // No default at all: not ready.
    settings.writeBatonSettings({ messagesMax: 60, assistant: null });
    const nr = await upload();
    assert.equal(nr.status, 409);
    assert.equal(((await nr.json()) as { code: string }).code, "not-ready");
  });
});
