import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionSummary } from "../../shared/protocol";
import { summaryLineOf, summaryTitleOf } from "./summary-row";

const row = (over: Partial<SessionSummary>): SessionSummary =>
  ({ id: "s", path: "/p", cwd: "/c", title: "t", createdAt: "", lastActiveAt: "", model: null, live: null, origin: "external", archived: false, busy: false, ...over }) as SessionSummary;

test("the summary line is the gist, not the latest process update", () => {
  const s = row({ outlineGist: "pi-web theming: palette, fonts, Themes tab", outlineNow: "The round is committed as dc63576 with all checks green." });
  assert.equal(summaryLineOf(s), "pi-web theming: palette, fonts, Themes tab");
  // The activity is still one hover away.
  assert.equal(summaryTitleOf(s), "pi-web theming: palette, fonts, Themes tab\nNow: The round is committed as dc63576 with all checks green.");
});

test("snapshots written before the gist existed keep showing their now line", () => {
  const s = row({ outlineNow: "Subagent (ag_01) starting implementation" });
  assert.equal(summaryLineOf(s), "Subagent (ag_01) starting implementation");
  // No second line to add: the tooltip is just the line itself.
  assert.equal(summaryTitleOf(s), "Subagent (ag_01) starting implementation");
});

test("a blank gist falls back, and a session with no outline has no summary row", () => {
  assert.equal(summaryLineOf(row({ outlineGist: "   ", outlineNow: "Editing auth.ts" })), "Editing auth.ts");
  assert.equal(summaryLineOf(row({})), "");
  assert.equal(summaryTitleOf(row({})), "");
});
