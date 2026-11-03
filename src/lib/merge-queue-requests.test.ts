// How a branch lands, as words: the settings row, the host states on rows and cards, the review before publishing and
// Local main behind (al_3).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  behindWords,
  inEffectWords,
  introWords,
  LAND_HOWS,
  HOW_LABEL,
  publishBlocked,
  publishLabel,
  requestActions,
  requestActionLabel,
  requestChecksWords,
  requestChip,
  requestReason,
  requestRef,
  showsPushToOrigin,
  signInWords,
  suggestionWords,
  type HostFacts,
  type RequestView,
} from "./merge-queue-requests";
import { controlWords, queueRow, rowsSummary, type QueueRowInput } from "./merge-queue";
import type { WorktreeQueueInfo } from "../../shared/merge-queue";

const facts = (x: Partial<HostFacts> = {}): HostFacts => ({ state: "open", checks: "pending", review: "none", mergeable: "mergeable", ...x });
const pr = (f?: Partial<HostFacts>, x: Partial<RequestView> = {}): RequestView => ({
  how: "github-pr",
  host: "github",
  branch: "feat/x",
  base: "main",
  number: 123,
  url: "https://github.com/o/r/pull/123",
  ...(f ? { facts: facts(f) } : {}),
  ...x,
});
const mr = (f?: Partial<HostFacts>): RequestView => ({
  how: "gitlab-mr",
  host: "gitlab",
  branch: "feat/y",
  base: "main",
  number: 7,
  url: "https://gitlab.com/o/r/-/merge_requests/7",
  ...(f ? { facts: facts(f) } : {}),
});

test("the four ways, in the row's order, with Merge locally first", () => {
  assert.deepEqual(
    LAND_HOWS.map((h) => HOW_LABEL[h]),
    ["Merge locally", "Pull request on GitHub", "Merge request on GitLab", "Push branch only"],
  );
});

test("Push to origin shows only under Merge locally (or when no way is set)", () => {
  assert.deepEqual(LAND_HOWS.map(showsPushToOrigin), [true, false, false, false]);
  assert.equal(showsPushToOrigin(undefined), true);
});

test("in effect: the way and where it comes from; this computer names what it overrides", () => {
  assert.equal(inEffectWords({ effective: "github-pr", from: "computer", project: "local" }), "Pull request · this computer, overrides project: Merge locally");
  assert.equal(inEffectWords({ effective: "github-pr", from: "computer" }), "Pull request · this computer, overrides project: Merge locally", "an absent project value is Merge locally");
  assert.equal(inEffectWords({ effective: "gitlab-mr", from: "project", project: "gitlab-mr" }), "Merge request · project file");
  assert.equal(inEffectWords({ effective: "local", from: "default" }), "Merge locally · Sova's default");
});

test("the suggestion from origin shows only while it differs from what's in effect", () => {
  assert.equal(suggestionWords({ effective: "local", suggested: { how: "github-pr", why: "github.com" } }), "Suggested from origin: github.com");
  assert.equal(suggestionWords({ effective: "local", suggested: { how: "github-pr", why: "Suggested from origin: github.com" } }), "Suggested from origin: github.com", "said once");
  assert.equal(suggestionWords({ effective: "github-pr", suggested: { how: "github-pr", why: "github.com" } }), null);
  assert.equal(suggestionWords({ effective: "local" }), null);
});

test("sign-in: the adapter's own words, else the a11 sentence; nothing for local or a good login", () => {
  assert.equal(signInWords({ effective: "github-pr", signIn: { ok: false } }), "Sign in to GitHub on this computer first (gh auth login).");
  assert.equal(signInWords({ effective: "gitlab-mr", signIn: { ok: false, why: "glab: token expired" } }), "glab: token expired");
  assert.equal(signInWords({ effective: "github-pr", signIn: { ok: true } }), null);
  assert.equal(signInWords({ effective: "local", signIn: { ok: false } }), null);
});

test("request refs: PR #n on GitHub, MR !n on GitLab", () => {
  assert.equal(requestRef("github", 123), "PR #123");
  assert.equal(requestRef("gitlab", 7), "MR !7");
  assert.equal(requestRef("github", undefined), "PR");
});

test("each host state reads as the brief's words, the most pressing first", () => {
  const label = (f: Partial<HostFacts>) => requestChip("requested", pr(f)).label;
  assert.equal(label({}), "PR #123 open · checks running on GitHub");
  assert.equal(label({ checks: "fail" }), "Host checks failed");
  assert.equal(label({ review: "changes-requested" }), "Changes requested");
  assert.equal(label({ review: "approved", checks: "pass" }), "Approved");
  assert.equal(label({ mergeable: "conflicts", checks: "fail" }), "Conflicts on GitHub", "conflicts before failed checks");
  assert.equal(label({ state: "merged" }), "Landed");
  assert.equal(label({ state: "closed" }), "Closed on GitHub");
  assert.equal(label({ checks: "not-reported" }), "PR #123 open · no checks reported on GitHub", "never read as passed");
  assert.equal(requestChip("requested", pr(undefined)).label, "PR #123 open · checks running on GitHub", "no facts yet: just opened");
  assert.equal(requestChip("requested", mr({ checks: "pass" })).label, "MR !7 open · checks passed on GitLab");
  assert.equal(requestChip("closed", mr()).label, "Closed on GitLab");
  assert.equal(requestChip("pushed", { how: "push-branch" }).label, "Pushed");
  assert.equal(requestChip("request-review", pr()).label, "Review the request");
  const text = { title: "Add x", body: "…", draft: false };
  const going = pr(undefined, { text, publishRequested: true });
  assert.equal(requestChip("request-review", going, "Waiting for the chat to go idle.").label, "Opening the PR", "on its way, while it waits for the chat");
  assert.equal(requestReason("request-review", going, "main", "Waiting for the chat to go idle."), "Waiting for the chat to go idle.");
  assert.equal(requestReason("request-review", going, "main", "publishing"), "Publishing to GitHub.");
  // A refused Publish: reason and text both there, no flag: the user's to fix and publish again.
  const refused = pr(undefined, { text });
  assert.equal(requestChip("request-review", refused, "Sign in to GitHub on this computer first (gh auth login).").label, "Review the request", "a refusal is never read as on its way");
  assert.deepEqual(requestActions("request-review", refused, { reason: "Sign in to GitHub on this computer first (gh auth login)." }), ["review"]);
  assert.equal(requestReason("request-review", refused, "main", "Sign in to GitHub on this computer first (gh auth login)"), "Sign in to GitHub on this computer first (gh auth login). Fix it, then publish again.");
  assert.equal(requestChip("request-review", pr(), "The request folder's drafter failed.").label, "Review the request", "no text drafted: still yours to write");
  assert.match(requestReason("request-review", pr(), "main", "The request folder's drafter failed.")!, /Write the title and description yourself/);
});

test("tones: status never by hue alone (every chip has a word), failures are errors, merged is success", () => {
  assert.equal(requestChip("requested", pr({ checks: "fail" })).tone, "error");
  assert.equal(requestChip("requested", pr({ state: "merged" })).tone, "success");
  assert.equal(requestChip("requested", pr({ review: "changes-requested" })).tone, "warn");
});

test("actions: Open on the host always once linked; Send Back to Chat on host trouble; Land Again when closed or newer", () => {
  assert.deepEqual(requestActions("requested", pr({})), ["open-host"]);
  assert.deepEqual(requestActions("requested", pr({ checks: "fail" })), ["open-host", "send-back"]);
  assert.deepEqual(requestActions("requested", pr({ review: "changes-requested" })), ["open-host", "send-back"]);
  assert.deepEqual(requestActions("requested", pr({ mergeable: "conflicts" })), ["open-host", "send-back"]);
  assert.deepEqual(requestActions("closed", pr({ state: "closed" })), ["open-host", "land-again"]);
  assert.deepEqual(requestActions("requested", pr({}), { newerCommits: 2 }), ["open-host", "land-again"]);
  assert.deepEqual(requestActions("requested", pr({ state: "merged" }), { newerCommits: 2 }), ["open-host"], "merged: nothing to update");
  assert.deepEqual(requestActions("request-review", pr()), ["review"]);
  assert.deepEqual(requestActions("request-review", pr(undefined, { text: { title: "t", body: "", draft: false }, publishRequested: true }), { reason: "Waiting for the chat to go idle." }), [], "on its way: nothing to review again");
  assert.deepEqual(requestActions("request-review", pr(), { reason: "Couldn't draft it." }), ["review"], "not drafted: Review Request to write it");
  assert.equal(requestActionLabel("open-host", pr()), "Open on GitHub");
  assert.equal(requestActionLabel("open-host", mr()), "Open on GitLab");
  assert.equal(requestActionLabel("send-back", pr()), "Send Back to Chat");
});

test("a host merge says the host's merge is final, not 'exactly the tested commit' (f9)", () => {
  const r = requestReason("requested", pr({ state: "merged" }), "main")!;
  assert.match(r, /GitHub's merge is final/);
  assert.doesNotMatch(r, /exactly the tested commit/);
  assert.match(requestReason("requested", pr({ checks: "fail" }), "main")!, /nobody is blamed/, "a16: host checks aren't blamed on the branch");
});

test("publish: names what goes out; ready by default; only an empty title holds it", () => {
  assert.equal(publishLabel("github-pr", false), "Publish Pull Request");
  assert.equal(publishLabel("gitlab-mr", true), "Publish Draft Merge Request");
  assert.equal(publishBlocked("  "), "Give it a title first.");
  assert.equal(publishBlocked("Add x"), null);
});

test("request folder checks: counted, with the folder named; Sova's plain default without one", () => {
  assert.equal(requestChecksWords(undefined, undefined), "No request folder: written in Sova's plain default.");
  assert.equal(requestChecksWords(".sova/playbooks/request", [{ name: "length", ok: true }, { name: "ticket", ok: true }]), "Written from .sova/playbooks/request · 2 checks passed");
  assert.equal(requestChecksWords(".sova/playbooks/request", [{ name: "length", ok: true }, { name: "ticket", ok: false, why: "no ticket link" }]), "Written from .sova/playbooks/request · 1 of 2 checks failed");
});

test("Local main is N commits behind, with the target's own name; nothing when current", () => {
  assert.equal(behindWords("main", 3), "Local main is 3 commits behind");
  assert.equal(behindWords("master", 1), "Local master is 1 commit behind");
  assert.equal(behindWords("main", 0), null);
  assert.equal(behindWords("main", undefined), null);
});

// ---- the worktree rows (composer control, pane) read the same words --------------------------------

const wtq = (queue: Partial<WorktreeQueueInfo>, served = true): QueueRowInput => ({
  status: "active",
  exists: true,
  branch: "feat/x",
  readiness: undefined,
  queue: { id: "me_1", state: "requested", commit: "a".repeat(40), notes: [], project: "prj_1", ...queue } as WorktreeQueueInfo,
  mergeProject: { id: "prj_1", root: "/r", target: "main", checks: "declared", review: false },
  ...(served ? { mergeServed: true as const } : {}),
});

test("rows: an open request reads its host state; a request to review needs you; closed offers Land", () => {
  const open = queueRow(wtq({ state: "requested", request: pr({ checks: "fail" }) }));
  assert.equal(open.label, "Host checks failed");
  assert.equal(open.key, "requested");
  assert.equal(open.action, "none");
  const merged = queueRow(wtq({ state: "requested", request: pr({ state: "merged" }) }));
  assert.equal(merged.key, "landed", "the host merged it: Landed, before the queue moves the entry");
  const closed = queueRow(wtq({ state: "closed", request: pr({ state: "closed" }) }));
  assert.equal(closed.label, "Closed on GitHub");
  assert.equal(closed.action, "land", "Land Again");
  assert.equal(queueRow(wtq({ state: "closed", request: pr({ state: "closed" }) }, false)).action, "none", "an unserved repo offers no Land, even on an old closed request");
  const review = queueRow(wtq({ state: "request-review", request: pr() }));
  assert.equal(review.label, "Review the request");
  assert.deepEqual(controlWords([review]), { text: "1 needs you", n: 1, dot: "warn" });
  assert.equal(rowsSummary([open, closed]), "1 waiting on the host · 1 closed on the host");
  assert.equal(queueRow(wtq({ state: "pushed", request: { how: "push-branch", branch: "feat/x", base: "main" } })).label, "Pushed");
});

test("q4: the Land menu offers no per-landing way of landing; the project's setting decides every time", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../components/WorktreesModal.tsx", import.meta.url), "utf8");
  const start = src.indexOf("export function LandSplit(");
  assert.ok(start >= 0, "LandSplit is where the Land menu is built");
  const body = src.slice(start, src.indexOf("\nexport function", start + 1));
  const items = [...body.matchAll(/<menu\.Item\s+label="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(items, ["Land Without Review", "Land Without Its Specs…"], "exactly today's two items");
  assert.doesNotMatch(body, /pull request|merge request|locally|\bPR\b|\bMR\b|github|gitlab|push branch/i, "no strategy choice anywhere in the menu");
});

test("the tab's intro says what happens after the checks, by the way in effect", () => {
  assert.match(introWords("master", undefined), /master then moves to exactly that commit\.$/);
  assert.match(introWords("main", "github-pr"), /pull request opens on GitHub\. You merge it there\.$/);
  assert.doesNotMatch(introWords("main", "gitlab-mr"), /exactly that commit/);
  assert.match(introWords("main", "push-branch"), /pushed to origin/);
});
