// Run: npx tsx --test src/lib/open-failure.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { openFailureView, type OpenFailureActionId } from "./open-failure";
import type { TargetInfo } from "./remote-session";

const FILE = "/home/user/.pi/agent/sessions/--home-user-.pi-agent-pi-web-targets-acme-prod-home-deploy-acme-site--/2026-09-21T14-28-46-697Z_0199f4bb.jsonl";
const PLACEHOLDER = "/home/user/.pi/agent/pi-web/targets/acme-prod/home/deploy/acme-site";
const goneError = `Stored session working directory does not exist: ${PLACEHOLDER}\nSession file: ${FILE}`;
const remoteSummary = { cwd: PLACEHOLDER, target: "acme-prod", remoteCwd: "/home/deploy/acme-site", origin: "web" as const };
const TARGETS: TargetInfo[] = [{ name: "acme-prod", label: "acme prod", kind: "ssh", host: "deploy@foldai-control" }];
const ids = (actions: { id: OpenFailureActionId }[]) => actions.map((a) => a.id);

test("a remote placeholder folder that is gone: says placeholder, names the target", () => {
  const v = openFailureView(remoteSummary, goneError);
  assert.equal(v.kind, "folder-gone");
  assert.equal(v.target, "acme-prod");
  assert.ok(v.title.includes("placeholder"));
  assert.ok(v.detail.includes(PLACEHOLDER));
  assert.ok(v.detail.includes("on acme-prod, in /home/deploy/acme-site"));
  assert.match(v.detail, /A new session in the same remote folder recreates the placeholder/);
  assert.ok(v.detail.includes("Nothing in the session file changed"));
  assert.deepEqual(ids(v.actions), ["reconnect", "archive"]);
  assert.equal(v.actions[1]!.title, "Move this session to the Archive region. Nothing is deleted; unarchive brings it back.");
});

test("the targets list supplies the label; without it the name is the label", () => {
  assert.ok(openFailureView(remoteSummary, goneError, TARGETS).detail.includes("on acme prod, in"));
  assert.ok(openFailureView(remoteSummary, goneError).detail.includes("on acme-prod, in"));
});

test("a local session whose folder was deleted: names the folder, never mentions mounts", () => {
  const v = openFailureView(
    { cwd: "/home/user/gone-project", origin: "web" },
    "Stored session working directory does not exist: /home/user/gone-project\nSession file: " + FILE,
  );
  assert.equal(v.kind, "folder-gone");
  assert.ok(v.detail.includes("/home/user/gone-project"));
  assert.ok(v.detail.includes("Nothing in the session file changed"));
  assert.deepEqual(ids(v.actions), ["reconnect", "archive"]);
  assert.doesNotMatch(`${v.title} ${v.detail}`, /mount/i);
});

test("no summary at all: the error text still yields its kind, and no Archive", () => {
  const gone = openFailureView(undefined, `Stored session working directory does not exist: /gone\nSession file: ${FILE}`);
  assert.equal(gone.kind, "folder-gone");
  assert.equal(gone.target, undefined);
  assert.ok(gone.detail.includes("/gone"));
  // Without a summary the origin (and archived state) can't be verified, so no Archive.
  assert.deepEqual(ids(gone.actions), ["reconnect"]);
});

test("Archive is offered only for unarchived web sessions, like the pane's button", () => {
  const archived = openFailureView({ ...remoteSummary, archived: true }, goneError);
  assert.deepEqual(ids(archived.actions), ["reconnect"]);
  const external = openFailureView({ ...remoteSummary, origin: "external" as const }, goneError);
  assert.deepEqual(ids(external.actions), ["reconnect"]);
});

test("a legacy sshfs-mount cwd refusal is shown verbatim with the way back: Archive is the fix", () => {
  const legacy =
    "This session was created inside an sshfs mount of target acme-prod, a feature Sova no longer has; its files are on the target, not here. " +
    `Archive this session, or start a new remote session on acme-prod.\nSession file: ${FILE}`;
  const v = openFailureView({ cwd: "/home/user/.pi/agent/mounts/acme-prod", origin: "web" }, legacy);
  assert.equal(v.kind, "unknown");
  assert.equal(v.title, "This session can't be opened.");
  assert.ok(v.detail.includes("a feature Sova no longer has"));
  assert.ok(v.detail.includes("start a new remote session on acme-prod"));
  assert.deepEqual(ids(v.actions), ["reconnect", "archive"]);
});

test("an unrecognized failure keeps the server's words verbatim and the way back", () => {
  const v = openFailureView({ cwd: "/w", origin: "web" }, "Something else went wrong.\nSession file: " + FILE);
  assert.equal(v.kind, "unknown");
  assert.equal(v.title, "This session can't be opened.");
  assert.ok(v.detail.includes("Something else went wrong."));
  assert.ok(v.detail.includes("Nothing in the session file changed"));
  assert.deepEqual(ids(v.actions), ["reconnect", "archive"]);
});
