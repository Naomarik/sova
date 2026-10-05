#!/usr/bin/env node
// A stand-in for the Claude Code CLI, for tests and hermetic runs: it never contacts Anthropic and
// holds no real credential. Put a `claude` shim that execs it first on PATH (see
// scripts/fake-claude-path.sh) to drive Settings → Accounts and login failover end to end.
//
//   claude --version
//   claude auth login --claudeai   prints the sign-in URL, reads one line "code#state":
//                                  "ok…#…" signs in (writes .credentials.json and .claude.json
//                                  into $CLAUDE_CONFIG_DIR, identity from the code: ok-<name>#…),
//                                  "bad…#…" fails, a line without "#" is an invalid code
//   claude auth logout             removes .credentials.json
//   With FAKE_CLAUDE_KEYCHAIN=<dir>, login and logout write and remove <dir>/<service> instead of
//   .credentials.json, <service> named as macOS Claude Code names its keychain item (tests of the
//   macOS keychain path, pi-config/extensions/claude-code/keychain.ts).
//   claude auth status --json
//   claude -p --input-format stream-json …   answers initialize, interrupt, and each user message
//                                  with one text reply naming the login it ran on; a login dir
//                                  holding FAKE_LIMIT answers with a usage limit instead, one
//                                  holding FAKE_AUTH with a failed sign-in. A message containing
//                                  "[fake-slow <ms>]" streams its first words, then waits <ms>
//                                  before it finishes (a turn still running).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const out = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
const keychain = process.env.FAKE_CLAUDE_KEYCHAIN;
const configDir = process.env.CLAUDE_CONFIG_DIR;
const credentialsPath = keychain
  ? join(keychain, `Claude Code-credentials${configDir ? `-${createHash("sha256").update(configDir.normalize("NFC")).digest("hex").slice(0, 8)}` : ""}`)
  : join(dir, ".credentials.json");

if (args[0] === "--version") {
  process.stdout.write("0.0.0-fake (Claude Code)\n");
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "login") {
  process.stdout.write("Opening browser to sign in…\n");
  process.stdout.write("If the browser didn't open, visit: https://claude.example.invalid/fake-sign-in?code=true&fake=1\n");
  process.stdout.write("Paste code here if prompted > ");
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const [code, state] = line.trim().split("#");
    if (!code || !state) {
      process.stderr.write("Invalid code. Please make sure the full code was copied.\n");
      return;
    }
    if (code.startsWith("bad")) {
      process.stderr.write("Login failed: Request failed with status code 400\n");
      process.exit(1);
    }
    const name = code.replace(/^ok-?/, "") || "user";
    mkdirSync(dir, { recursive: true });
    writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: "fake", refreshToken: "fake", expiresAt: Date.now() + 8 * 3600_000 } }), { mode: 0o600 });
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({
      hasCompletedOnboarding: true,
      oauthAccount: { accountUuid: `acct-${name.split("+")[0]}`, emailAddress: `${name}@example.com`, organizationUuid: `org-${name}`, organizationName: `${name}'s org`, subscriptionType: "max" },
    }));
    process.stdout.write("\nLogin successful.\n");
    process.exit(0);
  });
  rl.on("close", () => process.exit(1));
} else if (args[0] === "auth" && args[1] === "logout") {
  rmSync(credentialsPath, { force: true });
  process.stdout.write("Successfully logged out from your Anthropic account.\n");
  process.exit(0);
} else if (args[0] === "auth" && args[1] === "status") {
  const loggedIn = existsSync(credentialsPath);
  let account = {};
  try { account = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")).oauthAccount ?? {}; } catch {}
  out({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none", ...(loggedIn ? { email: account.emailAddress, orgName: account.organizationName, subscriptionType: account.subscriptionType } : {}), configDirectory: dir });
  process.exit(loggedIn ? 0 : 1);
} else if (args.includes("-p")) {
  const sessionId = args[args.indexOf("--session-id") + 1] ?? args[args.indexOf("--resume") + 1] ?? randomUUID();
  const who = basename(dir);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    if (frame.type === "control_request") {
      // Discovery (buildDiscoveryArgv) reads the initialize answer's model list; the fake offers
      // exactly one so a hermetic server can put a session on claude-code-cli without Anthropic.
      const models = frame.request?.subtype === "initialize" ? [{ value: "fake-opus", displayName: "Fake Opus", supportedEffortLevels: ["low", "medium", "high"] }] : undefined;
      out({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: models ? { models } : {} } });
      return;
    }
    if (frame.type !== "user") return;
    const uuid = frame.uuid;
    out({ type: "system", subtype: "init", session_id: sessionId, model: "fake", mcp_servers: [] });
    if (uuid) out({ type: "user", isReplay: true, uuid, session_id: sessionId, message: frame.message });
    const correlate = uuid ? { user_message_uuid: uuid } : {};
    if (existsSync(join(dir, "FAKE_LIMIT"))) {
      out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3 * 3600, rateLimitType: "five_hour" }, uuid: randomUUID(), session_id: sessionId });
      out({ type: "assistant", message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "You've hit your limit (fake)" }], stop_reason: "stop_sequence", usage: { input_tokens: 0, output_tokens: 0 } }, parent_tool_use_id: null, error: "rate_limit", uuid: randomUUID(), session_id: sessionId });
      out({ type: "result", subtype: "success", is_error: true, result: "You've hit your limit (fake)", num_turns: 1, session_id: sessionId, ...correlate });
      return;
    }
    if (existsSync(join(dir, "FAKE_AUTH")) || !existsSync(join(dir, ".credentials.json"))) {
      out({ type: "assistant", message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "Not logged in · Please run /login" }], stop_reason: "stop_sequence", usage: { input_tokens: 0, output_tokens: 0 } }, parent_tool_use_id: null, error: "authentication_failed", uuid: randomUUID(), session_id: sessionId });
      out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", num_turns: 1, session_id: sessionId, ...correlate });
      return;
    }
    const text = `Fake answer from login ${who}.`;
    const said = JSON.stringify(frame.message?.content ?? "");
    const slow = Number(/\[fake-slow (\d+)\]/.exec(said)?.[1] ?? 0);
    out({ type: "stream_event", event: { type: "message_start", message: { model: "fake", usage: { input_tokens: 10, output_tokens: 0 } } }, session_id: sessionId });
    out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, session_id: sessionId });
    if (slow) {
      out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Working… " } }, session_id: sessionId });
      setTimeout(() => finish(), slow);
      return;
    }
    finish();
    function finish() {
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, session_id: sessionId });
    out({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, session_id: sessionId });
    out({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 8 } }, session_id: sessionId });
    out({ type: "stream_event", event: { type: "message_stop" }, session_id: sessionId });
    out({ type: "assistant", message: { model: "fake", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 8 } }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: "result", subtype: "success", is_error: false, result: text, num_turns: 1, session_id: sessionId, usage: { input_tokens: 10, output_tokens: 8 }, ...correlate });
    }
  });
  rl.on("close", () => process.exit(0));
} else {
  process.stderr.write(`fake claude: unsupported arguments ${JSON.stringify(args)}\n`);
  process.exit(2);
}
