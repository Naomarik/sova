import assert from "node:assert/strict";
import test from "node:test";
import { completeSuffix, deferredIds, landingGate, lastLine, parseAlsoChanges, parseAlsoChangesLine, plumbingPaths, stripAlsoChanges } from "./also-changes.ts";

test("M3-B-s2-3's line verbatim: a § inside a description is not named", () => {
	const line =
		'Also changes: §app.insights/sidebar-foot — the sidebar glance bolds an item from the 90% it shows (89.6 bold, 89.4 not) instead of 80%; §app.insights/usage-cards — the "Near limit" chip and amber meter fill start at 90% instead of 80%; §app/insights — gains a new child claim, §app.insights/usage-summary (the summary line calls out a window from 90%); §design/deviations — the `.meter-fill` row now says the fill turns amber at ≥90% instead of ≥80%';
	assert.deepEqual(parseAlsoChanges(line), ["§app.insights/sidebar-foot", "§app.insights/usage-cards", "§app/insights", "§design/deviations"]);
});

test("suffix ids resolve against the preceding full id (dce95e00's real line)", () => {
	const p = parseAlsoChangesLine("Also changes: §app.session-list/search, /anatomy, /selecting-several-sessions — the list filters as you type; §design/tokens — one more");
	assert.ok(p?.ok);
	assert.deepEqual(p.ids, ["§app.session-list/search", "§app.session-list/anatomy", "§app.session-list/selecting-several-sessions", "§design/tokens"]);
	assert.deepEqual(p.items[0].ids.length, 3);
	assert.equal(completeSuffix("§a.b/c", "/d"), "§a.b/d");
	assert.equal(completeSuffix("§app", "/x"), "§app/x");
	assert.deepEqual(parseAlsoChanges("Also changes: §a/x, §b.c/y, /z — both"), ["§a/x", "§b.c/y", "§b.c/z"]);
});

test("format errors are their own result, never a list", () => {
	// e2b70a24's real shape: colon items run together as sentences.
	const colon = parseAlsoChangesLine("Also changes: §app/shell: the header moved. §app/nav: the tabs wrap");
	assert.equal(colon?.ok, false);
	assert.match(!colon?.ok ? colon!.error : "", /separate items with ";" \(§app\/nav reads as a new item/);
	assert.equal(parseAlsoChangesLine("Also changes: the footer wording (§a/b)")?.ok, false, "an item must lead with its §");
	assert.equal(parseAlsoChangesLine("Also changes: none, but §a/b moved")?.ok, false);
	assert.equal(parseAlsoChangesLine("Also changes:")?.ok, false);
	assert.equal(parseAlsoChangesLine("Also Changes — none")?.ok, false);
	assert.equal(parseAlsoChanges("Also changes: the card"), undefined);
	assert.equal(parseAlsoChangesLine("Also changed: none"), undefined, "not the line at all");
	assert.equal(parseAlsoChangesLine("Done."), undefined);
});

test("none, emphasis, backticks, a final period, ids with no description", () => {
	assert.deepEqual(parseAlsoChanges("Also changes: none"), []);
	assert.deepEqual(parseAlsoChanges("**Also changes: none.**"), []);
	assert.deepEqual(parseAlsoChanges("Also changes: none (tooling only)"), []);
	assert.deepEqual(parseAlsoChanges("Also changes: `§a/b` — x; `§c/d`."), ["§a/b", "§c/d"]);
	assert.deepEqual(parseAlsoChanges("Also changes: §a/b; §c/d"), ["§a/b", "§c/d"]);
	assert.deepEqual(parseAlsoChanges("Also changes: §a/b: see §z/z for why; §c/d — x"), ["§a/b", "§c/d"], "a mid-sentence § is description");
	assert.equal(lastLine("a\nAlso changes: none\n\n  "), "Also changes: none");
});

test("stripAlsoChanges drops a closing line, a malformed one too, and the override above it", () => {
	assert.equal(stripAlsoChanges("Done.\n\nAlso changes: none\n"), "Done.");
	assert.equal(stripAlsoChanges("Done.\nSpec check override: created here\nAlso changes: §a/b — x"), "Done.");
	assert.equal(stripAlsoChanges("Done.\nAlso changes: the card"), "Done.");
	assert.equal(stripAlsoChanges("Also changes: none, it said\nDone."), "Also changes: none, it said\nDone.");
});

test("Plumbing and Deferred lines: a reason is required; Deferred takes the § grammar", () => {
	const reply = [
		"Merged.",
		"Plumbing: pi-config/extensions/usage-status/severity.ts, ./scripts/x.sh — a helper split, no output change",
		"Plumbing: src/nothing.ts",
		"Deferred: §app.links/public, /expiry — the draft waits for the copy review",
		"Deferred: §app/other",
		"Also changes: none",
	].join("\n");
	assert.deepEqual(plumbingPaths(reply), ["pi-config/extensions/usage-status/severity.ts", "scripts/x.sh"]);
	assert.deepEqual(deferredIds(reply), ["§app.links/public", "§app.links/expiry"]);
});

test("landingGate: core's --landing shapes; Plumbing and Deferred lines clear them", () => {
	const lists = { unmappedChanged: [{ path: "pi-config/x/index.ts", status: "M" }, { path: "src/gone.ts", status: "D" }], unpromotedDrafts: [{ draft: "links", worktree: "/w", ids: ["§app.links/public"] }] };
	assert.deepEqual(landingGate("Merged.\nAlso changes: none", lists), { ok: false, missingPlumbing: ["pi-config/x/index.ts", "src/gone.ts"], missingDeferral: ["§app.links/public"] });
	const reply = "Merged.\nPlumbing: pi-config/x/index.ts, src/gone.ts — dead helper removed\nDeferred: §app.links/public — copy review pending\nAlso changes: none";
	assert.deepEqual(landingGate(reply, lists), { ok: true, missingPlumbing: [], missingDeferral: [] });
	assert.ok(landingGate("x", {}).ok);
	// q14: on the default branch a Deferred line clears nothing; only the override line passes.
	assert.deepEqual(landingGate(reply, lists, { onDefault: true }).missingDeferral, ["§app.links/public"]);
	assert.ok(landingGate(reply.replace("\nAlso changes", "\nSpec check override: the user ruled it stays stale\nAlso changes"), lists, { onDefault: true }).ok);
});
