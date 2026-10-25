// The owner's photos in their Project Assistant chat (§app.project-assistant/photos), and its
// drawings' hidden retry (§app.project-assistant/drawings). Photos: the upload
// and message routes on the share app, the image reaching the model as image content, the owner's
// view carrying only {n, mime} and the bytes served by index, a model without vision refusing a
// photo (409 no-photos), and no total limit. Real pi up to the model call (a ScriptedModel
// answers); a throwaway PI_CODING_AGENT_DIR; ~/.pi is never read; no model is called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { piSession } from "./harness/pi/testing/handle";
import { ScriptedModel, scriptedModelsJson } from "./harness/pi/testing/scripted-model";
import { linkPiConfigExtensions } from "./testing/agent-dir";
import { PHOTO_DEFAULTS } from "../shared/baton";

for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];
const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-assistant-photos-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
linkPiConfigExtensions(agentDir);
// Two models of the scripted provider: `scripted` reads text only, `seer` sees images too.
const models = scriptedModelsJson();
const base = models.providers.scripted.models[0]!;
(models.providers.scripted.models as unknown[]) = [{ ...base, input: ["text"] }, { ...base, id: "seer", input: ["text", "image"] }];
writeFileSync(join(agentDir, "models.json"), JSON.stringify(models));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "scripted", defaultModel: "scripted", retry: { enabled: false } }));

await import("./testing/in-process-chats");
const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { isSessionBusy } = await import("./chat-handle");
const orgs = await import("./orgs");
const owner = await import("./owner");
const plinks = await import("./person-links");
const pa = await import("./project-assistant");
const store = await import("./project-assistant-store");
const settings = await import("./baton-settings");
const { resetUploadWindows } = await import("./baton-images");
const { createShareApp } = await import("./share/routes");
const { settled } = await import("./workspace-git");

after(async () => {
  await disposeAllChats();
  await settled(join(root, "ws"));
  rmSync(root, { recursive: true, force: true });
});

const org = await orgs.createOrg({ name: "Photo Org", dir: join(root, "ws") });
const alp = await orgs.addPerson(org.id, { name: "Alperen Kaya", role: "Founder" });
await owner.setOwner(org.id, alp.id);
mkdirSync(join(root, "site"));
await orgs.addProject(org.id, { name: "Archery website", root: join(root, "site") });
const { token } = plinks.mintOwnerLink(org.id, alp.id);
const share = createShareApp();
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
const post = (path: string, body: unknown) => share.request(path, { method: "POST", headers: { "content-type": "application/json", "user-agent": UA }, body: JSON.stringify(body) });
const get = (path: string) => share.request(path, { headers: { "user-agent": UA } });
// A 1×1 PNG (no metadata to strip).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const upload = (bytes: Buffer = PNG, mime = "image/png") =>
  share.request(`/api/i/${token}/assistant/image`, { method: "POST", headers: { "content-type": mime, "content-length": String(bytes.length), "user-agent": UA }, body: new Uint8Array(bytes) });

async function until(cond: () => boolean, what: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

type View = { ready: boolean; photos?: { perMessage: number; maxBytes: number }; messages: { role: string; text: string; images?: { n: number; mime: string }[] }[] };

let model: ScriptedModel;
let path = "";

describe("the owner's photos", () => {
  test("no reply model: the upload is not ready, and the view offers no paperclip", async () => {
    settings.writeBatonSettings({ messagesMax: 60, photos: { ...PHOTO_DEFAULTS, enabled: true } });
    assert.equal((await upload()).status, 409);
    const v = (await (await get(`/api/i/${token}/assistant`)).json()) as View;
    assert.equal(v.photos, undefined);
  });

  test("a model that can't see images: no paperclip, and the upload and the message refuse a photo (409 no-photos)", async () => {
    store.setAssistantModels(org.id, { models: { reply: { model: "scripted/scripted" } } });
    const v = (await (await get(`/api/i/${token}/assistant`)).json()) as View;
    assert.equal(v.photos, undefined);
    const r = await upload();
    assert.equal(r.status, 409);
    assert.equal(((await r.json()) as { code: string }).code, "no-photos");
    const m = await post(`/api/i/${token}/assistant`, { text: "", images: ["im_AAAAAAAAAAAAAAAA"] });
    assert.equal(m.status, 409);
    assert.equal(((await m.json()) as { code: string }).code, "no-photos");
  });

  test("photos off in Settings: no paperclip even on a model that sees images", async () => {
    store.setAssistantModels(org.id, { models: { reply: { model: "scripted/seer" } } });
    settings.writeBatonSettings({ messagesMax: 60, photos: { ...PHOTO_DEFAULTS, enabled: false } });
    assert.equal(((await (await get(`/api/i/${token}/assistant`)).json()) as View).photos, undefined);
    assert.equal((await upload()).status, 409);
    settings.writeBatonSettings({ messagesMax: 60, photos: { ...PHOTO_DEFAULTS, enabled: true } });
  });

  test("upload, then send: the image reaches the model, the view carries {n, mime} only, and /img/<n> serves it", async () => {
    const v = (await (await get(`/api/i/${token}/assistant`)).json()) as View;
    assert.deepEqual(v.photos, { perMessage: PHOTO_DEFAULTS.perMessage, maxBytes: PHOTO_DEFAULTS.maxBytes });
    // A wrong type by its bytes, and one over the largest photo, are refused before anything is staged.
    assert.equal((await upload(PNG, "image/jpeg")).status, 400);
    const big = await share.request(`/api/i/${token}/assistant/image`, { method: "POST", headers: { "content-type": "image/png", "content-length": String(PHOTO_DEFAULTS.maxBytes + 1), "user-agent": UA }, body: new Uint8Array(PNG) });
    assert.equal(big.status, 413);
    const up = await upload();
    assert.equal(up.status, 201, await up.clone().text());
    const { id, mime } = (await up.json()) as { id: string; mime: string };
    assert.equal(mime, "image/png");

    const conv = await pa.ensureAssistant(org.id);
    path = conv.path;
    const chat = await acquireChat(path);
    model = new ScriptedModel().attach(piSession(chat));
    model.reply({ text: "I can see the error on the sign-up screen." });
    const r = await post(`/api/i/${token}/assistant`, { text: "", images: [id] });
    assert.equal(r.status, 202, await r.clone().text());
    await until(() => model.calls.length >= 1 && !isSessionBusy(path), "the reply");
    const ctx = model.calls[0]!.context as { messages: { role: string; content: unknown }[] };
    const user = [...ctx.messages].reverse().find((m) => m.role === "user")!;
    const blocks = user.content as { type: string; data?: string }[];
    assert.ok(blocks.some((b) => b.type === "image" && b.data === PNG.toString("base64")), "the photo is image content in the owner's message");
    assert.match(JSON.stringify(ctx.messages[0] ?? ""), /can attach photos and screenshots/, "the prompt says photos can be sent");

    const view = (await (await get(`/api/i/${token}/assistant`)).json()) as View;
    const own = view.messages.find((m) => m.role === "owner")!;
    assert.deepEqual(own.images, [{ n: 0, mime: "image/png" }]);
    assert.ok(!JSON.stringify(view).includes(PNG.toString("base64").slice(0, 40)), "no pixels in the view");
    const img = await get(`/api/i/${token}/assistant/img/0`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
    assert.equal((await get(`/api/i/${token}/assistant/img/1`)).status, 404);
    // Sent: the staged copy is gone, so the same id is expired.
    const again = await post(`/api/i/${token}/assistant`, { text: "again", images: [id] });
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as { code: string }).code, "photo-expired");
  });

  test("more than the per-message limit is refused; there is no daily limit past 3 × the per-conversation one", async () => {
    settings.writeBatonSettings({ messagesMax: 60, photos: { ...PHOTO_DEFAULTS, enabled: true, perConversation: 1 } });
    resetUploadWindows();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await upload();
      assert.equal(r.status, 201, `upload ${i}: ${await r.clone().text()}`);
      ids.push(((await r.json()) as { id: string }).id);
    }
    const r = await post(`/api/i/${token}/assistant`, { text: "five", images: ids.slice(0, PHOTO_DEFAULTS.perMessage + 1) });
    assert.equal(r.status, 400);
    assert.equal(((await r.json()) as { code: string }).code, "too-many");
    settings.writeBatonSettings({ messagesMax: 60, photos: PHOTO_DEFAULTS });
  });

  test("a dead or unknown link: 404 for every photo route", async () => {
    const T = "A".repeat(43);
    assert.equal((await share.request(`/api/i/${T}/assistant/image`, { method: "POST", headers: { "content-type": "image/png", "content-length": String(PNG.length) }, body: new Uint8Array(PNG) })).status, 404);
    assert.equal((await share.request(`/api/i/${T}/assistant/img/0`)).status, 404);
  });
});

describe("its drawings", () => {
  test("a vis block that can't be drawn gets one hidden retry in the same run; the owner never sees the note", async () => {
    const before = model.calls.length;
    model.reply({ text: "Here is the flow:\n\n```vis flow\nthis is not a flow at all ->\n```" }, { text: "```vis flow\na \"Sign up\" -> b \"Confirm\"\n```" });
    assert.equal((await post(`/api/i/${token}/assistant`, { text: "Draw me the sign-up" })).status, 202);
    await until(() => model.calls.length >= before + 2 && !isSessionBusy(path), "the retry");
    const ctx = model.calls[before + 1]!.context as { messages: { role: string; content: unknown }[] };
    assert.match(JSON.stringify(ctx.messages.slice(-1)), /Sova could not draw one vis block/, "the model got the hidden note");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(model.calls.length, before + 2, "at most one retry");
    const view = JSON.stringify(await (await get(`/api/i/${token}/assistant`)).json());
    assert.ok(!view.includes("Sova could not draw"), "the note is never in the owner's view");
    assert.match(view, /Sign up/, "the fixed drawing is");
  });
});

