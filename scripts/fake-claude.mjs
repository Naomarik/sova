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
//                                  A message asking for a <handoff> note gets one.
//   With FAKE_CLAUDE_ONESHOT=1, a -p run without --input-format stream-json (a one-shot, such as a
//                                  memory summary) reads its whole input and answers one result
//                                  envelope, "Fake summary: <the input's last line, cut>"; without it,
//                                  a one-shot answers nothing, as before. FAKE_CLAUDE_ONESHOT_MS=<ms>
//                                  holds each such answer that long (a summarizer that takes time).
//   With FAKE_CLAUDE_RECORD=<file>, every -p run appends to <file> one JSON line per request: its
//                                  argv, and the initialize request, user frame or one-shot input it
//                                  was sent (the system prompt rides in the argv or the initialize),
//                                  so a test reads what the "model" saw. With it set, each user
//                                  frame is first answered by asking the host's SDK MCP server (the
//                                  initialize's sdkMcpServers) for tools/list over the control channel,
//                                  as the real CLI does, and the line carries `tools`: the tool names
//                                  the model was offered for that turn, and `schemas`: each one's
//                                  input schema, by name.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const out = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
/** One request, appended to FAKE_CLAUDE_RECORD when it is set (what the "model" was sent). */
const record = (v) => {
  if (process.env.FAKE_CLAUDE_RECORD) appendFileSync(process.env.FAKE_CLAUDE_RECORD, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...v })}\n`);
};
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
} else if (args.includes("-p") && !args.includes("stream-json") && process.env.FAKE_CLAUDE_ONESHOT === "1") {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => {
    record({ argv: args, oneshot: input });
    const last = input.trim().split("\n").filter(Boolean).at(-1) ?? "";
    const result = `Fake summary: ${last.slice(0, 120)}`;
    setTimeout(() => {
      out({ type: "result", subtype: "success", is_error: false, result, num_turns: 1, session_id: randomUUID(), usage: { input_tokens: 10, output_tokens: 8 } });
      process.exit(0);
    }, Number(process.env.FAKE_CLAUDE_ONESHOT_MS) || 0);
  });
} else if (args.includes("-p")) {
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  // A fork (--resume <id> --fork-session) is a new session; --session-id names it when given.
  const sessionId = flag("--session-id") ?? (args.includes("--fork-session") ? randomUUID() : flag("--resume")) ?? randomUUID();
  const who = basename(dir);
  /** The host's SDK MCP servers, named by the initialize; asked for tools/list when recording. */
  let sdkServers = [];
  /** Our own control_requests to the host, waiting for their control_response. */
  const asked = new Map();
  let askedSeq = 0;
  const ask = (request) => new Promise((resolve) => {
    const id = `fake-${++askedSeq}`;
    asked.set(id, resolve);
    out({ type: "control_request", request_id: id, request });
  });
  /** The tool names the host's MCP servers offer now (bare, as tools/list publishes them), and each one's input schema. */
  const offeredTools = async () => {
    const names = [];
    const schemas = {};
    for (const server of sdkServers) {
      const r = await ask({ subtype: "mcp_message", server_name: server, message: { jsonrpc: "2.0", id: askedSeq + 1, method: "tools/list" } });
      for (const t of r?.response?.mcp_response?.result?.tools ?? []) {
        names.push(t.name);
        schemas[t.name] = t.inputSchema ?? null;
      }
    }
    return { names, schemas };
  };
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    if (frame.type === "control_response") {
      const resolve = asked.get(frame.response?.request_id);
      if (resolve) { asked.delete(frame.response.request_id); resolve(frame.response); }
      return;
    }
    if (frame.type === "control_request") {
      if (frame.request?.subtype === "initialize") {
        record({ argv: args, initialize: frame.request });
        sdkServers = Array.isArray(frame.request.sdkMcpServers) ? frame.request.sdkMcpServers : [];
      }
      // Discovery (buildDiscoveryArgv) reads the initialize answer's model list; the fake offers
      // exactly one so a hermetic server can put a session on claude-code-cli without Anthropic.
      const models = frame.request?.subtype === "initialize" ? [{ value: "fake-opus", displayName: "Fake Opus", supportedEffortLevels: ["low", "medium", "high"] }] : undefined;
      out({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: models ? { models } : {} } });
      return;
    }
    if (frame.type !== "user") return;
    if (process.env.FAKE_CLAUDE_RECORD && sdkServers.length) offeredTools().then(({ names, schemas }) => { record({ argv: args, frame, tools: names, schemas }); turn(frame); });
    else { record({ argv: args, frame }); turn(frame); }
  });
  function turn(frame) {
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
    const said = JSON.stringify(frame.message?.content ?? "");
    // Asked for a handoff note (/compact-handoff's fork), it writes one.
    const text = said.includes("<handoff>") ? `<handoff>HANDOFF-NOTE fake claude, login ${who}</handoff>` : `Fake answer from login ${who}.`;
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
  }
  rl.on("close", () => process.exit(0));
} else {
  process.stderr.write(`fake claude: unsupported arguments ${JSON.stringify(args)}\n`);
  process.exit(2);
}
