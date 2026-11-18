// A playbook that requires an alignment first: /name asks the chat to open it (align turned on if off) and draws
// no card; the person's decisions fill the choices their questions name and the card appears where the chat is;
// a dropped alignment draws the card with those choices empty; a playbook without the key opens its card at once.
// The chat is a stand-in; the alignments are the align extension's own results (applyAlignCall), read as Sova does.
import { scratchAgentDir, dropScratchAgentDir } from "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import type { HEntry } from "../../shared/harness";
import type { ChatModePatch } from "../../shared/chat-runtime";
import type { PlaybookRunView } from "../../shared/playbook-run";
import type { AlignDocument } from "../../pi-config/extensions/mode/align.ts";
import type { AlignFirstHost } from "./align-first";

const { applyAlignCall } = await import("../../pi-config/extensions/mode/align.ts");
const { mountPlaybookRunRoutes } = await import("./routes");
const { settleChat } = await import("./align-first");
const { playbookCardNote } = await import("./note");
const { AUTH_COOKIE, CALLER_HEADER, sovaToken } = await import("../auth");

after(() => dropScratchAgentDir());

function playbook(id: string, align: boolean): void {
  const dir = join(scratchAgentDir, "sova", "playbooks", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "PLAYBOOK.md"), `---\ntitle: ${id}\ndescription: d\n---\nConduct it.\n`);
  writeFileSync(
    join(dir, "playbook.json"),
    JSON.stringify({
      version: 1,
      inputs: [
        { id: "failure", label: "The failure", type: "text", ask: "chat", required: true },
        { id: "measures", label: "What is measured", type: "list", ask: "chat", required: true },
        { id: "level", label: "Level", type: "choice", ask: "always", required: true, options: [{ id: "lo", label: "Low" }, { id: "hi", label: "High" }], default: "lo" },
      ],
      ...(align ? { align: { questions: [{ id: "fails", ask: "What fails today?", fills: "failure" }, { id: "fixed", ask: "What counts as fixed?" }, { id: "measure", ask: "What is measured, and how?", fills: "measures" }] } } : {}),
      steps: [{ id: "go", label: "Go" }],
    }),
  );
}
playbook("aligned", true);
playbook("plain", false);

/** A stand-in chat: its mode, what it was sent, and its branch of align results. */
class Chat {
  minors: string[] = [];
  sent: string[] = [];
  switched: ChatModePatch[] = [];
  branch: HEntry[] = [];
  refused: string | null = null;
  private docs: AlignDocument[] = [];
  align(call: unknown, now: string): void {
    const { details } = applyAlignCall(this.docs, call, { now, readFile: () => "" });
    if (details.doc) this.docs = [...this.docs.filter((d) => d.id !== details.doc!.id), details.doc];
    this.branch.push({ kind: "tool-result", id: `t${this.branch.length}`, parentId: null, tool: "align", isError: false, details } as unknown as HEntry);
  }
  host(): AlignFirstHost {
    const self = this;
    return {
      chat: async () => ({
        mirror: { mode: { mode: "normal", minorModes: self.minors } },
        switchMode: async (p: ChatModePatch) => {
          self.switched.push(p);
          self.minors = [...(p.minorModes ?? self.minors)];
        },
        branch: async () => self.branch,
      }),
      prompt: async (_path, text) => (self.refused ? { ok: false, error: self.refused } : (self.sent.push(text), { ok: true })),
      preflight: async () => null,
    };
  }
}

let n = 0;
function setUp() {
  const chat = new Chat();
  const app = new Hono();
  mountPlaybookRunRoutes(app, { contents: () => [], alignHost: chat.host() });
  const id = `chat-al-${++n}`;
  const path = join(scratchAgentDir, "sessions", "--proj--", `2026-11-18T00-00-0${n}-000Z_${id}.jsonl`);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-18T00:00:00.000Z", cwd: scratchAgentDir })}\n`);
  const page = { cookie: `${AUTH_COOKIE}=${sovaToken()}`, "content-type": "application/json" };
  const open = async (pb: string, headers: Record<string, string> = page) =>
    (await (await app.request("/api/playbook-runs", { method: "POST", headers, body: JSON.stringify({ playbook: { source: "user", id: pb }, cwd: scratchAgentDir, path, text: "the read tool" }) }, { incoming: {} })).json()) as PlaybookRunView;
  const asChat = { [CALLER_HEADER]: "a-chat", "x-sova-token": sovaToken(), "content-type": "application/json" };
  return { chat, id, open, asChat, view: async (run: string) => (await (await app.request(`/api/playbook-runs/${run}`)).json()) as PlaybookRunView };
}

const create = { ops: [{ op: "create", title: "Before the A/B run", summary: "What we test", questions: ["fails", "fixed", "measure"].map((topic) => ({ topic, ask: `${topic}?`, recommendation: { choice: "r", why: "w" } })) }] };

describe("a playbook that requires an alignment first", () => {
  test("/name asks the chat to open it, turning align on, and draws no card; deciding every question fills the choices and draws it where the chat is", async () => {
    const s = setUp();
    const v = await s.open("aligned");
    assert.equal(v.aligning, true);
    assert.equal(v.startBlocked, "Waiting for the alignment to be decided in the chat.");
    assert.deepEqual(s.chat.switched, [{ minorModes: ["align"] }]);
    assert.equal(s.chat.sent.length, 1);
    assert.ok(s.chat.sent[0]!.startsWith(`Before the card of the playbook "aligned" (run ${v.id}): this playbook starts with an alignment.`), s.chat.sent[0]);
    assert.ok(s.chat.sent[0]!.includes("- fails: What fails today?\n- fixed: What counts as fixed?\n- measure: What is measured, and how?\nThe person's words with the playbook: the read tool"));
    assert.equal(await playbookCardNote(s.id), s.chat.sent[0], "a compacted chat is still told");

    const later = new Date(Date.now() + 1000).toISOString();
    s.chat.align(create, later);
    s.chat.align({ doc: "al_1", ops: [{ op: "decide", q: "q1", decision: "It drops the last line." }, { op: "decide", q: "q2", decision: "Every line read." }] }, later);
    await settleChat(s.id, s.chat.host());
    assert.equal((await s.view(v.id)).aligning, true, "not every question decided yet");
    s.chat.align({ doc: "al_1", ops: [{ op: "decide", q: "q3", decision: "lines read; tokens used" }] }, later);
    await settleChat(s.id, s.chat.host());
    const drawn = await s.view(v.id);
    assert.equal(drawn.aligning, undefined);
    assert.deepEqual(drawn.choices.map((c) => [c.id, c.value, c.origin]), [["failure", "It drops the last line.", "alignment"], ["measures", ["lines read", "tokens used"], "alignment"], ["level", "lo", "default"]]);
    assert.equal(drawn.startBlocked, null);
    assert.ok(drawn.anchor!.at > v.anchor!.at && drawn.anchor!.after === undefined, "drawn where the chat is now, not where /name was typed");
    assert.equal(await playbookCardNote(s.id), null);
  });

  test("a dropped alignment draws the card with those choices empty, for the chat to work out", async () => {
    const s = setUp();
    s.chat.minors = ["align"];
    const v = await s.open("aligned");
    assert.deepEqual(s.chat.switched, [], "align already on: left as it is");
    assert.equal(v.aligning, true, "the card waits on the alignment");
    const later = new Date(Date.now() + 1000).toISOString();
    s.chat.align(create, later);
    s.chat.align({ doc: "al_1", ops: [{ op: "drop_alignment", reason: "not needed" }] }, later);
    await settleChat(s.id, s.chat.host());
    const drawn = await s.view(v.id);
    assert.equal(drawn.aligning, undefined);
    assert.equal(drawn.startBlocked, "Work out The failure with the chat first.");
    assert.ok((await playbookCardNote(s.id))!.includes("[failure]"));
  });

  test("a chat that can't be asked gets the card at once; a chat's own open asks nothing and is told by its note", async () => {
    const s = setUp();
    s.chat.refused = "the chat is open in a terminal";
    assert.equal((await s.open("aligned")).aligning, undefined);
    const t = setUp();
    const v = await t.open("aligned", t.asChat);
    assert.equal(v.aligning, true);
    assert.deepEqual([t.chat.sent, t.chat.switched], [[], []]);
    assert.ok((await playbookCardNote(t.id))!.startsWith("Before the card of the playbook"));
  });

  test("a playbook without it opens its card at once, asking the chat nothing", async () => {
    const s = setUp();
    const v = await s.open("plain");
    assert.equal(v.aligning, undefined);
    assert.deepEqual([s.chat.sent, s.chat.switched], [[], []]);
    assert.equal(v.startBlocked, "Work out The failure with the chat first.");
  });
});
