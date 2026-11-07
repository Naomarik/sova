// Run: pnpm test -- server/shell-model.test.ts. What the model is sent of a finished `!` command
// (§chat.shell-mode/model), read off the request itself on real pi with a ScriptedModel in a held chat: one line
// naming the whole command, the output cut to its last SHELL_MODEL_CHARS characters, and one line with the path
// of a file holding the whole output (the harness's when it cut it, else one Sova writes, 0600); a short output
// as it is; a `!!` command nothing at all. The provider gets the chat's context after this cut, so a Claude Code
// chat is sent the same. One throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ScriptedModel, scriptedModelsJson } from "./harness/pi/testing/scripted-model";
import { piSession } from "./harness/pi/testing/handle";
import { linkPiConfigExtensions } from "./testing/agent-dir";

for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];
const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-shell-model-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--shell-model--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(root, "cwd");
mkdirSync(cwd, { recursive: true });
linkPiConfigExtensions(agentDir);
writeFileSync(join(agentDir, "models.json"), JSON.stringify(scriptedModelsJson()));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "scripted", defaultModel: "scripted", retry: { enabled: false } }));

const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
const { markOwned } = await import("./write-guard");
const { addWebSession } = await import("./web-sessions");
const { SHELL_MODEL_CHARS, ownOutputPath } = await import("./shell-model");

after(async () => {
  await disposeAllChats();
  rmSync(root, { recursive: true, force: true });
});

const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} line ${i}`).join("\n");

test("a long ! output is sent as its tail with the whole output's path; a short one whole; a !! one not at all", async () => {
  const id = "0199ffff-0000-7000-8000-000000000001";
  const path = canonicalPath(join(sessionsDir, `2026-11-07T00-00-00-000Z_${id}.jsonl`));
  const piFile = join(root, "pi-bash-0123456789abcdef.log");
  writeFileSync(piFile, "the harness's whole output");
  const long = lines(400, "LONG");
  const cutByPi = lines(400, "PICUT");
  const bash = (eid: string, parentId: string | null, command: string, output: string, extra: Record<string, unknown> = {}) =>
    ({ type: "message", id: eid, parentId, timestamp: "2026-11-07T00:00:01.000Z", message: { role: "bashExecution", command, output, exitCode: 0, cancelled: false, truncated: false, timestamp: 1730937600000 + eid.length, ...extra } });
  const file = [
    { type: "session", version: 3, id, timestamp: "2026-11-07T00:00:00.000Z", cwd },
    bash("b1", null, "make all\n  && make check", long),
    bash("b22", "b1", "echo hi", "hi\n"),
    bash("b333", "b22", "cat HUSH.env", "HUSH_SECRET\n", { excludeFromContext: true }),
    bash("b4444", "b333", "seq", cutByPi, { truncated: true, fullOutputPath: piFile }),
  ];
  writeFileSync(path, `${file.map((l) => JSON.stringify(l)).join("\n")}\n`);
  markOwned(path);
  addWebSession(id);
  const chat = await acquireChat(path, true);
  const model = new ScriptedModel().attach(piSession(chat));
  chat.attach({ send: () => {}, sendRaw: () => {} } as never);
  model.reply({ text: "ok" });
  await chat.harness.send("what ran?");
  const ctx = model.calls.at(-1)!.context as { messages: { role: string; content: string | { type: string; text?: string }[] }[] };
  const texts = ctx.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? "").join("")));
  const ran = (cmd: string) => texts.find((t) => t.startsWith(`Ran \`${cmd}`));

  const big = ran("make all")!;
  assert.ok(big, "the long command is sent");
  assert.ok(big.startsWith("Ran `make all\n  && make check`\n"), "the whole command");
  assert.ok(big.includes(long.slice(-SHELL_MODEL_CHARS)), "its tail");
  assert.ok(!big.includes("LONG line 0\n"), "not its head");
  assert.match(big, /earlier characters cut; the whole output is in the file named below/);
  const own = ownOutputPath(1730937600000 + 2, "make all\n  && make check", long);
  assert.ok(big.endsWith(`[Output truncated. Full output: ${own}]`), "one line with the whole output's path");
  assert.equal(readFileSync(own, "utf8"), long, "Sova wrote the whole output there");
  assert.equal(statSync(own).mode & 0o777, 0o600);

  const piCut = ran("seq")!;
  assert.ok(piCut.endsWith(`[Output truncated. Full output: ${piFile}]`), "the harness's own file when it cut it");
  assert.ok(piCut.length < SHELL_MODEL_CHARS + 400, "cut to about 500 tokens");

  assert.equal(ran("echo hi"), "Ran `echo hi`\n```\nhi\n\n```", "a short output as it is");
  assert.doesNotMatch(JSON.stringify(ctx), /HUSH/, "a !! command: nothing");
  rmSync(own, { force: true });
  assert.equal(existsSync(own), false);
});
