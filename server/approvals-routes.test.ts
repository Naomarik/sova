// Run: pnpm test -- server/approvals-routes.test.ts
// The approval list's routes over a real project and an ad hoc folder (shared/approvals.ts): who may approve, turn a
// disallowed item back on and turn asking off (the page here, or another computer's page with its proven click),
// and that disallowing and turning asking on are anyone's. A refusal changes nothing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { Hono } from "hono";

const home = realpathSync(homedir());
const base = realpathSync(mkdtempSync(join(home, "approval-routes-")));
const prevAgent = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(base, "agent");
mkdirSync(join(base, "agent", "sova"), { recursive: true });
after(() => {
  if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgent;
  rmSync(base, { recursive: true, force: true });
});

const { registerApprovalRoutes } = await import("./approvals-routes");
const { registerProjectIn } = await import("./projects/spaces");
const store = await import("./project-skills-store");
const setting = await import("./context-approval-setting");
const { pageHeaders } = await import("./testing/page");
const { clickProofFor, setClickAskForTest, takeClick } = await import("./mesh/click-proof");
const { OVERSEER_SENDER_HEADER, senderSecret } = await import("./overseer-sender");
const { readHistory } = await import("./project-settings");

const app = new Hono();
registerApprovalRoutes(app);

const TOKEN = "x-sova-token";
const call = (method: string, url: string, body: unknown, headers: Record<string, string> = {}, env?: Record<string, unknown>) =>
  app.request(url, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
const notThePage = (): [string, Record<string, string>][] => [
  ["a script (the token in a header)", { [TOKEN]: "t" }],
  ["a chat's key beside the page's cookie", { "x-sova-caller": "k", ...pageHeaders() }],
  ["the Overseer", { [OVERSEER_SENDER_HEADER]: senderSecret() }],
  ["no mark at all", {}],
];

async function project(name: string) {
  const dir = join(base, name);
  mkdirSync(join(dir, "svc"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "AGENTS.md"), "# project\n");
  writeFileSync(join(dir, "svc", "AGENTS.md"), "# svc\n");
  mkdirSync(join(dir, ".agents", "skills", "tidy"), { recursive: true });
  writeFileSync(join(dir, ".agents", "skills", "tidy", "SKILL.md"), "---\nname: tidy\ndescription: Tidy up.\n---\nBody.\n");
  const made = await registerProjectIn("standalone", dir, { name, origin: "folder" });
  return { dir, id: made.project.id, key: `p:${made.project.id}` };
}

beforeEach(() => {
  rmSync(store.projectSkillsPath(), { force: true });
  rmSync(setting.contextApprovalPath(), { force: true });
});

describe("a project's cards", () => {
  test("the lists: every context file and skill, by key, Waiting with no decision", async () => {
    const p = await project("lists");
    const ctx = (await (await call("GET", `/api/projects/${p.id}/context-files`, undefined, pageHeaders())).json()) as { files: { key: string; state: string; source: { kind: string } }[]; asking: boolean };
    assert.equal(ctx.asking, false);
    assert.deepEqual(ctx.files.filter((f) => !f.key.startsWith("/")).map((f) => [f.key, f.state, f.source.kind]), [["AGENTS.md", "waiting", "project"], ["svc/AGENTS.md", "waiting", "subfolder"]]);
    const sk = (await (await call("GET", `/api/projects/${p.id}/skills`, undefined)).json()) as { skills: { key: string; name: string }[] };
    assert.ok(sk.skills.some((s) => s.key === ".agents/skills/tidy/SKILL.md" && s.name === "tidy"));
    assert.equal((await call("GET", "/api/projects/nope/context-files", undefined)).status, 404);
  });

  test("anyone disallows; only the page approves or turns a disallowed one back on, and a refusal changes nothing", async () => {
    const p = await project("doors");
    for (const [who, h] of notThePage()) {
      const r = await call("PUT", `/api/projects/${p.id}/context-files`, { files: { "AGENTS.md": "approved" } }, h);
      assert.equal(r.status, 403, who);
      assert.equal(((await r.json()) as { yourClick?: boolean }).yourClick, true, who);
    }
    assert.deepEqual(store.folderDecisions(p.key).context, {});
    assert.equal((await call("PUT", `/api/projects/${p.id}/context-files`, { files: { "svc/AGENTS.md": "disallowed" } }, { [TOKEN]: "t" })).status, 200, "a script disallows");
    for (const [who, h] of notThePage()) assert.equal((await call("PUT", `/api/projects/${p.id}/context-files`, { files: { "svc/AGENTS.md": "waiting" } }, h)).status, 403, `${who} re-allows`);
    assert.equal(store.folderDecisions(p.key).context["svc/AGENTS.md"]?.state, "disallowed");
    const ok = await call("PUT", `/api/projects/${p.id}/context-files`, { files: { "AGENTS.md": "approved", "svc/AGENTS.md": "waiting" } }, pageHeaders());
    assert.equal(ok.status, 200);
    const v = (await ok.json()) as { files: { key: string; state: string }[] };
    assert.equal(v.files.find((f) => f.key === "AGENTS.md")?.state, "approved");
    assert.equal(v.files.find((f) => f.key === "svc/AGENTS.md")?.state, "waiting");
    assert.match(store.folderDecisions(p.key).context["AGENTS.md"]?.sha256 ?? "", /^[0-9a-f]{64}$/);
    // Each change is a line of the project's Settings history.
    assert.deepEqual(readHistory(p.id).map((r) => [r.field, r.from, r.to]), [["context.svc/AGENTS.md", "waiting", "disallowed"], ["context.AGENTS.md", "waiting", "approved"], ["context.svc/AGENTS.md", "disallowed", "waiting"]]);
  });

  test("a skill by key or name; a skill's approval is the page's too; an item not found is a 404; a bad body a 400", async () => {
    const p = await project("skills");
    assert.equal((await call("PUT", `/api/projects/${p.id}/skills`, { skills: { tidy: "approved" } }, { [TOKEN]: "t" })).status, 403);
    const r = await call("PUT", `/api/projects/${p.id}/skills`, { skills: { tidy: "disallowed" } }, { [TOKEN]: "t" });
    assert.equal(r.status, 200);
    assert.deepEqual(store.folderDecisions(p.key).skills, { ".agents/skills/tidy/SKILL.md": { state: "disallowed", name: "tidy" } });
    // A bare name is judged as the decision on its place: turning it back on by name is the page's too.
    for (const [who, h] of notThePage()) assert.equal((await call("PUT", `/api/projects/${p.id}/skills`, { skills: { tidy: "waiting" } }, h)).status, 403, who);
    assert.equal((await call("PUT", "/api/folder-approvals", { cwd: p.dir, skills: { tidy: "waiting" } }, { [TOKEN]: "t" })).status, 403, "through the folder route too");
    assert.equal(store.folderDecisions(p.key).skills[".agents/skills/tidy/SKILL.md"]?.state, "disallowed");
    assert.equal((await call("PUT", `/api/projects/${p.id}/skills`, { skills: { nope: "disallowed" } }, pageHeaders())).status, 404);
    assert.equal((await call("PUT", `/api/projects/${p.id}/context-files`, { files: { "../x": "disallowed" } }, pageHeaders())).status, 400);
  });
});

describe("another computer's page", () => {
  const peer = { meshPeer: { id: "other" } };
  const seen = (r: Request) => ({ req: { method: r.method, raw: r, header: (n: string) => r.headers.get(n) ?? undefined } }) as never;
  const clicked = (method: string, body: string, headers = pageHeaders()) => new Request("http://x/peer/b/api/x", { method, headers, body });

  test("a page click mints a PUT's proof for the approval doors alone, and a script gets none", async () => {
    for (const door of ["/api/projects/pid/skills", "/api/projects/pid/context-files", "/api/folder-approvals", "/api/settings/context-approval"]) assert.ok(await clickProofFor(seen(clicked("PUT", "{}")), "b", door), door);
    for (const door of ["/api/projects/pid/claude-login", "/api/settings/models", "/api/projects/pid/skills/x"]) assert.equal(await clickProofFor(seen(clicked("PUT", "{}")), "b", door), undefined, door);
    assert.equal(await clickProofFor(seen(clicked("POST", "{}")), "b", "/api/folder-approvals"), undefined, "a POST to a PUT door");
    assert.equal(await clickProofFor(seen(clicked("PUT", "{}", { [TOKEN]: "t" })), "b", "/api/folder-approvals"), undefined, "a script gets none");
  });

  test("a peer approves with the proof its sender's page got for that body; with none, replayed, or for another body it is refused and nothing changes", async () => {
    const p = await project("peer");
    setClickAskForTest(async (_peer, _path, init) => {
      const q = JSON.parse(String(init?.body ?? "{}")) as { proof?: string; digest?: string };
      return Response.json({ ok: takeClick(q.proof, "other", q.digest) });
    });
    try {
      const url = `/api/projects/${p.id}/context-files`;
      const body = { files: { "AGENTS.md": "approved" } };
      const relayed = { "X-Forwarded-Host": "h" };
      const none = await call("PUT", url, body, relayed, peer);
      assert.equal(none.status, 403);
      assert.equal(((await none.json()) as { peer?: boolean }).peer, true);
      const other = (await clickProofFor(seen(clicked("PUT", JSON.stringify({ files: { "svc/AGENTS.md": "approved" } }))), "other", url))!;
      assert.equal((await call("PUT", url, body, { ...relayed, "X-Sova-Click-Proof": other }, peer)).status, 403, "a proof for another body");
      assert.deepEqual(store.folderDecisions(p.key).context, {});
      const proof = (await clickProofFor(seen(clicked("PUT", JSON.stringify(body))), "other", url))!;
      assert.equal((await call("PUT", url, body, { ...relayed, "X-Sova-Click-Proof": proof }, peer)).status, 200);
      assert.equal(store.folderDecisions(p.key).context["AGENTS.md"]?.state, "approved");
      assert.equal((await call("PUT", url, { files: { "svc/AGENTS.md": "approved" } }, { ...relayed, "X-Sova-Click-Proof": proof }, peer)).status, 403, "replayed");
    } finally {
      setClickAskForTest(null);
    }
  });
});

/** A session recorded on this computer whose folder is `cwd`. */
let seq = 0;
function sessionIn(cwd: string) {
  const dir = join(base, "agent", "sessions", "--adhoc--");
  mkdirSync(dir, { recursive: true });
  const id = `01a5c444-0000-7000-8000-${String(++seq).padStart(12, "0")}`;
  // Header only: a new chat with no message yet, which the session list leaves out but this must still know.
  writeFileSync(join(dir, `2026-11-11T00-00-${String(seq).padStart(2, "0")}-000Z_${id}.jsonl`), `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-11T00:00:00.000Z", cwd })}\n`);
}

describe("a folder that isn't a project", () => {
  test("only a project's folder or a recorded chat's is answered; any other, / included, is a 404 and never scanned", async () => {
    const stray = join(base, "stray");
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, "AGENTS.md"), "# secret\n");
    for (const cwd of [stray, "/", home]) {
      const r = await call("GET", `/api/folder-approvals?cwd=${encodeURIComponent(cwd)}`, undefined, pageHeaders());
      assert.equal(r.status, 404, cwd);
      assert.doesNotMatch(await r.text(), /AGENTS/, cwd);
      assert.equal((await call("PUT", "/api/folder-approvals", { cwd, files: { "AGENTS.md": "disallowed" } }, pageHeaders())).status, 404, cwd);
    }
    assert.deepEqual(store.readApprovalStore().folders, {});
    const p = await project("known");
    assert.equal((await call("GET", `/api/folder-approvals?cwd=${encodeURIComponent(join(p.dir, "svc"))}`, undefined)).status, 200, "a folder inside a project");
  });

  test("its lists by the chat's folder, the same doors, and Approve All as one PUT", async () => {
    const dir = join(base, "adhoc");
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, "AGENTS.md"), "# adhoc\n");
    mkdirSync(join(dir, "deep"), { recursive: true });
    sessionIn(join(dir, "deep"));
    const get = async () => (await (await call("GET", `/api/folder-approvals?cwd=${encodeURIComponent(join(dir, "deep"))}`, undefined)).json()) as { folder: { key: string; kind: string }; files: { key: string; state: string }[]; skills: { key: string }[]; counts: { waiting: number } };
    const v = await get();
    assert.deepEqual([v.folder.kind, v.folder.key], ["folder", `d:${dir}`]);
    const waiting = Object.fromEntries(v.files.map((f) => [f.key, "approved"]));
    assert.equal((await call("PUT", "/api/folder-approvals", { cwd: join(dir, "deep"), files: waiting }, { [TOKEN]: "t" })).status, 403);
    const all = await call("PUT", "/api/folder-approvals", { cwd: join(dir, "deep"), files: waiting }, pageHeaders());
    assert.equal(all.status, 200);
    assert.equal(((await all.json()) as { counts: { waiting: number } }).counts.waiting, v.skills.length);
    assert.equal((await call("PUT", "/api/folder-approvals", { cwd: join(dir, "deep"), files: { "AGENTS.md": "disallowed" } }, { [TOKEN]: "t" })).status, 200, "Disallow is anyone's");
    assert.equal((await get()).files.find((f) => f.key === "AGENTS.md")?.state, "disallowed");
    assert.equal((await call("PUT", "/api/folder-approvals", { cwd: "relative", files: { "AGENTS.md": "disallowed" } }, pageHeaders())).status, 400);
    assert.equal((await call("PUT", "/api/folder-approvals", { cwd: join(dir, "deep") }, pageHeaders())).status, 400, "no change at all");
  });
});

describe("the Sova-wide setting", () => {
  test("on by default; anyone turns asking on; only the page turns it back off", async () => {
    const read = async () => ((await (await call("GET", "/api/settings/context-approval", undefined)).json()) as { allowWithoutAsking: boolean }).allowWithoutAsking;
    assert.equal(await read(), true);
    assert.equal((await call("PUT", "/api/settings/context-approval", { allowWithoutAsking: false }, { [TOKEN]: "t" })).status, 200);
    assert.equal(await read(), false);
    for (const [who, h] of notThePage()) assert.equal((await call("PUT", "/api/settings/context-approval", { allowWithoutAsking: true }, h)).status, 403, who);
    assert.equal(await read(), false);
    assert.equal((await call("PUT", "/api/settings/context-approval", { allowWithoutAsking: true }, pageHeaders())).status, 200);
    assert.equal(await read(), true);
    assert.equal((await call("PUT", "/api/settings/context-approval", { allowWithoutAsking: "yes" }, pageHeaders())).status, 400);
  });
});
