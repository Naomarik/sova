// Set Up With a Chat (§mesh.tunnel/setup-chat): the briefs, and the route's order of acts, in process.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-setup-chat-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent"), { recursive: true });
process.env.SOVA_AUTH = "off";

const setup = await import("./setup-chat");
const tok = await import("./tunnel/account-token");
const store = await import("../public-links");
const { stateRoot } = await import("../state-root");

after(() => rmSync(root, { recursive: true, force: true }));

const TOKEN = Buffer.from(JSON.stringify({ a: "acct".padEnd(32, "0"), t: "tunnel".padEnd(36, "1"), s: "c2VjcmV0".padEnd(44, "x") })).toString("base64");

describe("the briefs", () => {
  test("every option's brief names the share port, its steps and the user's save, forbids settings writes, and never carries the token", () => {
    tok.writeAccountToken(TOKEN);
    store.patchPublicLinks({ route: "account", account: { publicUrl: "https://share.example.org", previewUrl: "https://*.example.org" } });
    for (const option of setup.SETUP_OPTIONS) {
      for (const sharePort of [4802, 4999]) {
        const file = { ...store.readPublicLinks(), gateway: { publicUrl: "https://links.example.net", front: "caddy" as const, sharePort, acceptFrom: "all" as const } };
        const brief = setup.setupBrief(option, file);
        assert.ok(brief.includes(`127.0.0.1:${sharePort}`), `${option}: the share port`);
        assert.match(brief, /Run each step only after the user approves it/, option);
        assert.match(brief, /Never write or change a Sova setting/, option);
        assert.match(brief, /Settings → Public links[^]*press Verify/, `${option}: the user saves and verifies`);
        assert.ok(!brief.includes(TOKEN.slice(0, 24)), `${option}: no token`);
        assert.equal(/token/i.test(brief.replace(/Never ask for, read, print[^\n]*\n/, "")), option === "account", `${option}: only Account speaks of the token`);
      }
    }
    assert.match(setup.setupBrief("account"), /share\.example\.org[^]*\*\.example\.org/, "Account's steps use its saved addresses");
    assert.match(setup.setupBrief("web-server", { version: 1, route: "quick" }), /First ask the user which domain/, "no saved domain: the chat asks for one");
    tok.deleteAccountToken();
    rmSync(store.publicLinksFile(), { force: true });
  });
});

describe("the route", () => {
  const PAGE = { incoming: {} };
  const post = (a: Hono, body: unknown, headers: Record<string, string> = {}, env: object | null = PAGE) =>
    a.request("/api/public-links/setup-chat", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }, env ?? undefined);

  function rig(over: Partial<import("./setup-chat").SetupChatDeps> = {}) {
    const log: string[] = [];
    const deps: import("./setup-chat").SetupChatDeps = {
      create: async (_c, cwd) => (log.push(`create ${cwd}`), { path: join(cwd, "s.jsonl") }),
      setModel: async (_p, model) => (log.push(`model ${model}`), { ok: true }),
      applyDefault: async () => (log.push("default"), { ok: true }),
      prompt: async (_p, text) => (log.push(`prompt ${text}`), { ok: true }),
      summary: async (path) => ({ id: "s1", path }),
      ...over,
    };
    const a = new Hono();
    a.post("/api/public-links/setup-chat", (c) => setup.setupChatRoute(c, deps));
    return { a, log };
  }

  test("the model is set before the first message: the page's, else this computer's default", async () => {
    for (const model of [undefined, "zai/glm-5.3"]) {
      const { a, log } = rig();
      const r = await post(a, { option: "funnel", ...(model ? { model } : {}) });
      assert.equal(r.status, 201);
      const dir = join(stateRoot(), "public-links-setup", "funnel");
      assert.deepEqual(log, [`create ${dir}`, model ? `model ${model}` : "default", `prompt ${setup.firstMessage("funnel")}`]);
      assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), setup.setupBrief("funnel"));
    }
  });

  test("a model that doesn't take is said, and the chat still starts", async () => {
    const { a } = rig({ setModel: async () => ({ ok: false, error: "its model wasn't set (unknown)" }) });
    const r = await post(a, { option: "account", model: "x/y" });
    assert.equal(r.status, 201);
    assert.equal((await r.json()).modelNotSet, "its model wasn't set (unknown)");
  });

  test("only the page starts one; bad input starts nothing", async () => {
    const cases: [string, unknown, Record<string, string>, object | null, number][] = [
      ["a script", { option: "funnel" }, { "x-sova-token": "t" }, PAGE, 403],
      ["in-process", { option: "funnel" }, {}, null, 403],
      ["a peer", { option: "funnel" }, {}, { incoming: {}, meshPeer: { id: "p" } }, 404],
      ["unknown option", { option: "quick" }, {}, PAGE, 400],
      ["bad model", { option: "funnel", model: "nope" }, {}, PAGE, 400],
    ];
    for (const [who, body, headers, env, status] of cases) {
      const { a, log } = rig();
      const r = await post(a, body, headers, env);
      assert.equal(r.status, status, who);
      assert.deepEqual(log, [], `${who}: nothing created`);
    }
  });
});
