import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { openingTab, TABS } from "./pane-tabs";

describe("the session pane's tabs", () => {
  test("the strip, in order, has no Skills", () => {
    assert.deepEqual(TABS.map((t) => t.label), ["Session", "Timeline", "Agents", "Usage", "Time Spent", "Context", "Sharing", "Gallery"]);
  });

  test("a kept tab the strip has opens; a kept Skills falls back to the pane's opening tab, whichever that is", () => {
    assert.equal(openingTab("context", "session"), "context");
    assert.equal(openingTab(null, "agents"), "agents");
    assert.equal(openingTab("skills", "session"), "session");
    assert.equal(openingTab("skills", "agents"), "agents");
  });

  test("a pane kept on the tab's old name, Explain, opens on Gallery", () => {
    assert.equal(openingTab("explain", "session"), "gallery");
    assert.equal(openingTab("gallery", "session"), "gallery");
  });
});
