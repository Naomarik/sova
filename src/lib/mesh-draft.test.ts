import assert from "node:assert/strict";
import { test } from "node:test";
import type { MeshSettings } from "../../shared/protocol";
import { meshDraftIssue, meshDraftOf, meshFieldIssues } from "./mesh-draft";

/** Settings → Mesh: the form checks what the server refuses, before Save (Settings QA D9). */
const saved = { hostLabel: "Host A", sync: { logins: true, themes: true }, frontDoor: null } as unknown as MeshSettings;

test("this host's name: blank or over 80 characters holds Save, the box says why", () => {
  const d = meshDraftOf(saved);
  assert.equal(meshDraftIssue(d), null);
  assert.equal(meshDraftIssue({ ...d, hostLabel: " " }), "This host needs a name.");
  assert.equal(meshDraftIssue({ ...d, hostLabel: "x".repeat(80) }), null);
  assert.equal(meshDraftIssue({ ...d, hostLabel: ` ${"x".repeat(80)} ` }), null, "trimmed, as saved");
  assert.equal(meshDraftIssue({ ...d, hostLabel: "x".repeat(81) }), "This host's name can be at most 80 characters.");
  assert.deepEqual(meshFieldIssues({ ...d, hostLabel: "x".repeat(81) }), { hostLabel: "This host's name can be at most 80 characters.", frontDoor: null });
});

test("the front door: empty is none; otherwise http(s), host and port only", () => {
  const d = meshDraftOf(saved);
  for (const ok of ["", "  ", "https://sova.tail1234.ts.net", "http://10.0.0.2:4800", "https://x/"]) assert.equal(meshDraftIssue({ ...d, frontDoor: ok }), null, ok);
  assert.equal(meshDraftIssue({ ...d, frontDoor: "not a url" }), "The front door must be a web address, like https://sova.example.ts.net.");
  assert.equal(meshDraftIssue({ ...d, frontDoor: "ftp://x" }), "The front door must start with http:// or https://.");
  for (const bad of ["https://x/path", "https://u:p@x", "https://x/?a=1", "https://x/#h"]) assert.equal(meshDraftIssue({ ...d, frontDoor: bad }), "The front door is a scheme, host and port only, with no path.", bad);
  assert.deepEqual(meshFieldIssues({ ...d, frontDoor: "ftp://x" }), { hostLabel: null, frontDoor: "The front door must start with http:// or https://." });
  assert.equal(meshDraftIssue({ ...d, hostLabel: "", frontDoor: "ftp://x" }), "This host needs a name.", "page order: the name first");
});
