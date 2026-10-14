// Test-only: links this tree's pi-config extensions into a unit test's throwaway agent dir, for the
// in-process chats it opens. Never imported by product code.
//
// Those chats summarize their topic outline headless, as Sova's do (chat-manager's `outline` flag):
// after a settled turn the topic-outline extension waits its debounce (3 s by default) and then
// calls a summarizer model, the last of which runs the Claude program. In a unit file that is a
// program started on a timer: a file that kept running 3 s past a turn started one (the tier guard
// refuses it), one that ended sooner didn't. The settings written here make that deterministic and
// model-free, through topic-outline.json's documented `trigger`: the check runs at once after each
// turn (debounceMs 0), and no count of new messages ever reaches a summarizer on its own
// (`#`-headed topics still come in, they call no model).
import { symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The topic-outline settings a unit test's agent dir gets: an outline that never calls a model by itself. */
export const UNIT_OUTLINE_SETTINGS = { trigger: { debounceMs: 0, minNewMessages: Number.MAX_SAFE_INTEGER } };

/** Links this tree's pi-config extensions into `agentDir` and writes its topic-outline settings. */
export function linkPiConfigExtensions(agentDir: string): void {
  symlinkSync(resolve(import.meta.dirname, "..", "..", "pi-config", "extensions"), join(agentDir, "extensions"));
  writeFileSync(join(agentDir, "topic-outline.json"), `${JSON.stringify(UNIT_OUTLINE_SETTINGS, null, 2)}\n`);
}
