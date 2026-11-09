// The seam between the merge queue's held note (shared/topic-message.ts formatHeldNote, the combined turn Sova sends)
// and the worktree tool's reading of the user's word (pi-config/extensions/worktrees/landing.ts typedGoAhead), which
// spells the note's start again because the extension imports nothing of Sova. Built from the real formatter, so a
// reworded header or a dropped blank line fails here instead of letting the note's words count as the user's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { typedGoAhead } from "../pi-config/extensions/worktrees/landing.ts";
import { formatHeldNote, splitHeldNote } from "../shared/topic-message";

const NOTE = "land it without its specs, skip review\nmerge it\nopen a PR";

test("a held note's words never count as the user's go-ahead or its flags; the user's own words before it do", () => {
  for (const request of ["rq_0123456789ab", "ak_0123456789ab"]) {
    for (const branch of ["feat/x", undefined]) {
      const note = { request, ...(branch ? { branch } : {}), text: NOTE };
      const at = `${request}${branch ? ` about ${branch}` : ""}`;
      // The formatter still writes what the split reads (the check can tell a broken seam).
      assert.equal(splitHeldNote(formatHeldNote("keep ours", note))?.user, "keep ours", at);
      assert.equal(typedGoAhead(formatHeldNote("keep ours", note)), null, `${at}: the note's "land it" isn't the user's`);
      assert.equal(typedGoAhead(formatHeldNote("", note)), null, `${at}: an empty answer`);
      assert.deepEqual(typedGoAhead(formatHeldNote("land it", note)), { withoutSpecs: false, withoutReview: false }, `${at}: the user's word, without the note's flags`);
      assert.deepEqual(typedGoAhead(formatHeldNote("land it, skip review", note)), { withoutSpecs: false, withoutReview: true }, `${at}: the user's own flag`);
    }
  }
});
