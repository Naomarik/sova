// Settings → Models' line about Ollama Cloud's model list check (§app.model-levels/settings-line) and
// its New marks (§app.model-levels/new-models).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelCheckStatus } from "../../shared/protocol";
import { checkLine, newRefs, NEW_FOR_MS } from "./model-check";
import { clockTime } from "./format";

const MIN = 60_000;
const base = (over: Partial<ModelCheckStatus> = {}): ModelCheckStatus => ({ provider: "ollama-cloud", enabled: true, checking: false, newModels: [], ...over });

test("the line: not checked, checking, checked with what changed, failed with when it retries", () => {
  const now = 10 * 60 * MIN;
  assert.equal(checkLine(undefined, now), "Not checked yet");
  assert.equal(checkLine(base(), now), "Not checked yet");
  assert.equal(checkLine(base(), now, true), "Checking…");
  assert.equal(checkLine(base({ checking: true }), now), "Checking…");
  assert.equal(checkLine(base({ last: { at: now - 120 * MIN, ok: true, added: ["a", "b", "c"], retired: ["d"] } }), now), "Checked 2 hours ago · 3 new, 1 retired");
  assert.equal(checkLine(base({ last: { at: now - 10_000, ok: true, added: [], retired: [] } }), now), "Checked just now · no changes");
  assert.equal(checkLine(base({ last: { at: now - MIN, ok: true, added: ["a"], retired: [] } }), now), "Checked 1 minute ago · 1 new");
  const retryAt = now + 55 * MIN;
  assert.equal(
    checkLine(base({ last: { at: now - 5 * MIN, ok: false, error: "couldn't reach ollama.com", retryAt, added: [], retired: [] } }), now),
    `Last check failed 5 minutes ago: couldn't reach ollama.com. Retrying at ${clockTime(retryAt)}.`,
  );
  assert.equal(
    checkLine(base({ enabled: false, last: { at: now - 5 * MIN, ok: false, error: "x.", retryAt, added: [], retired: [] } }), now),
    "Last check failed 5 minutes ago: x.",
    "checks off: no retry promised",
  );
});

test("New marks: a week from the check that first listed the model", () => {
  const now = NEW_FOR_MS * 3;
  const s = base({ newModels: [{ ref: "ollama-cloud/a", firstSeenAt: now - NEW_FOR_MS + 1 }, { ref: "ollama-cloud/b", firstSeenAt: now - NEW_FOR_MS }] });
  assert.deepEqual([...newRefs(s, now)], ["ollama-cloud/a"]);
  assert.equal(newRefs(undefined, now).size, 0);
});

test("the line names a refused or unchecked API key from the same round, and says nothing of an accepted one", () => {
  const now = Date.UTC(2026, 10, 5, 12);
  const at = now - 2 * 60_000;
  const status = (key?: { result: "accepted" | "refused" | "unreachable" }, ok = true) =>
    ({ provider: "ollama-cloud", enabled: true, checking: false, newModels: [], last: { at, ok, added: [], retired: [], ...(ok ? {} : { error: "couldn't reach ollama.com" }), ...(key ? { key } : {}) } }) as never;
  assert.equal(checkLine(status({ result: "accepted" }), now), "Checked 2 minutes ago · no changes");
  assert.equal(checkLine(status({ result: "refused" }), now), "Checked 2 minutes ago · no changes · the API key was refused");
  assert.equal(checkLine(status({ result: "unreachable" }, false), now), "Last check failed 2 minutes ago: couldn't reach ollama.com. The API key couldn't be checked.");
});
