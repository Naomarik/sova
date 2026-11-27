// §mesh.lan/proposals: the words Sova's own dialog shows. Over every preset: the full-access sentence is said exactly
// for a grant that is in effect full access; a pairing shows its fingerprint and how it connects, a grant from what
// to what. Over the feed: a frame replaces the waiting list, an answer here drops one, a reopened feed starts empty.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MESH_PRESETS } from "../../shared/mesh-access";
import { FULL_ACCESS_PRESETS, type MeshProposal } from "../../shared/mesh-proposals";
import { clearMeshProposals, dropMeshProposal, noteMeshProposals, proposalText, waitingMeshProposals } from "./mesh-proposals";
import { PRESET_LABEL } from "./mesh-access";

const base = (over: Partial<MeshProposal>): MeshProposal => ({
  id: "mp_1",
  extension: { id: "company", title: "Company Sova" },
  kind: "pair",
  state: "waiting",
  createdAt: 1,
  peer: "co-omar",
  label: "Omar",
  widens: true,
  fullAccess: false,
  ...over,
});

test("every preset: full access is said exactly for sessions and full, and the grant is named in the preset's words", () => {
  for (const grant of MESH_PRESETS) {
    for (const kind of ["pair", "grant"] as const) {
      const t = proposalText(base({ kind, grant, fullAccess: FULL_ACCESS_PRESETS.includes(grant), ...(kind === "grant" ? { from: "presence" } : { role: "accept", fingerprint: "0123-4567-89AB-CDEF-0123-4567-89AB-CDEF" }) }));
      assert.equal(t.full, grant === "sessions" || grant === "full", `${kind} ${grant}`);
      assert.equal(t.grant?.label, PRESET_LABEL[grant]);
      assert.equal(t.action, kind === "pair" ? "Link Computer" : "Give Access");
    }
  }
});

test("a pairing says who dials whom, where this computer listens, and the fingerprint; a grant says what it has now", () => {
  const dial = proposalText(base({ role: "dial", host: "127.0.0.1", port: 47011, fingerprint: "F", grant: "presence" }));
  assert.deepEqual(dial.rows.map((r) => r.value), ["Omar (co-omar)", "This computer dials it at 127.0.0.1:47011", "F"]);
  assert.equal(dial.title, "Company Sova asks to link a computer");
  const accept = proposalText(base({ role: "accept", relay: { host: "127.0.0.1", port: 4803 }, fingerprint: "F", grant: "sessions" }));
  assert.deepEqual(accept.rows.map((r) => r.label), ["Computer", "Connection", "Listens at", "Fingerprint"]);
  assert.equal(accept.rows.find((r) => r.label === "Fingerprint")!.mono, true);
  const grant = proposalText(base({ kind: "grant", from: "presence", grant: "sessions" }));
  assert.deepEqual(grant.rows.map((r) => [r.label, r.value]), [["Computer", "Omar (co-omar)"], ["Now", "Presence only"]]);
  assert.equal(grant.title, "Company Sova asks to give Omar more access");
});

test("the feed's frame is the whole waiting list; an answer drops one; a reopened feed starts empty", () => {
  noteMeshProposals({ type: "mesh_proposals", proposals: [base({ id: "a" }), base({ id: "b" }), base({ id: "c", state: "applied" })] });
  assert.deepEqual(waitingMeshProposals().map((p) => p.id), ["a", "b"]);
  dropMeshProposal("a");
  assert.deepEqual(waitingMeshProposals().map((p) => p.id), ["b"]);
  clearMeshProposals();
  assert.deepEqual(waitingMeshProposals(), []);
});
