// Run: pnpm test -- src/lib/reply-place.browser.test.ts (Solid's reactive build).
// The reply place (§app.commands/reply-place): Sova's built-ins first, extensions after, under replies
// only; and the extension lane's requests: none at all without an extension that adds to replies,
// one per such extension when the view opens and when a run ends, never one per reply, never about
// a session on another host.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { addedFor, builtInItems, createReplyAdditions, replyExtensions, sameExtensions } = await import("./reply-place");
const { createSlotPolicy } = await import("./reply-slot");
type ExtensionInfo = import("../../shared/protocol").ExtensionInfo;
type MessageStrip = import("./message-actions").MessageStrip;
type MessageActionItem = import("../components/MessageActions").MessageActionItem;

const reply: MessageStrip = { index: 3, entryId: "e1", role: "assistant", text: "hi" };
const mine: MessageStrip = { index: 1, entryId: "u1", role: "user", text: "q" };
const item = (kind: MessageActionItem["kind"]): MessageActionItem => ({ kind, reason: null, run() {} });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

const plain: ExtensionInfo = { id: "notes", title: "Notes", status: "ok" };
const tickets: ExtensionInfo = { id: "tickets", title: "Tickets", status: "ok", offers: { commands: [{ name: "create", label: "Create Issue" }], screens: ["reply"] } };
const commandsOnly: ExtensionInfo = { id: "cli", title: "CLI", status: "ok", offers: { commands: [{ name: "x", label: "X" }] } };

describe("the place", () => {
  test("built-ins stand in order; one built-in's items are its own array, untouched", () => {
    const one = [item("copy"), item("share")];
    assert.equal(builtInItems({ builtIns: [{ id: "sova", items: () => one }] }, reply), one);
    const two = builtInItems({ builtIns: [{ id: "a", items: () => [item("copy")] }, { id: "b", items: () => [item("fork")] }] }, reply);
    assert.deepEqual(two.map((i) => i.kind), ["copy", "fork"]);
  });

  test("extensions add under replies only, and only where the view has an extension lane", () => {
    const state = { chips: [], contents: [] };
    const place = { builtIns: [], added: () => state };
    assert.equal(addedFor(place, reply), state);
    assert.equal(addedFor(place, mine), undefined, "never under your own message");
    assert.equal(addedFor({ builtIns: [] }, reply), undefined);
  });

  test("only running extensions whose offers name the reply place are asked", () => {
    assert.deepEqual(replyExtensions([plain, commandsOnly, { ...tickets, status: "down" }]), []);
    assert.deepEqual(replyExtensions([plain, tickets]), [{ id: "tickets", title: "Tickets", actions: ["create"] }]);
    assert.equal(sameExtensions(replyExtensions([tickets]), replyExtensions([{ ...tickets }])), true, "a poll that changes nothing");
    assert.equal(sameExtensions(replyExtensions([tickets]), replyExtensions([{ ...tickets, title: "T2" }])), false);
  });
});

/** A view's lane over a stand-in fetch that records every request. */
function lane(opts: { extensions: ExtensionInfo[]; local?: boolean; answer?: unknown }) {
  const calls: string[] = [];
  const [session, setSession] = solid.createSignal<string | undefined>(undefined);
  const [running, setRunning] = solid.createSignal(false);
  const [extensions, setExtensions] = solid.createSignal<ExtensionInfo[] | undefined>(opts.extensions);
  let api!: ReturnType<typeof createReplyAdditions>;
  const dispose = solid.createRoot((d) => {
    api = createReplyAdditions({
      session,
      local: () => opts.local ?? true,
      running,
      extensions,
      policy: createSlotPolicy(memory()),
      fetch: async (url, init) => {
        calls.push(`${init.method ?? "GET"} ${url}`);
        return new Response(JSON.stringify(opts.answer ?? { entries: { e1: { chips: [{ label: "Checks ok", tone: "ok", href: "https://example.test/c" }] } } }));
      },
    });
    return d;
  });
  return { calls, api, setSession, setRunning, setExtensions, dispose };
}

describe("the extension lane's requests", () => {
  test("no extension adds to replies: no request at all, ever, and nothing added", async () => {
    const l = lane({ extensions: [plain, commandsOnly] });
    l.setSession("s1");
    await tick();
    l.setRunning(true);
    l.setRunning(false);
    l.setExtensions([{ ...plain }, { ...commandsOnly }]);
    await tick();
    assert.deepEqual(l.calls, []);
    assert.equal(l.api.added("e1"), undefined);
    l.dispose();
  });

  test("one request per such extension when the view opens, one more when a run ends; none per reply", async () => {
    const l = lane({ extensions: [plain, tickets] });
    await tick();
    assert.deepEqual(l.calls, [], "no session yet: nothing to ask about");
    l.setSession("s1");
    await tick();
    assert.deepEqual(l.calls, ["GET /ext/tickets/api/screens/reply?session=s1"]);
    // Every reply reads its additions: still no request.
    for (let i = 0; i < 300; i++) l.api.added(`e${i}`);
    assert.equal(l.api.added("e1")!.chips[0]!.label, "Checks ok");
    l.setRunning(true);
    await tick();
    assert.equal(l.calls.length, 1, "a run starting asks nothing");
    l.setRunning(false);
    await tick();
    assert.equal(l.calls.length, 2, "a run ending asks once");
    l.setExtensions([{ ...plain }, { ...tickets }]);
    await tick();
    assert.equal(l.calls.length, 2, "a poll that changes nothing asks nothing");
    l.dispose();
  });

  test("a session on another host is never asked about", async () => {
    const l = lane({ extensions: [tickets], local: false });
    l.setSession("s1");
    await tick();
    assert.deepEqual(l.calls, []);
    l.dispose();
  });

  test("a chip's action posts {session, entry} to the extension's own command, then asks again", async () => {
    const l = lane({ extensions: [tickets] });
    l.setSession("s1");
    await tick();
    const why = await l.api.runChip({ extension: "tickets", extensionTitle: "Tickets", label: "Create Issue", tone: "info", action: "create" }, "e1");
    assert.equal(why, null);
    assert.deepEqual(l.calls.slice(1), ["POST /ext/tickets/api/commands/create", "GET /ext/tickets/api/screens/reply?session=s1"]);
    l.dispose();
  });

  test("another session drops the last one's additions", async () => {
    const l = lane({ extensions: [tickets] });
    l.setSession("s1");
    await tick();
    assert.ok(l.api.added("e1"));
    l.setSession(undefined);
    await tick();
    assert.equal(l.api.added("e1"), undefined);
    l.dispose();
  });
});
