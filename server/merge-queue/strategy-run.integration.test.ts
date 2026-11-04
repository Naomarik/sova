import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { checkPublishText, draftText } from "./strategy-run";

/** A project with a request folder whose one check refuses any title without a ticket ("ABC-1"). */
function project() {
  const root = scratchRoot("mq-request-text-");
  const kit = join(root, ".sova", "playbooks", "request");
  mkdirSync(join(kit, "scripts"), { recursive: true });
  writeFileSync(join(kit, "PLAYBOOK.md"), "# Requests\nName the ticket in the title.\n");
  writeFileSync(join(kit, "scripts", "check-ticket.mjs"), 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const t=JSON.parse(s);if(!/ABC-\\d+/.test(t.title)){console.error("the title names no ticket");process.exit(1)}});\n');
  return { root, folder: ".sova/playbooks/request", done: () => rmSync(root, { recursive: true, force: true }) };
}

describe("a request folder's checks are shown, never a lock (the lead's ruling)", () => {
  test("Publish goes ahead over a failed folder check, which is kept with its reason; Sova's own limits still refuse", async () => {
    const p = project();
    try {
      const failed = await checkPublishText({ root: p.root, folder: p.folder, how: "github-pr", branch: "feat/x", base: "main", text: { title: "Feature x", body: "Adds x." } });
      assert.equal(failed.ok, true);
      assert.deepEqual(failed.ok && failed.checks.find((c) => c.name === "check-ticket.mjs"), { name: "check-ticket.mjs", ok: false, why: "the title names no ticket" });
      assert.match(failed.ok ? failed.body : "", /Opened by Sova\n$/);
      const passed = await checkPublishText({ root: p.root, folder: p.folder, how: "github-pr", branch: "feat/x", base: "main", text: { title: "ABC-1 Feature x", body: "Adds x." } });
      assert.equal(passed.ok && passed.checks.every((c) => c.ok), true);
      const own = await checkPublishText({ root: p.root, folder: p.folder, how: "github-pr", branch: "feat/x", base: "main", text: { title: "two\nlines", body: "Adds x." } });
      assert.equal(own.ok, false);
      assert.match(!own.ok ? own.why : "", /one line/);
    } finally {
      p.done();
    }
  });

  test("the first draft whose folder check fails is still offered for review, the failure shown", async () => {
    const p = project();
    try {
      const d = await draftText({ root: p.root, folder: p.folder, how: "github-pr", input: { branch: "feat/x", base: "main", chatTitle: "Feature x" } });
      assert.equal(d.ok, true);
      assert.equal(d.ok && d.text.title, "Feature x");
      assert.equal(d.ok && d.text.checks?.some((c) => !c.ok && c.why === "the title names no ticket"), true);
    } finally {
      p.done();
    }
  });
});
