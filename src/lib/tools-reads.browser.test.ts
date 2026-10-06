// Run: pnpm test -- src/lib/tools-reads.browser.test.ts (the runner adds --conditions=browser). The setup card's
// Tools reads (§chat.transcript/setup-card-tools) on Solid's reactive build: what re-reads, which answer is
// drawn, and which rows stay open. The bugs live between re-runs of the graph, so the inert server build
// would pass every one of these.
import assert from "node:assert/strict";
import { test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { createToolsReads } = await import("./tools-reads");
const { toolsKeyOf } = await import("./session-tools");
import type { SessionTools } from "../../shared/protocol";

const settle = () => new Promise((r) => setTimeout(r, 0));
const answer = (backend: "pi" | "claude-code", names: string[]): SessionTools => ({
  state: "ok",
  backend,
  checkedAt: 0,
  tools: names.map((name) => ({ name, callName: backend === "claude-code" ? `mcp__sova__${name}` : name, description: name, source: "builtin", tokens: 1 })),
});
/** A fetch whose answers the test hands out, in any order. */
function deferred() {
  const pending: { path: string; resolve: (t: SessionTools) => void }[] = [];
  const fetch = (path: string) => new Promise<SessionTools>((resolve) => pending.push({ path, resolve }));
  return { pending, fetch };
}
const names = (v: ReturnType<ReturnType<typeof createToolsReads>["view"]>) => (v?.kind === "list" ? v.rows.map((r) => r.name) : v?.kind === "line" ? [v.text] : null);

test("an older answer never draws over a newer one", async () => {
  const d = deferred();
  const r = solid.createRoot(() => createToolsReads(d.fetch));
  void r.read("/a");
  void r.read("/a");
  d.pending[1]!.resolve(answer("pi", ["read", "vis_check"]));
  await settle();
  d.pending[0]!.resolve(answer("pi", ["read"]));
  await settle();
  assert.deepEqual(names(r.view()), ["read", "vis_check"], "the first read answered last and was dropped");
});

test("a reset (a new session, or the card leaving) drops every read in flight and closes the group and its rows", async () => {
  const d = deferred();
  const r = solid.createRoot(() => createToolsReads(d.fetch));
  void r.read("/a");
  d.pending[0]!.resolve(answer("pi", ["read"]));
  await settle();
  r.setGroupOpen(true);
  r.flip("read", true);
  void r.read("/a");
  r.reset();
  assert.equal(r.groupOpen(), false);
  assert.equal(r.isOpen("read"), false);
  d.pending[1]!.resolve(answer("pi", ["bash"]));
  await settle();
  assert.deepEqual(names(r.view()), ["read"], "the answer from before the reset is dropped");
});

test("open rows stay open across a re-read while their tool is listed, Claude Code's naming included; the group keeps its state", async () => {
  const d = deferred();
  const r = solid.createRoot(() => createToolsReads(d.fetch));
  void r.read("/a");
  d.pending[0]!.resolve(answer("pi", ["read", "vis_check", "bash"]));
  await settle();
  r.setGroupOpen(true);
  r.flip("read", true);
  r.flip("vis_check", true);
  void r.read("/a");
  d.pending[1]!.resolve(answer("claude-code", ["read", "bash"]));
  await settle();
  assert.deepEqual(names(r.view()), ["mcp__sova__read", "mcp__sova__bash"]);
  assert.equal(r.isOpen("read"), true, "read stays open under its new name");
  assert.equal(r.isOpen("vis_check"), false, "a tool no longer listed closes");
  assert.equal(r.groupOpen(), true);
  void r.read("/a");
  d.pending[2]!.resolve(answer("pi", ["read", "vis_check", "bash"]));
  await settle();
  assert.equal(r.isOpen("vis_check"), false, "and stays closed when it comes back");
});

test("a failed read is drawn as its line", async () => {
  const r = solid.createRoot(() => createToolsReads(() => Promise.reject(new Error("The Sova server isn't reachable."))));
  await r.read("/a");
  assert.deepEqual(names(r.view()), ["Couldn't read this session's tools. The Sova server isn't reachable."]);
});

test("the key gates on its value: a new mode object with the same triple re-reads nothing; a change of model, minor mode, strict or a hello does", async () => {
  const reads: string[] = [];
  const r = solid.createRoot((dispose) => {
    const [model, setModel] = solid.createSignal<string | null>("zai/glm-5.3");
    const [mode, setMode] = solid.createSignal({ mode: "normal", strict: false, minorModes: [] as string[] });
    const [hellos, setHellos] = solid.createSignal(1);
    const key = solid.createMemo(() => toolsKeyOf(model(), mode(), hellos()));
    solid.createEffect(solid.on(key, () => void reads.push(key()), { defer: true }));
    return { setModel, setMode, setHellos, dispose };
  });
  await settle();
  r.setMode({ mode: "normal", strict: false, minorModes: [] });
  r.setMode({ mode: "normal", strict: false, minorModes: [] });
  await settle();
  assert.equal(reads.length, 0, "equal values: no re-read");
  r.setMode({ mode: "normal", strict: false, minorModes: ["vis"] });
  await settle();
  r.setMode({ mode: "normal", strict: true, minorModes: ["vis"] });
  await settle();
  r.setModel("claude-code-cli/fake-opus");
  await settle();
  r.setHellos(2);
  await settle();
  assert.equal(reads.length, 4, "each change of value re-reads once");
  r.dispose();
});
