// Set Up Releases (release-maker) and Set Up Deploy (project-deploy) folded into the Setup chat (al_1): neither can be
// started alone. The Playbooks dialog lists what /api/playbooks answers (listPlaybooks, cut into groups by
// src/lib/playbooks.ts with no other filter), so neither is in the catalog; a verbs/onboard by their ids opens the
// Setup chat (runtime-routes.ts) and the start resolves to the Setup chat's playbook.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { listPlaybooks } from "../playbooks";
import { groupPlaybooks } from "../../src/lib/playbooks";
import { FOLDED_PLAYBOOKS, resolvePlaybookId, SETUP_PLAYBOOK_ID } from "./onboard";

test("the Playbooks dialog offers neither release-maker nor project-deploy", async () => {
  assert.deepEqual([...FOLDED_PLAYBOOKS].sort(), ["project-deploy", "release-maker"]);
  const cat = await listPlaybooks(fileURLToPath(new URL("../../", import.meta.url)), { userDir: "/nonexistent-user-playbooks" });
  const shown = groupPlaybooks(cat).flatMap((g) => g.playbooks.map((p) => p.id));
  assert.ok(shown.length > 0, "the dialog lists something");
  for (const id of FOLDED_PLAYBOOKS) assert.ok(!shown.includes(id), `${id} is not offered: ${shown.join(", ")}`);
});

test("a start by a folded id runs the Setup chat's playbook", () => {
  for (const id of FOLDED_PLAYBOOKS) assert.equal(resolvePlaybookId(id), SETUP_PLAYBOOK_ID);
  assert.equal(resolvePlaybookId("project-verbs"), "project-verbs");
});
