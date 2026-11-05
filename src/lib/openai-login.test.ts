import assert from "node:assert/strict";
import { test } from "node:test";
import type { OpenAiAccountInfo, UsageProvider } from "../../shared/protocol";
import { stampTime } from "./format";
import { failedText, flowOpen, sectionNote, signedInFacts, signOutText, standingOf } from "./openai-login";

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const H = 3_600_000;
const info = (over: Partial<OpenAiAccountInfo> = {}): OpenAiAccountInfo => ({
  signedIn: true,
  email: "me@example.com",
  expiresAt: NOW + 5 * H,
  codexAppSignedIn: false,
  meshSharesLogins: false,
  apiKeysOnly: false,
  flow: null,
  ...over,
});
const usage = (over: Partial<UsageProvider> = {}): UsageProvider =>
  ({ id: "openai", state: "ok", windows: [], plan: "plus", auth: { kind: "oauth", source: "pi", expiresAt: NOW + 5 * H }, ...over }) as UsageProvider;

test("standing: signed out, signed in, and Sign in again only when the reading says pi's sign-in stopped", () => {
  assert.equal(standingOf(info({ signedIn: false }), usage({ state: "expired" }), NOW), "signed-out");
  assert.equal(standingOf(info(), usage(), NOW), "signed-in");
  assert.equal(standingOf(info(), undefined, NOW), "signed-in", "no reading yet");
  assert.equal(standingOf(info(), usage({ state: "expired" }), NOW), "sign-in-again", "refused before its expiry");
  assert.equal(standingOf(info(), usage({ auth: { kind: "oauth", source: "pi", expiresAt: NOW + H, refreshExpired: true } }), NOW), "sign-in-again", "renewal expired");
  assert.equal(
    standingOf(info(), usage({ state: "expired", auth: { kind: "oauth", source: "pi", expiresAt: NOW - H } }), NOW),
    "signed-in",
    "a token that only timed out renews the next time pi uses OpenAI",
  );
  assert.equal(standingOf(info(), usage({ state: "expired", auth: { kind: "oauth", source: "codex-cli" } }), NOW), "signed-in", "the Codex app's reading says nothing about pi's");
});

test("signed-in facts: the plan once a reading names it, then the Usage page's renew line", () => {
  assert.deepEqual(signedInFacts(info(), usage(), NOW), ["Plus plan", `Sign-in renews by ${stampTime(NOW + 5 * H, NOW)}`]);
  assert.deepEqual(signedInFacts(info(), undefined, NOW), [`Sign-in renews by ${stampTime(NOW + 5 * H, NOW)}`], "no plan until a reading");
  assert.deepEqual(signedInFacts(info({ expiresAt: undefined }), usage({ plan: undefined }), NOW), []);
  assert.deepEqual(signedInFacts(info(), usage({ auth: { kind: "oauth", source: "codex-cli" } }), NOW), [`Sign-in renews by ${stampTime(NOW + 5 * H, NOW)}`], "not the Codex app's plan");
});

test("the section's note: API keys only first, else the Codex app hint while signed out", () => {
  assert.equal(sectionNote(info()), null);
  assert.equal(sectionNote(info({ codexAppSignedIn: true })), null, "signed in: no hint");
  assert.equal(sectionNote(info({ signedIn: false, codexAppSignedIn: true })), "The Codex app is signed in here, but Sova's chats need their own sign-in.");
  assert.match(sectionNote(info({ apiKeysOnly: true, signedIn: false, codexAppSignedIn: true }))!, /stays on this device/);
});

test("Sign Out's question names the other devices only while the mesh shares sign-ins", () => {
  const local = signOutText(info());
  const mesh = signOutText(info({ meshSharesLogins: true }));
  assert.doesNotMatch(local, /other devices/);
  assert.match(mesh, /me@example\.com out here and on the other devices that share sign-ins/);
  for (const t of [local, mesh]) assert.match(t, /The Codex app's sign-in and other providers' stay\.$/);
});

test("flowOpen and the failed sentence", () => {
  assert.deepEqual(
    (["starting", "code", "browser", "finishing", "done", "expired", "failed"] as const).map((state) => flowOpen({ state } as never)),
    [true, true, true, true, false, false, false],
  );
  assert.equal(flowOpen(null), false);
  assert.equal(failedText("OpenAI refused the sign-in"), "OpenAI refused the sign-in. Nothing was saved.");
  assert.equal(failedText("Port 1455 is in use."), "Port 1455 is in use. Nothing was saved.");
});
