// Run: pnpm test -- server/default-profile-accounts.test.ts. A throwaway agent dir and Claude Code directory;
// ~/.pi and ~/.claude are never read or written.
//
// The default before one is chosen (§chat.profiles/default): worked out from the accounts connected here each time
// (a Claude sign-in, then pi's own OpenAI sign-in, then an Ollama Cloud key), with nothing written; Make Default
// writes it, and from then on it never moves by itself. A coding session started now takes it whole, as a new chat
// does (§app.project-overseer/coding-mode). Sova's own runs (a playbook card's) keep no helper profile.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-default-accounts-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
const claudeDir = join(root, "claude");
mkdirSync(agentDir, { recursive: true });
mkdirSync(claudeDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CLAUDE_CONFIG_DIR = claudeDir;

const { resolveDefaultProfile, chooseDefaultProfile } = await import("./default-profile");
const { joinedProfiles } = await import("./joined-profiles");
const { cardHelpers } = await import("./playbook-runs/env");
const { codingDefaultProfile, codingTakesOf } = await import("./coding-default-profile");
const { codingChoice, codingModeNow, codingModeNowWords } = await import("./project-overseer");

const authFile = join(agentDir, "auth.json");
const claudeCreds = join(claudeDir, ".credentials.json");
const signIn = (accounts: { claude?: boolean; openai?: boolean; ollama?: boolean }) => {
  rmSync(claudeCreds, { force: true });
  if (accounts.claude) writeFileSync(claudeCreds, JSON.stringify({ claudeAiOauth: { accessToken: "t" } }));
  writeFileSync(authFile, JSON.stringify({
    ...(accounts.openai ? { "openai-codex": { type: "oauth", access: "t" } } : {}),
    ...(accounts.ollama ? { "ollama-cloud": { type: "api_key", key: "k" } } : {}),
  }));
};
/** Every file in the agent dir and its state root, so a test can say nothing was written. */
const files = () => [...readdirSync(agentDir), ...(existsSync(join(agentDir, "sova")) ? readdirSync(join(agentDir, "sova")).map((f) => `sova/${f}`) : [])].sort();

test("not chosen yet (review b2): the connected accounts decide, each time, and nothing is written", async () => {
  // [accounts, the default's key]; in an order that moves the chip both ways.
  const steps: [Parameters<typeof signIn>[0], string][] = [
    [{ openai: true }, "sova:openai"],
    [{ openai: true, claude: true }, "sova:claude"],
    [{ ollama: true }, "sova:deepseek"],
    [{ ollama: true, openai: true }, "sova:openai"],
    // Nothing connected: no built-in profile, so no default at all (the no-profile row, which nothing names).
    [{}, "sova:default"],
  ];
  for (const [accounts, key] of steps) {
    signIn(accounts);
    const before = files();
    const d = await resolveDefaultProfile();
    assert.deepEqual([d.row.key, d.info.chosen, d.fromAccounts], [key, false, key !== "sova:default"], JSON.stringify(accounts));
    assert.equal(d.info.fromAccounts, key !== "sova:default" ? true : undefined, "the listing says it is the accounts' (Settings lets its row be deleted)");
    const listed = (await joinedProfiles()).filter((r) => r.group === "builtin").map((r) => r.key);
    assert.deepEqual(listed, key === "sova:default" ? [] : listed.filter((k) => k.startsWith("sova:")), JSON.stringify(accounts));
    if (key === "sova:default") assert.deepEqual([listed, d.info.name, d.row.library, d.row.session], [[], "", undefined, undefined], "no built-in listed, nothing named");
    assert.deepEqual(files(), before, `${JSON.stringify(accounts)}: nothing written`);
  }
  assert.equal(existsSync(join(agentDir, "subagent-profiles.json")), false);
  assert.equal(existsSync(join(agentDir, "subagent-profiles-default.json")), false);
  assert.equal(existsSync(join(agentDir, "sova", "default-profile.json")), false);
});

test("Make Default writes the file; from then on the default never moves by itself", async () => {
  signIn({ openai: true });
  const rows = await joinedProfiles();
  chooseDefaultProfile(rows.find((r) => r.key === "sova:openai")!, rows);
  signIn({ openai: true, claude: true });
  const d = await resolveDefaultProfile();
  assert.deepEqual([d.row.key, d.info.chosen, d.fromAccounts, d.info.fromAccounts], ["sova:openai", true, false, undefined]);
  rmSync(join(agentDir, "sova", "default-profile.json"));
  rmSync(join(agentDir, "subagent-profiles-default.json"), { force: true });
});

test("a playbook card's run (review b3): no default chosen gives no helper profile, whatever is connected", () => {
  signIn({ openai: true, claude: true });
  const r = cardHelpers(agentDir);
  assert.equal(r.delegate, null);
  assert.equal(r.reviewer, null);
  assert.equal(r.spec.writer, null);
  assert.equal(r.teams.state, "absent");
});

test("a coding session on a default nobody chose takes the built-in profile whole, after the project's coding model", () => {
  writeFileSync(join(agentDir, "sova", "defaults.json"), JSON.stringify({ version: 1, model: "openai/older-default", thinking: "low" }));
  const settings = { model: null, thinking: null, codingModel: null, codingThinking: null, gatheringModel: null, gatheringThinking: null };
  const running = { model: null, thinking: null };
  try {
    signIn({ claude: true });
    const takes = codingTakesOf(codingDefaultProfile());
    assert.deepEqual([takes.id, takes.model, takes.thinking, takes.subagents], ["claude", "claude-code-cli/claude-opus-5-5", "medium", "claude"]);
    assert.deepEqual(codingChoice({}, settings, running, takes), { model: "claude-code-cli/claude-opus-5-5", thinking: "medium" }, "no project coding model: the built-in's");
    assert.deepEqual(codingChoice({}, { ...settings, codingModel: "openai/project-coder", codingThinking: "high" }, running, takes), { model: "openai/project-coder", thinking: "high" }, "the project's coding model wins");
    // Nothing connected: no default profile; no helpers, the older new-chat model.
    signIn({});
    const none = codingTakesOf(codingDefaultProfile());
    assert.deepEqual([none.id, none.name, none.model, none.thinking, none.subagents], ["off", "", undefined, undefined, undefined]);
    assert.deepEqual(codingChoice({}, settings, running, none), { model: "openai/older-default", thinking: "low" });
    const now = codingModeNow();
    assert.equal(now.profile, undefined, "the project overseer names no profile");
    assert.doesNotMatch(codingModeNowWords(now), /on ,|\bOff\b/);
    assert.equal(existsSync(join(agentDir, "sova", "default-profile.json")), false, "nothing chosen or written");
  } finally {
    rmSync(join(agentDir, "sova", "defaults.json"), { force: true });
  }
});

test("a default file that can't be read says so without naming Off, which is no choice any more", async () => {
  const { readDefaultProfileFile } = await import("./default-profile");
  const f = join(root, "bad-default.json");
  writeFileSync(f, JSON.stringify({ version: 2 }));
  const read = readDefaultProfileFile(f);
  assert.equal(read.state, "malformed");
  assert.ok(read.state === "malformed" && !/\boff\b/i.test(read.error), read.state === "malformed" ? read.error : "");
});
