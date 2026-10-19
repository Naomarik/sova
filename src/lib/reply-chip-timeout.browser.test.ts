// Run: pnpm test -- src/lib/reply-chip-timeout.browser.test.ts (Solid's reactive build).
// A reply chip's action is bounded (§app.extensions/reply-slot): a backend that takes the POST and
// never answers gives "… isn't answering." within the time limit, so the reply's other chips (other
// extensions' too) don't stay disabled behind it.
import assert from "node:assert/strict";
import { test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { createReplyAdditions } = await import("./reply-place");
const { createSlotPolicy } = await import("./reply-slot");
type ExtensionInfo = import("../../shared/protocol").ExtensionInfo;

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const tickets: ExtensionInfo = { id: "tickets", title: "Tickets", status: "ok", offers: { screens: ["reply"] } };

test("a chip's action whose backend never answers: \"isn't answering\" within the limit", async () => {
  let api!: ReturnType<typeof createReplyAdditions>;
  const dispose = solid.createRoot((d) => {
    api = createReplyAdditions({
      session: () => "s1",
      local: () => true,
      running: () => false,
      extensions: () => [tickets],
      policy: createSlotPolicy(memory()),
      runTimeoutMs: 50,
      // The reply lane's asks answer; the action's POST hangs until its signal gives up.
      fetch: (url, init) =>
        init.method === "POST"
          ? new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)))
          : Promise.resolve(new Response(JSON.stringify({ entries: {} }))),
    });
    return d;
  });
  const at = Date.now();
  const why = await Promise.race([
    api.runChip({ extension: "tickets", extensionTitle: "Tickets", label: "Create Issue", tone: "info", action: "create" }, "e1"),
    new Promise((r) => setTimeout(() => r("still running after 2 s"), 2000)),
  ]);
  assert.equal(why, "Tickets isn't answering.");
  assert.ok(Date.now() - at < 1000);
  dispose();
});
