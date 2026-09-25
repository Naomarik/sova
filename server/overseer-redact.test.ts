// Run: npx tsx --test server/overseer-redact.test.ts (or npm test). HOME and PI_CODING_AGENT_DIR
// point at a throwaway dir in the OS temp dir (removed after), so the credential files the server
// reads are fakes; the real home is never read. Values are fake too, and never printed: `leaked`
// names which fake leaked, not its value.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-overseer-redact-")));
const home = join(root, "home");
const agentDir = join(root, "agent");
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = agentDir;
const put = (p: string, text: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};

const fake = (tag: string, n = 40) => `${tag}-${Array.from({ length: n }, (_, i) => "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"[(i * 7 + tag.length * 13 + tag.charCodeAt(0)) % 62]).join("")}`;
const V = {
  piKey: fake("rdPiKey"),
  piAccess: fake("rdPiAccess", 1500), // an OAuth access token longer than a transcript row (1000)
  piRefresh: fake("rdPiRefresh"),
  agentKey: fake("rdAgentKey"),
  ccAccess: fake("rdCcAccess", 100),
  ccRefresh: fake("rdCcRefresh", 100),
  ccApiKey: fake("rdCcApiKey"),
  modelsKey: fake("rdModelsKey"),
  modelsHeader: fake("rdModelsHdr"),
  envToken: fake("rdEnvToken"),
  jevKey: fake("rdJevKey", 100), // Sova's own plain-text key file (decide-secret.ts)
};
/** Present but not secret: must come through untouched. */
const PLAIN = {
  accountUser: "rd-user-id-0000-not-a-secret", // ~/.claude.json, beside primaryApiKey
  tier: "default_claude_max_20x", // .credentials.json rateLimitTier
  scope: "user:inference-and-more", // .credentials.json scopes
  envPlain: "rd-plain-env-value-not-secret", // a variable whose name isn't secret-like
  author: "someone@example.invalid", // GIT_AUTHOR_EMAIL
};
const marker = join(root, "command-ran");
const command = `!touch ${marker}; echo rd-command-output-value`;

put(join(home, ".pi", "agent", "auth.json"), JSON.stringify({ zai: { type: "api_key", key: V.piKey }, codex: { type: "oauth", access: V.piAccess, refresh: V.piRefresh, expires: 1790000000000 } }));
put(join(agentDir, "auth.json"), JSON.stringify({ other: { type: "api_key", key: V.agentKey } }));
put(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: V.ccAccess, refreshToken: V.ccRefresh, expiresAt: 1790000000000, scopes: [PLAIN.scope], rateLimitTier: PLAIN.tier } }));
put(join(home, ".claude.json"), JSON.stringify({ primaryApiKey: V.ccApiKey, userID: PLAIN.accountUser }));
put(
  join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      p: {
        baseUrl: "https://models.example.invalid/v1",
        apiKey: V.modelsKey,
        headers: { "X-Run": command, Authorization: "Bearer ${RD_SOME_ENV}" },
        models: [{ id: "m", headers: { "X-Other": V.modelsHeader } }],
      },
      q: { apiKey: "$RD_ANOTHER_ENV" },
    },
  }),
);
put(join(agentDir, "sova", "secrets", "jev-key"), `${V.jevKey}\n`);
process.env.RD_TEST_API_TOKEN = V.envToken;
process.env.RD_TEST_PLAIN = PLAIN.envPlain;
process.env.GIT_AUTHOR_EMAIL = PLAIN.author;

const { REDACTED, REDACTING, Redactor, redactingTool, isSecretEnvName, modelsJsonValues, redactPatterns, serverRedactor } = await import("./overseer-redact");
const { overseerFileTools } = await import("./overseer-file-tools");
const { briefText, buildOverseerTools, renderOverseerPrompt, extraInstructions } = await import("./overseer");
const { logAction, overseerActionsFile, overseerNotesFile, readNotes, readOverseerSettings, writeNotes } = await import("./overseer-store");
const { disposeAllChats } = await import("./chat-manager");

after(async () => {
  await disposeAllChats();
  rmSync(root, { recursive: true, force: true });
});

/** Which fake values appear in `text` (names only), whole or by a 16-character start or end. */
function leaked(text: string): string[] {
  return Object.entries(V).filter(([, v]) => text.includes(v) || text.includes(v.slice(0, 16)) || text.includes(v.slice(-16))).map(([k]) => k);
}
const noLeak = (text: string, what: string) => assert.deepEqual(leaked(text), [], `${what} leaks`);
const textOf = (r: { content: unknown }) => (r.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("");

describe("where the values come from", () => {
  test("every source's values are redacted; neighbouring non-secret fields and variables are not", () => {
    const r = serverRedactor();
    for (const [k, v] of Object.entries(V)) assert.equal(r.redact(`x ${v} y`), `x ${REDACTED} y`, k);
    for (const [k, v] of Object.entries(PLAIN)) assert.equal(r.redact(`x ${v} y`), `x ${v} y`, k);
  });

  test("models.json: a `!command` is never run (nor taken as a value); `$ENV` parts are not literals", () => {
    serverRedactor();
    assert.equal(existsSync(marker), false, "the command ran");
    assert.deepEqual(
      modelsJsonValues({ providers: { p: { apiKey: command, headers: { A: "Bearer ${X_TOKEN}", B: "$ONLY_ENV", C: "${X}-literal-part-long" } } } }),
      ["-literal-part-long"],
    );
    assert.equal(serverRedactor().redact(command), command);
  });

  test("env-name heuristic: KEY, TOKEN, SECRET, PASSWORD, AUTH; not AUTHOR/AUTHORITY", () => {
    for (const n of ["OPENAI_API_KEY", "GH_TOKEN", "CLAUDE_CODE_MESSAGING_TOKEN", "AWS_SECRET_ACCESS_KEY", "PGPASSWORD", "BASIC_AUTH", "OAUTH_CLIENT", "api_key"])
      assert.equal(isSecretEnvName(n), true, n);
    for (const n of ["HOME", "PATH", "GIT_AUTHOR_EMAIL", "XAUTHORITY", "PI_CODING_AGENT_DIR", "TERM"]) assert.equal(isSecretEnvName(n), false, n);
  });

  test("short values, paths and plain URLs are never treated as secrets", () => {
    const r = new Redactor([], { A_TOKEN: "short", B_KEY: "/run/user/1000/keyring", C_AUTH: "https://example.invalid/x", D_SECRET: "12345678901234" }).refresh();
    assert.equal(r.redact("short /run/user/1000/keyring https://example.invalid/x 12345678901234"), "short /run/user/1000/keyring https://example.invalid/x 12345678901234");
  });
});

describe("the redactor", () => {
  const r = () => serverRedactor();
  test("a secret cut short at either end is redacted from 16 characters on", () => {
    assert.equal(r().redact(`key: ${V.piKey.slice(0, 20)}…`), `key: ${REDACTED}…`);
    assert.equal(r().redact(`…${V.piKey.slice(-20)} end`), `…${REDACTED} end`);
    assert.equal(r().redact(`${V.piAccess.slice(0, 999)}… [truncated]`), `${REDACTED}… [truncated]`);
    // Under 16 characters of a cut stays (the rule's stated floor).
    assert.equal(r().redact(`${V.piKey.slice(0, 10)}…`), `${V.piKey.slice(0, 10)}…`);
  });

  test("ordinary text is returned as is (the same string)", () => {
    const t = "An ordinary line: const x = 1; // no secrets\nsk-ant-oat01- is only a prefix.";
    assert.equal(r().redact(t), t);
  });

  test("stat-gated: an unchanged file is not re-read; a rewrite (mtime/size) is", () => {
    const f = join(root, "src", "auth.json");
    const a = fake("rdRefreshA");
    const b = fake("rdRefreshB", 50);
    put(f, JSON.stringify({ x: { key: a } }));
    let reads = 0;
    const red = new Redactor([{ path: f, pick: (j) => (reads++, [(j as { x: { key: string } }).x.key]) }], {});
    red.refresh().refresh().refresh();
    assert.equal(reads, 1);
    assert.equal(red.redact(a), REDACTED);
    put(f, JSON.stringify({ x: { key: b } }));
    const later = new Date(statSync(f).mtimeMs + 5000);
    utimesSync(f, later, later);
    assert.equal(red.refresh().redact(`${a} ${b}`), `${a} ${REDACTED}`);
    assert.equal(reads, 2);
  });

  test("the tool wrapper redacts arguments, text, details, partial updates and errors", async () => {
    const seen: unknown[] = [];
    const updates: unknown[] = [];
    const tool = redactingTool({
      name: "t",
      label: "t",
      description: "t",
      parameters: {} as never,
      execute: async (_id: string, params: unknown, _s: unknown, onUpdate?: (p: unknown) => void) => {
        seen.push(params);
        onUpdate?.({ content: [{ type: "text", text: `partial ${V.ccAccess}` }], details: undefined });
        if ((params as { fail?: boolean }).fail) throw new Error(`boom ${V.agentKey}`);
        return { content: [{ type: "text", text: `out ${V.ccRefresh}` }, { type: "image", data: "AAAA", mimeType: "image/png" }], details: { nested: [V.modelsKey] } };
      },
    } as never);
    const out = await (tool as any).execute("id", { note: `keep ${V.envToken}` }, undefined, (u: unknown) => updates.push(u), {});
    noLeak(JSON.stringify([seen, updates, out]), "the wrapper");
    assert.deepEqual(seen, [{ note: `keep ${REDACTED}` }]);
    assert.equal(out.content[1].data, "AAAA");
    await assert.rejects((tool as any).execute("id", { fail: true }, undefined, undefined, {}), (e: Error) => e.message === `boom ${REDACTED}`);
  });
});

describe("every Overseer tool is wrapped", () => {
  test("the sova_* tools and read/grep/find/ls all go through redactingTool", () => {
    const all = [...buildOverseerTools(), ...overseerFileTools(root)];
    assert.ok(all.length >= 20);
    for (const t of all) assert.equal((t as unknown as Record<symbol, boolean>)[REDACTING], true, t.name);
  });
});

describe("secret values in ordinary places come back redacted", () => {
  const project = join(root, "proj");
  const tools = Object.fromEntries(overseerFileTools(project).map((t) => [t.name, t]));
  const call = async (name: string, params: Record<string, unknown>) => textOf(await tools[name]!.execute("tc", params as never, undefined, undefined, undefined as never));
  const ordinary = "line one\nexport const answer = 42;\nTOKEN_NAME is just a word here\n";
  put(join(project, "notes.txt"), `copied: ANTHROPIC=${V.ccAccess}\nand ${V.piKey} again\nnothing here\n`);
  put(join(project, "plain.ts"), ordinary);
  // A copy under an innocent name, reached through a symlink: not denied by name, redacted by value.
  put(join(root, "elsewhere", "backup.txt"), JSON.stringify({ zai: { key: V.piKey }, other: { key: V.agentKey } }));

  test("read and grep of an ordinary file", async () => {
    const read = await call("read", { path: "notes.txt" });
    noLeak(read, "read");
    assert.match(read, /copied: ANTHROPIC=\[redacted\]\nand \[redacted\] again\nnothing here/);
    const grep = await call("grep", { pattern: "copied|again", path: project });
    noLeak(grep, "grep");
    assert.match(grep, /notes\.txt:1: copied: ANTHROPIC=\[redacted\]/);
    const copy = await call("read", { path: join(root, "elsewhere", "backup.txt") });
    noLeak(copy, "a renamed copy");
    // A pattern is searched as given (redacting it would search for something else); what it finds is redacted.
    const bySecret = await call("grep", { pattern: V.piKey, path: project, literal: true });
    noLeak(bySecret, "grep for a value");
    assert.equal(bySecret, "notes.txt:2: and [redacted] again");
    assert.equal(await call("grep", { pattern: "zzz-no-such-text", path: project }), "No matches found");
  });

  test("a normal project file is unchanged, byte for byte", async () => {
    const { createReadToolDefinition } = await import("@earendil-works/pi-coding-agent");
    const pi = textOf(await createReadToolDefinition(project).execute("tc", { path: "plain.ts" } as never, undefined, undefined, undefined as never));
    assert.equal(await call("read", { path: "plain.ts" }), pi, "the same as pi's own read");
    assert.ok(pi.includes(ordinary.trim()));
    assert.match(await call("grep", { pattern: "answer", path: project }), /^plain\.ts:2: export const answer = 42;$/m);
  });

  test("sova_read_session on a transcript that printed keys", async () => {
    const id = "019a7000-0000-7000-8000-00000000rd01";
    const lines = [
      { type: "session", version: 3, id, timestamp: "2026-09-25T00:00:00.000Z", cwd: "/tmp" },
      { type: "message", id: "m1", parentId: null, timestamp: "2026-09-25T00:00:01.000Z", message: { role: "user", content: `use ${V.piKey}` } },
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: "2026-09-25T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: `The token is ${V.piAccess}` },
            { type: "toolCall", id: "t1", name: "bash", arguments: { command: `curl -H 'x-api-key: ${V.ccApiKey}' https://x.invalid` } },
          ],
        },
      },
    ];
    put(join(agentDir, "sessions", "--tmp--", `2026-09-25T00-00-00-000Z_${id}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const readSession = buildOverseerTools().find((t) => t.name === "sova_read_session")!;
    const out = textOf(await readSession.execute("tc", { session: id } as never, undefined, undefined, undefined as never));
    noLeak(out, "sova_read_session");
    assert.match(out, /USER: use \[redacted\]/);
    assert.match(out, /ASSISTANT: The token is \[redacted\]…/, "the 1000-character cut of a longer token");
  });
});

describe("what the Overseer stores and is prompted with", () => {
  const tool = (name: string) => buildOverseerTools().find((t) => t.name === name)!;

  test("sova_note stores [redacted]; so does the action log", async () => {
    writeNotes("");
    await tool("sova_note").execute("n1", { op: "append", text: `API_TOKEN=${V.envToken} and ${V.piKey.slice(0, 30)}…` } as never, undefined, undefined, undefined as never);
    const notes = readNotes();
    noLeak(notes, "notes");
    assert.equal(notes, `API_TOKEN=${REDACTED} and ${REDACTED}…\n`);
    await tool("sova_note").execute("n2", { op: "replace", text: `just ${V.ccRefresh}` } as never, undefined, undefined, undefined as never);
    assert.equal(readFileSync(overseerNotesFile(), "utf8"), `just ${REDACTED}`);
    noLeak(readFileSync(overseerActionsFile(), "utf8"), "action log");
  });

  test("sova_confirm's card: title, detail and options", async () => {
    const out = await tool("sova_confirm").execute(
      "c1",
      { title: `Rotate ${V.agentKey}?`, detail: `It is ${V.modelsHeader}.`, options: [{ label: "Yes", reply: `yes ${V.ccAccess}` }, { label: `No ${V.modelsKey}` }] } as never,
      undefined,
      undefined,
      undefined as never,
    );
    noLeak(JSON.stringify(out), "the card");
    assert.equal((out.details as { title: string }).title, `Rotate ${REDACTED}?`);
    noLeak(readFileSync(overseerActionsFile(), "utf8"), "action log");
  });

  test("the action log never holds a value, whoever calls it", () => {
    logAction({ at: "2026-09-25T00:00:00.000Z", overseerId: "o", toolCallId: "x", tool: "sova_send", args: { message: `key ${V.piRefresh}` }, outcome: "error", error: `failed with ${V.ccApiKey}` });
    const log = readFileSync(overseerActionsFile(), "utf8");
    noLeak(log, "action log");
    assert.match(log, /"message":"key \[redacted\]"/);
  });

  test("the notes and the extra prompt are redacted before they reach the system prompt", () => {
    writeNotes(`remember ${V.agentKey}\nand ordinary text`);
    const prompt = renderOverseerPrompt(buildOverseerTools(), readOverseerSettings());
    noLeak(prompt, "the prompt");
    assert.match(prompt, /remember \[redacted\]\nand ordinary text/);
    const extra = extraInstructions(`be terse; my key is ${V.envToken}`).join("");
    noLeak(extra, "extra instructions");
    assert.match(extra, /be terse; my key is \[redacted\]$/);
    assert.deepEqual(extraInstructions("  "), []);
    writeNotes("");
  });

  test("a brief's titles and details from other sessions", () => {
    const text = briefText([{ kind: "error", id: "s1", title: `Deploy ${V.modelsKey}`, detail: `401 for ${V.envToken}` }] as never);
    noLeak(text, "the brief");
    assert.match(text, /\[Deploy \[redacted\]\]\(sova:\/\/s\/s1\) — 401 for \[redacted\]$/);
  });
});

describe("extension messages in the Overseer's context", () => {
  test("a worker's report is redacted on its way to the model; user messages and tool results are left alone", async () => {
    const { redactExtensionMessages } = await import("./overseer-redact");
    const secret = "Zq8vT3mN9pL2xR7wK4sB6yH1";
    const r = new Redactor([], { SOME_API_KEY: secret }).refresh();
    const report = { role: "custom", customType: "subagent-complete", content: `### ag_01 (explore §x) — waiting\nfound ${secret} in .env`, display: true };
    const parts = { role: "custom", customType: "explain-complete", content: [{ type: "text", text: `key ${secret}` }, { type: "image", data: "AAAA", mimeType: "image/png" }] };
    const user = { role: "user", content: `mine ${secret}` };
    const tool = { role: "toolResult", content: [{ type: "text", text: "already clean" }] };
    const out = redactExtensionMessages([user, report, parts, tool], r) as any[];
    assert.equal(out[0], user);
    assert.equal(out[1].content, "### ag_01 (explore §x) — waiting\nfound [redacted] in .env");
    assert.equal(out[2].content[0].text, "key [redacted]");
    assert.equal(out[2].content[1], parts.content[1], "an image is left alone");
    assert.equal(out[3], tool);
    const clean = [user, tool];
    assert.equal(redactExtensionMessages(clean, r), clean, "nothing to redact: the same array");
  });
});

describe("secrets recognised by shape (no credential file names them)", () => {
  // Every value here is fake and built in pieces, so the file itself holds no real-looking token.
  const cases: [string, string, string][] = [
    ["sk- key", `err: invalid key ${"sk-" + "test-FAKE0123456789abcdef"} used`, `err: invalid key ${REDACTED} used`],
    ["sk-proj- key", `${"sk-" + "proj-FAKEfakeFAKEfake1234567890"}`, REDACTED],
    ["sk-ant- key", `x ${"sk-" + "ant-api03-FAKE0123456789abcdefFAKE"} y`, `x ${REDACTED} y`],
    ["ghp_ token", `${"ghp_" + "FAKE0123456789abcdefFAKE0123"}`, REDACTED],
    ["gho_ token", `t=${"gho_" + "FAKE0123456789abcdefFAKE0123"}`, `t=${REDACTED}`],
    ["github_pat_", `${"github_pat_" + "11FAKE0123456789_abcdefFAKE0123456789"}`, REDACTED],
    ["AKIA id", `aws ${"AKIA" + "FAKE0123456789AB"} ok`, `aws ${REDACTED} ok`],
    ["ASIA id", `${"ASIA" + "FAKE0123456789AB"}`, REDACTED],
    ["xoxb- token", `${"xoxb-" + "123456789012-FAKEfakeFAKE"}`, REDACTED],
    ["xoxp- token", `${"xoxp-" + "123456789012-FAKEfakeFAKE"}`, REDACTED],
    ["Bearer (name kept)", `Authorization: Bearer ${"FAKEfake0123456789.abc"}`, `Authorization: Bearer ${REDACTED}`],
    ["JWT", `${"eyJ" + "hbGciOiJIUzI1NiJ9"}.${"eyJzdWIiOiIxMjM0In0"}.${"FAKEsig_0123456789"}`, REDACTED],
    ["PEM block", `a\n-----BEGIN RSA PRIVATE KEY-----\nMIIFAKE\nFAKE==\n-----END RSA PRIVATE KEY-----\nb`, `a\n${REDACTED}\nb`],
    ["PEM cut short", `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1FAKE`, REDACTED],
    ["NAME=value (env)", `API_KEY=fake_api_key_9876543210 next`, `API_KEY=${REDACTED} next`],
    ["NAME=value (sk inside)", `OPENAI_API_KEY=${"sk-" + "proj-FAKEfakeFAKEfake1234567890"}`, `OPENAI_API_KEY=${REDACTED}`],
    ["NAME=\"value\"", `DB_PASSWORD="hunter2hunter2"`, `DB_PASSWORD="${REDACTED}"`],
    ["flag", `--auth-token=abcdef123456 --x`, `--auth-token=${REDACTED} --x`],
    ["query string", `?client_secret=abc123def&x=1`, `?client_secret=${REDACTED}&x=1`],
    ["JSON field", `{"apiKey": "fake-value-123", "name": "n"}`, `{"apiKey": "${REDACTED}", "name": "n"}`],
    ["JSON credential", `{"credentials":"c-fake-0001","passwd": "x1y2z3"}`, `{"credentials":"${REDACTED}","passwd": "${REDACTED}"}`],
  ];
  for (const [name, input, expected] of cases)
    test(name, () => {
      assert.equal(redactPatterns(input), expected);
      // And through the redactor itself, with no known values loaded (the path a decision takes).
      assert.equal(new Redactor([], {}).refresh().redact(input), expected);
    });

  test("no false positives: paths, short hashes, `key: value` prose, numbers, author fields", () => {
    const plain = [
      "/home/user/.ssh/id_rsa and ~/work/secret-project/src/token.ts",
      "3302ca6 mesh-termux scan; d422579 mesh-lab m4",
      "The key: value pairs are documented; the token: count is 435.",
      "input_tokens=435 output_tokens=20 max_tokens=4096 cache=true",
      '{"input_tokens": "435", "author": "someone", "keywords": ["a"], "authority": "x"}',
      "sk-ant-oat01- is only a prefix; sk-learn is a library",
      "Bearer short",
      "GIT_AUTHOR_NAME=someone",
    ];
    for (const t of plain) assert.equal(redactPatterns(t), t, t);
  });

  test("redactDeep applies the patterns with no known values loaded, and keeps object keys", () => {
    const r = new Redactor([], {}).refresh();
    const state = { tool_failures: [{ input: "echo $OPENAI_API_KEY", error: `OPENAI_API_KEY=${"sk-" + "proj-FAKEfakeFAKEfake1234567890"}` }], api_key_note: "fine" };
    assert.deepEqual(r.redactDeep(state), { tool_failures: [{ input: "echo $OPENAI_API_KEY", error: `OPENAI_API_KEY=${REDACTED}` }], api_key_note: "fine" });
  });
});
