import type { RuntimeFeedLine } from "../../shared/project-runtime";

/**
 * The registry's feed (§app.project-runtime/standing, /approve, /onboard): one line per move of `runtime/<p>`,
 * read from its log rows. The standing moves by eventless transitions, so a line comes from the states a row
 * entered (before → after), and its details from the data the rows changed, followed oldest first. Pure.
 */

/** The parts of a log row the feed reads. */
export interface FeedRow {
  at: number;
  event: string;
  before: string[];
  after: string[];
  changed: Record<string, unknown>;
  refused?: string;
}

const STANDINGS = ["unregistered", "awaiting-approval", "conforming", "registered", "stale", "failed"] as const;
const RUNS = ["idle", "running", "waiting", "proposed"] as const;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
export const hash12 = (h: unknown): string => str(h).replace(/^sha256:/, "").slice(0, 12);

/** What the rows changed so far: each path's newest value (`changed` is `{path: [from, to]}`, maps one level deep). */
class Mirror {
  private m = new Map<string, unknown>();
  take(changed: Record<string, unknown>): void {
    for (const [path, pair] of Object.entries(changed)) if (Array.isArray(pair) && pair.length === 2) this.m.set(path, pair[1]);
  }
  /** A key's value: the whole key, else its one-level parts (`def.hash`). */
  get(key: string, part?: string): unknown {
    if (part === undefined) return this.m.get(key);
    if (this.m.has(`${key}.${part}`)) return this.m.get(`${key}.${part}`);
    return obj(this.m.get(key))[part];
  }
}

/** Main's hash as shown: the log drops hash values, so the statechart keeps `hash12` beside them. */
const shown = (m: Mirror): string => str(m.get("hash12")) || hash12(m.get("def", "hash"));

/** The run's playbook by its title (§app.project-runtime/verb-playbooks); a run recorded before it had one is Project verbs'. */
const label = (m: Mirror): string => str(m.get("playbook", "label")) || "Project verbs";

const entered = (r: FeedRow, s: string): boolean => r.after.includes(s) && !r.before.includes(s);

function standingLine(s: string, m: Mirror): string | null {
  switch (s) {
    case "unregistered":
      return "The project declares no software yet (.sova/project.json is missing on main).";
    case "awaiting-approval":
      return `The definition on main (${shown(m)}) runs here once you approve it.`;
    case "conforming":
      return "Conformance is running on main.";
    case "registered": {
      const n = Array.isArray(m.get("software")) ? (m.get("software") as unknown[]).length : 0;
      return `The project's software is registered: ${n} service${n === 1 ? "" : "s"}, proven at ${shown(m)}.`;
    }
    case "stale": {
      const paths = m.get("drift", "paths");
      return `The project's stack changed since its software was registered (${Array.isArray(paths) ? paths.join(", ") : ""}). Run the Project verbs playbook to bring it up to date.`;
    }
    case "failed": {
      if (m.get("def", "state") === "invalid") return `The definition on main is invalid: ${str(m.get("def", "error"))}`;
      const f = obj(m.get("conform-result", "failed") ?? m.get("proof", "failed"));
      return `Conformance failed on main at ${str(f.check) || "run"}: ${str(f.detail)}.`;
    }
  }
  return null;
}

function runLine(s: string, r: FeedRow, m: Mirror): string | null {
  switch (s) {
    case "running":
      if (r.before.includes("proposed") || r.before.includes("waiting")) return null;
      return `The ${label(m)} playbook was started${str(m.get("playbook", "why")) ? `: ${str(m.get("playbook", "why"))}` : ""}.`;
    case "waiting":
      return `The ${label(m)} playbook waits on your answers in its session.`;
    case "proposed":
      return `The ${label(m)} playbook proposes a definition on ${str(m.get("playbook", "branch"))}: approve it, then merge.`;
    case "idle":
      switch (str(m.get("playbook", "result"))) {
        case "no-change":
          return `The ${label(m)} playbook finished with no change.`;
        case "merged":
          return `The ${label(m)} playbook's branch was merged.`;
        case "not-started":
          return `The ${label(m)} playbook could not start.`;
        case "removed":
          return `The ${label(m)} playbook's worktree was removed.`;
      }
  }
  return null;
}

/** The feed, newest first, at most `max` lines. */
export function runtimeFeed(rows: readonly FeedRow[], max = 20): RuntimeFeedLine[] {
  const m = new Mirror();
  const out: RuntimeFeedLine[] = [];
  const at = (ms: number) => new Date(ms).toISOString();
  for (const r of [...rows].sort((a, b) => a.at - b.at)) {
    if (r.refused) continue;
    m.take(r.changed ?? {});
    // the session's start enters its initial states: nothing has been read yet
    if (r.event === "sova/started") continue;
    if (r.event === "effect/done" && Object.keys(r.changed ?? {}).some((k) => k === "approved-last" || k.startsWith("approved-last."))) out.push({ at: at(r.at), line: `You approved the definition ${str(m.get("approved-last", "hash12")) || hash12(m.get("approved-last", "hash"))} on this host.` });
    for (const s of STANDINGS) if (entered(r, s)) {
      const line = standingLine(s, m);
      if (line) out.push({ at: at(r.at), line });
    }
    for (const s of RUNS) if (entered(r, s)) {
      const line = runLine(s, r, m);
      if (line) out.push({ at: at(r.at), line });
    }
  }
  return out.reverse().slice(0, max);
}
