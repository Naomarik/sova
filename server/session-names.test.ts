// How the Overseer names sessions (§app.overseer/session-names).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { cleanAlias, idOfAlias, readAliases, sessionName, setAlias } from "./session-names";
import { briefText } from "./overseer";
import { pushPayload } from "./push";

const dir = mkdtempSync(join(tmpdir(), "sova-session-names-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const none = () => ({ redact: (s: string) => s }) as never;

describe("summary-first names", () => {
  const firstMessage = { title: "/home/me/.pi/agent/sessions/--x--/2026_01.jsonl can you look at this", outlineGist: "Sandbox menu redesign", outlineNow: "Running the tests" };
  test("alias, then a title someone set, then the summary (gist, else now), then the first message", () => {
    assert.equal(sessionName(firstMessage, "menu work"), "menu work");
    assert.equal(sessionName({ ...firstMessage, title: "Sandbox Menu", titleBy: "user" }), "Sandbox Menu");
    assert.equal(sessionName(firstMessage), "Sandbox menu redesign");
    assert.equal(sessionName({ ...firstMessage, outlineGist: undefined }), "Running the tests");
    assert.equal(sessionName({ title: "fix it" }), "fix it");
  });

  test("briefs and phone notifications use the name, never the raw first message", () => {
    const item = { kind: "needs-input" as const, id: "s1", title: firstMessage.title, name: sessionName(firstMessage), detail: "Pick one" };
    assert.equal(briefText([item], none).split("\n")[1], "- needs-input: [Sandbox menu redesign](sova://s/s1) — Pick one");
    assert.match(pushPayload([item], 1, 0, none).title, /· Sandbox menu redesign$/);
    // Without a name (an older item), the title as before.
    assert.match(pushPayload([{ ...item, name: undefined }], 1, 0, none).title, /^Needs input · \/home\/me\/\.pi/);
  });
});

describe("aliases", () => {
  test("set, found case-insensitively, unique, cleared by an empty alias", () => {
    const f = join(dir, "aliases.json");
    assert.equal(setAlias("s1", "Overseer  fixes", f), null);
    assert.deepEqual(readAliases(f), { s1: "Overseer fixes" });
    assert.equal(idOfAlias("overseer FIXES", readAliases(f)), "s1");
    assert.match(setAlias("s2", "overseer fixes", f) ?? "", /already names session s1/);
    assert.equal(setAlias("s1", "", f), null);
    assert.deepEqual(readAliases(f), {});
    assert.equal(cleanAlias("x".repeat(41)), null);
    assert.equal(cleanAlias("a\u0007b"), null);
  });
});
