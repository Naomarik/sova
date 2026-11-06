// Run: pnpm test:int -- server/subfolder-skills-claude.integration.test.ts
// The whole chain on a Claude Code chat and worker: a hermetic server (server/testing/hermetic-server.ts), each
// chat in its own process, the real bridge, the stand-in `claude` (scripts/fake-claude.mjs) as the model. The
// stand-in's reply holds the very text the bridge returned for the tool, so the assertions read what the model got.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { linkPiConfigExtensions } from "./testing/agent-dir";
import { startHermeticServer, type HermeticServer } from "./testing/hermetic-server";

let s: HermeticServer;
let project = "";
const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} does things\n---\n\nThe ${name} recipe.\n`;
before(async () => {
  s = await startHermeticServer({ bootTimeoutMs: 60_000 });
  // The Claude Code provider is pi-config's: linked in, then the server boots again so its runtime has it too.
  linkPiConfigExtensions(s.agentDir);
  await s.restart();
  project = join(s.work, "project");
  const files: Record<string, string> = {
    ".claude/skills/top/SKILL.md": skill("top"),
    "svc/a.txt": "a file\n",
    "svc/edit-me.txt": "a file\n",
    "svc/CLAUDE.md": "svc rules\n",
    "svc/.claude/skills/svc-skill/SKILL.md": skill("svc-skill"),
    "web/.claude/skills/web-skill/SKILL.md": skill("web-skill"),
    "deep/.agents/skills/deep-skill/SKILL.md": skill("deep-skill"),
    "deep/d.txt": "d\n",
  };
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(project, p)), { recursive: true });
    writeFileSync(join(project, p), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: project });
});
after(async () => {
  await s?.stop();
});

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${s.base}${path}`, { method, headers: { "x-sova-token": s.token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  try {
    return { status: r.status, body: JSON.parse(text) };
  } catch {
    return { status: r.status, body: text };
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Entry = { message?: { role?: string; stopReason?: string; content?: { text?: string }[] } };
const entries = (path: string): Entry[] => readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Entry);
const said = (e: Entry | undefined) => (e?.message?.content ?? []).map((b) => b.text ?? "").join("");
const lastReply = (path: string) => entries(path).filter((e) => e.message?.role === "assistant").at(-1);

async function send(text: string): Promise<{ path: string; reply: string }> {
  const made = await api("POST", "/api/sessions", { cwd: project });
  assert.equal(made.status < 300, true, JSON.stringify(made.body));
  const path = made.body.path as string;
  const set = await api("POST", "/api/sessions/configure", { path, model: "claude-code-cli/claude-haiku-5-5" });
  assert.equal(set.status < 300, true, JSON.stringify(set.body));
  const sent = await api("POST", "/api/sessions/prompt", { path, text });
  assert.equal(sent.status < 300, true, JSON.stringify(sent.body));
  for (const end = Date.now() + 60_000; Date.now() < end; await sleep(200)) {
    const last = lastReply(path);
    if (last && last.message!.stopReason !== "toolUse" && said(last)) return { path, reply: said(last) };
  }
  throw new Error(`no reply in ${path}\n${s.log().slice(-1500)}`);
}

for (const [tool, args, dir] of [
  ["read", '{"path":"svc/a.txt"}', "svc"],
  ["edit", '{"path":"svc/edit-me.txt","edits":[{"oldText":"file","newText":"FILE"} ]}', "svc"],
  ["write", '{"path":"web/created.txt","content":"x"}', "web"],
] as const) {
  test(`a Claude Code chat's ${tool}: the model gets the folder's skills through the bridge`, async () => {
    const { reply } = await send(`[fake-tool ${tool} ${args}]`);
    assert.match(reply, /^Fake tool result:/, reply);
    assert.match(reply, new RegExp(`<sova-skills dir="${dir}">`), reply);
  });
}

test("a Claude Code chat's shell command: nothing", async () => {
  const { reply } = await send('[fake-tool bash {"command":"cat svc/a.txt"}]');
  assert.match(reply, /a file/, "the command ran");
  assert.doesNotMatch(reply, /<sova-skills|<sova-instructions/);
});

test("a Claude Code worker a chat started: its read's result reaches its model with the skills", async () => {
  const inner = '{\\"path\\":\\"deep/d.txt\\"}';
  // The stand-in's own pattern ends at the first `}]`, so the worker's closing bracket is escaped here.
  const parent = await send(`[fake-tool agent_spawn {"prompt":"[fake-tool read ${inner}\\u005d","backend":"claude-code","model":"claude-haiku-5-5","wake":false}]`);
  assert.match(parent.reply, /Started 1 background/, parent.reply);
  let reply = "";
  for (const end = Date.now() + 60_000; Date.now() < end && !reply; await sleep(250)) {
    const files = execFileSync("grep", ["-rl", "--include=*.jsonl", "deep/d.txt", join(s.agentDir, "sessions")], { encoding: "utf8" }).split("\n").filter((f) => f && f !== parent.path);
    for (const f of files) {
      const said1 = said(lastReply(f));
      if (said1.startsWith("Fake tool result")) reply = said1;
    }
  }
  assert.match(reply, /<sova-skills dir="deep">/, reply || s.log().slice(-1500));
});
