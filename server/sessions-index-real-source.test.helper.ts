// Where the real-session parity gate (server/sessions-index-real.parity.test.ts) samples from.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type ParitySource =
  | { kind: "sample"; sessionsRoot: string; source: string }
  | { kind: "skip"; reason: string };

/** The copy of the real sessions to sample, or why there is none. A local, untracked
    .tmp/verifier/real-source names one (one line: an agent dir, or a sessions folder itself, as the
    bench's .tmp/bench-sessions; read only, never written) and is always taken. Otherwise this
    checkout's hermetic .agent, only when its copied-sessions.json says it holds copies of real chats
    (scripts/hermetic-agent-dir.mjs writes it in copied mode, as the bench's --prepare runs it): a
    plain hermetic .agent holds this tree's own test chats, not the user's. `sessionsRoot` is the
    folder of session files, `source` the agent dir whose sova/ stores go with them. */
export function paritySource(repo: string): ParitySource {
  const pointer = join(repo, ".tmp", "verifier", "real-source");
  let named: string;
  if (existsSync(pointer)) named = resolve(repo, readFileSync(pointer, "utf8").trim());
  else {
    named = join(repo, ".agent");
    if (!existsSync(join(named, "copied-sessions.json"))) return { kind: "skip", reason: "no copy of the real chats here, nothing checked" };
  }
  const nested = existsSync(join(named, "sessions"));
  return { kind: "sample", sessionsRoot: nested ? join(named, "sessions") : named, source: nested ? named : dirname(named) };
}
