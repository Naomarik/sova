// Run: npx tsx --test server/overseer-todo-tools.test.ts (or npm test). Uses a throwaway
// PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
//
// The todos tools against a stub host: attended or not, one known session. Every call goes
// through overseerTools, so the act/read wrappers, the audit log and redaction are the real ones.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import type { SessionSummary } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-todo-tools-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { overseerTools, TurnLimits, UNATTENDED_REFUSAL } = await import("./overseer-tools");
const { DEFAULT_CAPS, overseerActionsFile } = await import("./overseer-store");
const { Redactor } = await import("./overseer-redact");
const todos = await import("./overseer-todos");
const { addIdea } = await import("./overseer-ideas");

after(() => rmSync(agentDir, { recursive: true, force: true }));

let attended = true;
const host = {
  overseerId: () => "ov-1",
  caps: () => DEFAULT_CAPS,
  attended: () => attended,
  explorer: () => ({ backend: "claude-code", model: "opus[1m]", effort: "medium" }),
  explorerCwd: () => join(agentDir, "sova", "overseer"),
  subagent: () => null,
  // A TUI-live session: a todo may still point at it (it is a note, not an act on the session).
  session: async (ref: string) =>
    ref === "s-1" ? ({ id: "s-1", path: "/p/s-1.jsonl", title: "Work", overseer: false, live: { pid: 42 } } as unknown as SessionSummary) : null,
};

const secret = "Zq8vT3mN9pL2xR7wK4sB6yH1";
let redactor = () => new Redactor([], {}).refresh();
const tools = () => overseerTools(host as never, new TurnLimits(), () => redactor());
async function call(name: string, params: Record<string, unknown>) {
  const t = tools().find((x) => x.name === name)!;
  return t.execute("tc1", params, undefined, undefined, {} as never);
}
const run = async (name: string, params: Record<string, unknown>) => ((await call(name, params)).content as { text: string }[]).map((c) => c.text).join("\n");
const refusal = (name: string, params: Record<string, unknown>) => run(name, params).then(() => "", (e: Error) => e.message);
const log = () =>
  readFileSync(overseerActionsFile(), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((l) => l.tool === "sova_todo");
const idOf = (text: string) => todos.readTodos().todos.find((t) => t.text === text)!.id;

beforeEach(() => {
  attended = true;
  redactor = () => new Redactor([], {}).refresh();
});

describe("sova_todo: the user's checklist, in a turn they started", () => {
  test("add, check, edit and remove reach the store and every call is audited", async () => {
    addIdea({ id: "sova/multi-login", title: "Multi login" });
    assert.match(await run("sova_todo", { op: "add", text: "Revoke GitLab token", idea: "sova/multi-login", session: "sova://s/s-1" }), /^Added td_[a-z0-9]{8}: Revoke GitLab token \(1 open\)\.$/);
    const id = idOf("Revoke GitLab token");
    const t = todos.readTodos().todos[0]!;
    assert.equal(t.ideaId, "§sova/multi-login");
    assert.equal(t.sessionId, "s-1", "a TUI-live session is fine to point at");
    await run("sova_todo", { op: "add", text: "Reply to Dana" });
    const out = await call("sova_todo", { op: "check", id });
    assert.match((out.content as { text: string }[])[0]!.text, /^Ticked td_\w+: Revoke GitLab token \(1 open\)\.$/);
    assert.deepEqual(out.details, { id, op: "check", done: true });
    assert.equal(todos.readTodos().todos[0]!.done, true);
    assert.match(await run("sova_todo", { op: "edit", id, text: "Revoke the GitLab token", idea: "", session: "" }), /^Edited td_\w+: Revoke the GitLab token\.$/);
    assert.equal(todos.readTodos().todos[0]!.ideaId, undefined);
    assert.match(await run("sova_todo", { op: "uncheck", id }), /^Unticked/);
    assert.match(await run("sova_todo", { op: "remove", id: idOf("Reply to Dana") }), /^Removed td_\w+: Reply to Dana \(1 open\)\.$/);
    assert.deepEqual(log().map((l) => [l.args.op, l.outcome]), [["add", "ok"], ["add", "ok"], ["check", "ok"], ["edit", "ok"], ["uncheck", "ok"], ["remove", "ok"]]);
  });

  test("check on a done todo and uncheck on an open one are no-ops that say so", async () => {
    const id = idOf("Revoke the GitLab token");
    const before = todos.readTodos().todos[0]!.updatedAt;
    assert.match(await run("sova_todo", { op: "uncheck", id }), /was already open: Revoke the GitLab token\. Nothing changed\./);
    await run("sova_todo", { op: "check", id });
    assert.match(await run("sova_todo", { op: "check", id }), /was already done/);
    assert.notEqual(todos.readTodos().todos[0]!.updatedAt, before);
  });

  test("clear_done deletes the ticked ones", async () => {
    await run("sova_todo", { op: "add", text: "Bump the pin" });
    assert.match(await run("sova_todo", { op: "clear_done" }), /^Cleared 1 done todo \(1 open\)\.$/);
    assert.deepEqual(todos.readTodos().todos.map((t) => t.text), ["Bump the pin"]);
    assert.equal(await run("sova_todo", { op: "clear_done" }), "No done todos to clear.");
  });

  test("refusals come back as the store words them, and are audited as refused", async () => {
    assert.match(await refusal("sova_todo", { op: "add", text: "x", idea: "sova/no-such" }), /No idea §sova\/no-such/);
    assert.match(await refusal("sova_todo", { op: "add", text: "x", session: "nope" }), /No session with id nope/);
    assert.match(await refusal("sova_todo", { op: "add", text: "  " }), /text is required/);
    assert.match(await refusal("sova_todo", { op: "check", id: "td_zzzzzzzz" }), /No todo td_zzzzzzzz/);
    assert.match(await refusal("sova_todo", { op: "edit", id: idOf("Bump the pin") }), /edit needs text, idea or session/);
    assert.match(await refusal("sova_todo", { op: "frobnicate" }), /op must be/);
    assert.ok(log().slice(-6).every((l) => l.outcome === "refused"));
    assert.deepEqual(todos.readTodos().todos.map((t) => t.text), ["Bump the pin"]);
  });

  test("a secret in the text is stored and answered as [redacted]", async () => {
    redactor = () => new Redactor([], { SOME_API_KEY: secret }).refresh();
    const out = await run("sova_todo", { op: "add", text: `rotate ${secret} today` });
    assert.ok(!out.includes(secret));
    assert.ok(!readFileSync(todos.todosFile(), "utf8").includes(secret));
    assert.ok(todos.readTodos().todos.some((t) => t.text === "rotate [redacted] today"));
  });
});

describe("in a turn the user did not start", () => {
  test("every sova_todo op refuses, ticking included, and nothing changes; sova_todos still reads", async () => {
    const before = readFileSync(todos.todosFile(), "utf8");
    attended = false;
    const id = idOf("Bump the pin");
    for (const params of [
      { op: "add", text: "x" },
      { op: "check", id },
      { op: "uncheck", id },
      { op: "edit", id, text: "y" },
      { op: "remove", id },
      { op: "clear_done" },
    ])
      assert.equal(await refusal("sova_todo", params), UNATTENDED_REFUSAL, String(params.op));
    assert.equal(readFileSync(todos.todosFile(), "utf8"), before);
    assert.match(await run("sova_todos", {}), /^2 open, 0 done\.\n- \[ \] td_\w+ · Bump the pin/);
  });
});

describe("sova_todos: reading the checklist", () => {
  test("open by default, done or all on request, with ids and links", async () => {
    await run("sova_todo", { op: "check", id: idOf("Bump the pin") });
    await run("sova_todo", { op: "edit", id: idOf("rotate [redacted] today"), idea: "sova/multi-login", session: "s-1" });
    const open = await call("sova_todos", {});
    assert.equal((open.content as { text: string }[])[0]!.text, `1 open, 1 done.\n- [ ] ${idOf("rotate [redacted] today")} · rotate [redacted] today · §sova/multi-login · session sova://s/s-1`);
    assert.deepEqual(open.details, { open: 1, done: 1, ids: [idOf("rotate [redacted] today")] });
    assert.match(await run("sova_todos", { status: "done" }), /- \[x\] td_\w+ · Bump the pin$/);
    assert.equal((await run("sova_todos", { status: "all" })).split("\n").length, 3);
    await run("sova_todo", { op: "clear_done" });
    assert.match(await run("sova_todos", { status: "done" }), /No done todos\./);
  });
});
