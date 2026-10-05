// Run: pnpm test -- server/harness/pi/ui-bridge.test.ts. pi's extension UI on Sova's dialog bridge
// (§app.harness/session-open): each pi UI call becomes the bridge request the chat has always broadcast (the
// same fields, the same fallback and parse), the extension's own options object is handed on as is (its
// signal and timeout), fire-and-forget calls stay fire-and-forget, and TUI-only calls are inert.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DialogBridge } from "../../../shared/harness";
import { createPiUiContext, currentTheme } from "./ui-bridge";

type Opened = { request: Record<string, unknown>; fallback: unknown; parse: (v: unknown) => unknown; o: unknown };

function recorder(answer: (call: Opened) => unknown = (c) => c.fallback) {
  const opened: Opened[] = [];
  const fired: Record<string, unknown>[] = [];
  const bridge: DialogBridge = {
    open: <T>(request: Record<string, unknown>, fallback: T, parse: (v: unknown) => T, o?: { signal?: AbortSignal; timeout?: number }) => {
      const call = { request, fallback, parse, o };
      opened.push(call);
      return Promise.resolve(answer(call) as T);
    },
    fireAndForget: (request) => void fired.push(request),
  };
  return { ui: createPiUiContext(bridge), opened, fired };
}

describe("createPiUiContext", () => {
  test("select, confirm, input and editor open bridge dialogs with the chat's request fields and fallbacks", async () => {
    const { ui, opened } = recorder();
    const opts = { timeout: 60000, signal: new AbortController().signal };
    assert.equal(await ui.select("Pick", ["a", "b"], opts), undefined);
    assert.equal(await ui.confirm("Sure?", "It writes.", opts), false);
    assert.equal(await ui.input("Name", "Session name", opts), undefined);
    assert.equal(await ui.editor("Edit", "prefill"), undefined);
    assert.deepEqual(
      opened.map((c) => [c.request, c.fallback]),
      [
        [{ method: "select", title: "Pick", options: ["a", "b"] }, undefined],
        [{ method: "confirm", title: "Sure?", message: "It writes." }, false],
        [{ method: "input", title: "Name", placeholder: "Session name" }, undefined],
        [{ method: "editor", title: "Edit", prefill: "prefill" }, undefined],
      ],
    );
    // The extension's own options object, untouched: the chat reads its signal and timeout.
    assert.equal(opened[0]!.o, opts);
    assert.equal(opened[1]!.o, opts);
    assert.equal(opened[2]!.o, opts);
    assert.equal(opened[3]!.o, undefined, "the editor takes no options");
  });

  test("each dialog parses an answer as before: strings for select, input and editor; confirm only on true", () => {
    const { ui, opened } = recorder();
    void ui.select("Pick", ["a"]);
    void ui.confirm("Sure?", "m");
    void ui.input("Name");
    void ui.editor("Edit");
    const [select, confirm, input, editor] = opened;
    assert.equal(select!.parse("a"), "a");
    assert.equal(select!.parse(3), undefined);
    assert.equal(confirm!.parse(true), true);
    assert.equal(confirm!.parse("true"), false);
    assert.equal(input!.parse("x"), "x");
    assert.equal(editor!.parse({ text: "x" }), undefined);
  });

  test("the bridge's answer is what the extension gets", async () => {
    const { ui } = recorder((c) => (c.request.method === "confirm" ? true : "picked"));
    assert.equal(await ui.confirm("Sure?", "m"), true);
    assert.equal(await ui.select("Pick", ["picked"]), "picked");
  });

  test("notify and setStatus are fire-and-forget requests; TUI-only calls do nothing", () => {
    const { ui, opened, fired } = recorder();
    ui.notify("Saved", "info");
    ui.setStatus("k", "busy");
    ui.setStatus("k", undefined);
    ui.setWidget("w", ["x"]);
    ui.setTitle("t");
    ui.setEditorText("draft");
    assert.equal(ui.getEditorText(), "");
    assert.equal(ui.getToolsExpanded(), false);
    assert.deepEqual(ui.setTheme("dark"), { success: false, error: "Theme switching not supported in Sova" });
    assert.deepEqual(fired, [
      { method: "notify", message: "Saved", notifyType: "info" },
      { method: "setStatus", statusKey: "k", statusText: "busy" },
      { method: "setStatus", statusKey: "k", statusText: undefined },
    ]);
    assert.equal(opened.length, 0);
  });

  test("the theme is pi's registered instance (P17)", () => {
    const { ui } = recorder();
    assert.equal(typeof ui.theme, "object");
    assert.equal(ui.theme, currentTheme());
  });
});
