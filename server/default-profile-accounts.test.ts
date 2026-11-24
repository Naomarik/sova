// Run: pnpm test -- server/default-profile-accounts.test.ts. A throwaway agent dir and Claude Code directory;
// ~/.pi and ~/.claude are never read or written.
//
// The default before one is chosen (§chat.profiles/default): worked out from the accounts connected here each time
// (a Claude sign-in, then pi's own OpenAI sign-in, then an Ollama Cloud key), with nothing written; Make Default
// writes it, and from then on it never moves by itself. Sova's own runs (a playbook card's) keep no helper profile.
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
    [{}, "sova:claude"],
  ];
  for (const [accounts, key] of steps) {
    signIn(accounts);
    const before = files();
    const d = await resolveDefaultProfile();
    assert.deepEqual([d.row.key, d.info.chosen, d.fromAccounts], [key, false, true], JSON.stringify(accounts));
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
  assert.deepEqual([d.row.key, d.info.chosen, d.fromAccounts], ["sova:openai", true, false]);
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
