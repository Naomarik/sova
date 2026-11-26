// Which session folders are watched live (§app.session-list/live-watch-scope): pure.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { hotFolders, isWatchLimit, RECENT_WATCH_MS } from "./session-watch-scope";

describe("hotFolders", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  const at = (ms: number) => new Date(now - ms).toISOString();
  test("an open or running chat's folder, and one active within 7 days; never an older one", () => {
    const hot = hotFolders({
      now,
      active: ["/s/--open--/a.jsonl"],
      rows: [
        { path: "/s/--recent--/b.jsonl", lastActiveAt: at(RECENT_WATCH_MS - 60_000) },
        { path: "/s/--old--/c.jsonl", lastActiveAt: at(RECENT_WATCH_MS + 60_000) },
        { path: "/s/--undated--/d.jsonl" },
      ],
    });
    assert.deepEqual([...hot].sort(), ["/s/--open--", "/s/--recent--"]);
  });
  test("the limit errors are ENOSPC, EMFILE and ENFILE only", () => {
    assert.deepEqual(["ENOSPC", "EMFILE", "ENFILE", "ENOENT", undefined].map((code) => isWatchLimit({ code })), [true, true, true, false, false]);
  });
});
