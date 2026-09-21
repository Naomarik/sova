// Run: npx tsx --test src/lib/open-failure.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { openFailureView, type OpenFailureActionId } from "./open-failure";
import type { TargetInfo } from "./remote-session";

const MOUNT = "/home/user/.pi/agent/mounts/acme-prod";
const FILE = "/home/user/.pi/agent/sessions/--home-user-.pi-agent-mounts-acme-prod--/2026-09-21T14-28-46-697Z_0199f4bb.jsonl";
const mountDownError = `Stored session working directory is not reachable through its mount: no mount at ${MOUNT}\nSession file: ${FILE}`;
const mountSummary = { cwd: MOUNT, target: "acme-prod", remoteCwd: "/home/deploy/acme-site", mounted: true, origin: "web" as const };
const TARGETS: TargetInfo[] = [{ name: "acme-prod", label: "acme prod", kind: "ssh", host: "deploy@foldai-control" }];
const ids = (actions: { id: OpenFailureActionId }[]) => actions.map((a) => a.id);

test("a mount cwd with the mount down: names the target and the mount point, offers Mount", () => {
  const v = openFailureView(mountSummary, mountDownError);
  assert.equal(v.kind, "mount-down");
  assert.equal(v.target, "acme-prod");
  assert.match(v.title, /mount is down/);
  assert.ok(v.title.includes("acme-prod"));
  assert.ok(v.detail.includes(MOUNT));
  assert.ok(v.detail.includes("/home/deploy/acme-site"));
  assert.match(v.detail, /mounting acme-prod again/);
  assert.ok(v.detail.includes("Nothing in the session file changed"));
  assert.deepEqual(ids(v.actions), ["mount", "reconnect", "archive"]);
  assert.equal(v.actions[0]!.label, "Mount and reconnect");
  assert.equal(v.actions[2]!.title, "Move this session to the Archive region. Nothing is deleted; unarchive brings it back.");
});

test("the targets list supplies the label; without it the name is the label", () => {
  const labelled = openFailureView(mountSummary, mountDownError, TARGETS);
  assert.ok(labelled.title.includes("acme prod's mount is down"));
  assert.match(labelled.detail, /mounting acme prod again/);
  const named = openFailureView(mountSummary, mountDownError);
  assert.ok(named.title.includes("acme-prod's mount is down"));
});

test("a failed mount attempt shows the mount module's real reason, not 'not mounted'", () => {
  const ssh = "acme-prod: ssh: connect to host foldai-control port 22: Connection refused";
  const v = openFailureView(mountSummary, mountDownError, undefined, ssh);
  assert.equal(v.mountError, `Mount failed: ${ssh}`);
  // The diagnosis stays what it is — the mount is still down — and the actions stay offered.
  assert.equal(v.kind, "mount-down");
  assert.match(v.title, /mount is down/);
  assert.deepEqual(ids(v.actions), ["mount", "reconnect", "archive"]);
});

test("a mount that is up but can't be read: the real reason verbatim, no Mount button", () => {
  const v = openFailureView(
    mountSummary,
    `Stored session working directory is not reachable through its mount: no answer within 3s: the mount at ${MOUNT} is hung\nSession file: ${FILE}`,
  );
  assert.equal(v.kind, "mount-broken");
  assert.ok(v.detail.includes("no answer within 3s: the mount at /home/user/.pi/agent/mounts/acme-prod is hung"));
  assert.ok(v.detail.includes("Nothing in the session file changed"));
  assert.deepEqual(ids(v.actions), ["reconnect", "archive"]);
});

test("an up mount whose folder is gone on the target: mount-folder-gone, no Mount button", () => {
  const v = openFailureView(
    mountSummary,
    `Stored session working directory is not reachable through its mount: no such directory through the mount: ${MOUNT}\nSession file: ${FILE}`,
  );
  assert.equal(v.kind, "mount-folder-gone");
  assert.ok(v.title.includes("gone on acme-prod"));
  assert.match(v.detail, /mount is up, but that folder doesn't exist on acme-prod anymore/);
  assert.deepEqual(ids(v.actions), ["reconnect", "archive"]);
});

test("a remote placeholder folder that is gone: says placeholder, names the target, no Mount button", () => {
  const cwd = "/home/user/.pi/agent/pi-web/targets/acme-prod/home/deploy/acme-site";
  const v = openFailureView(
    { cwd, target: "acme-prod", remoteCwd: "/home/deploy/acme-site", origin: "web" },
    `Stored session working directory does not exist: ${cwd}\nSession file: ${FILE}`,
  );
  assert.equal(v.kind, "folder-gone");
  assert.ok(v.title.includes("placeholder"));
  assert.ok(v.detail.includes(cwd));
  assert.ok(v.detail.includes("on acme-prod, in /home/deploy/acme-site"));
  assert.match(v.detail, /A new session in the same remote folder recreates the placeholder/);
  assert.ok(v.detail.includes("Nothing in the session file changed"));
  assert.deepEqual(ids(v.actions), ["reconnect", "archive"]);
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

test("no summary at all: the error text still yields its kind and never offers Mount", () => {
  const v = openFailureView(undefined, mountDownError);
  assert.equal(v.kind, "mount-down");
  assert.equal(v.target, undefined);
  assert.ok(v.detail.includes(`no mount at ${MOUNT}`));
  // Without a summary the origin (and archived state) can't be verified, so no Archive either.
  assert.deepEqual(ids(v.actions), ["reconnect"]);
  const gone = openFailureView(undefined, `Stored session working directory does not exist: /gone\nSession file: ${FILE}`);
  assert.equal(gone.kind, "folder-gone");
  assert.ok(gone.detail.includes("/gone"));
  assert.deepEqual(ids(gone.actions), ["reconnect"]);
});

test("Archive is offered only for unarchived web sessions, like the pane's button", () => {
  const archived = openFailureView({ ...mountSummary, archived: true }, mountDownError);
  assert.deepEqual(ids(archived.actions), ["mount", "reconnect"]);
  const external = openFailureView({ ...mountSummary, origin: "external" as const }, mountDownError);
  assert.deepEqual(ids(external.actions), ["mount", "reconnect"]);
});

test("an unrecognized failure keeps the server's words verbatim and the way back", () => {
  const v = openFailureView({ cwd: "/w", origin: "web" }, "Something else went wrong.\nSession file: " + FILE);
  assert.equal(v.kind, "unknown");
  assert.equal(v.title, "This session can't be opened.");
  assert.ok(v.detail.includes("Something else went wrong."));
  assert.ok(v.detail.includes("Nothing in the session file changed"));
  assert.deepEqual(ids(v.actions), ["reconnect", "archive"]);
  assert.equal(v.mountError, undefined);
});