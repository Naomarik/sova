// A small recorded history for the org-history tests (never shipped): two projects of one org, a
// worked example's chain, a deferred decision with options, a cross-project dependency, an org-level
// event, and private markers in every place words may live, so a test can look for each one.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryInput } from "../../shared/org-history";
import type { EngineOptions } from "../statecharts";
import { OrgHost } from "../org-host";
import { HOST_STATECHARTS } from "../org-host/test-statechart";

export const P_A = "pA";
export const P_B = "pB";

/** Words that must reach only the readers allowed them. */
export const MARK = {
  aReason: "MARKAREASON",
  aQuote: "MARKAQUOTE",
  aOption: "MARKAOPTION",
  bReason: "MARKBREASON",
  bWhat: "MARKBWHAT",
  orgWhat: "MARKORGWHAT",
  contact: "MARKCONTACT@example.org",
  bChild: "MARKBCHILD",
  otherSession: "MARKSESSB",
  otherPerson: "MARKBOB",
  otherKey: "MARKKEYB",
  otherCommit: "MARKCOMMITB",
} as const;

/** The markers that are words (never in a structural line); the others are ids recorded on purpose. */
export const WORD_MARKS = [MARK.aReason, MARK.aQuote, MARK.aOption, MARK.bReason, MARK.bWhat, MARK.orgWhat, MARK.contact, MARK.bChild];

export interface Fixture {
  root: string;
  workspaceDir: string;
  stateDir: string;
  host: OrgHost;
  now: { t: number };
  ids: Record<string, string>;
  close(): Promise<void>;
}

const op = { kind: "operator" } as const;
const sova = { kind: "sova" } as const;

function input(kind: HistoryInput["kind"], outcome: HistoryInput["outcome"], key: string, more: Partial<HistoryInput> = {}): HistoryInput {
  return { kind, outcome, projects: { primary: P_A }, actors: {}, source: { adapter: "fixture", version: 1, key }, ...more };
}

export async function fixture(opts: { root?: string; workspaceDir?: string; stateDir?: string } = {}): Promise<Fixture> {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), "org-history-"));
  const workspaceDir = opts.workspaceDir ?? join(root, "ws");
  const stateDir = opts.stateDir ?? join(root, "state");
  const now = { t: Date.UTC(2026, 3, 8, 8, 45) };
  const host = await OrgHost.open({ orgId: "o1", workspaceDir, stateDir, durable: false, clock: () => now.t, statecharts: HOST_STATECHARTS as unknown as EngineOptions["statecharts"] });
  const ids: Record<string, string> = {};
  const rec = async (name: string, i: HistoryInput, minutes = 5) => {
    now.t += minutes * 60_000;
    ids[name] = (await host.record([i]))[0]!;
  };
  // E0: the other project's observation, with its own private words
  await rec("E0", input("validation.observed", "observed", "e0", { projects: { primary: P_B }, actors: { recordedBy: { kind: "validation-runner" }, executedBy: { kind: "validation-runner" } }, rationale: { what: `Export validation unapproved ${MARK.bWhat}`, reason: { text: `Ledger export not approved ${MARK.bReason}`, author: { kind: "validation-runner" }, contemporaneous: true } } }));
  // E1: the operator's request, about both projects
  await rec("E1", input("request.made", "done", "e1", { projects: { primary: P_A, affected: [P_B] }, actors: { initiatedBy: op, decidedBy: op, recordedBy: op, executedBy: sova, authorization: { kind: "operator-act" } } }));
  // E2: a gap the request triggered
  await rec("E2", input("gap.filed", "recorded", "e2", { triggeredBy: [{ event: ids["E1"]!, via: "tool-call" }], actors: { initiatedBy: op, decidedBy: { kind: "project-overseer", id: P_A }, recordedBy: { kind: "project-overseer", id: P_A }, executedBy: sova, authorization: { kind: "confirm-card", attended: true, ref: `card:people=${MARK.otherPerson};projects=${P_B};sessions=${MARK.otherSession}` } }, entities: [{ type: "gap", id: "g1" }, { type: "session", id: MARK.otherSession }, { type: "project", id: P_B }], aliases: [`hold:${MARK.otherKey}`], evidence: [{ n: 1, kind: "transcript", session: MARK.otherSession, entry: "u1", check: "unchecked" }, { n: 2, kind: "git", repo: "project", project: P_B, commit: MARK.otherCommit }, { n: 3, kind: "transcript", session: "s1", entry: "u2", check: "unchecked" }] }));
  // E6: a person's deferral, with options, a quote and a dependency on E0
  await rec(
    "E6",
    input("decision.recorded", "deferred", "decision:s1:m6", {
      parentKeys: [{ key: "e2", via: "spawn" }],
      relations: [{ type: "depends-on", target: { event: ids["E0"]! } }],
      decision: { disposition: "defer", options: [{ id: "csv", outcome: "selected" }, { id: "bank", outcome: "deferred" }, { id: "manual", outcome: "rejected" }], authority: { kind: "person", id: "priya" } },
      evidence: [
        { n: 1, kind: "transcript", session: "s1", entry: "u6", speaker: { kind: "person", id: "priya" }, check: "checked" },
        { n: 2, kind: "event", event: ids["E0"]! },
      ],
      actors: { initiatedBy: op, decidedBy: { kind: "person", id: "priya", contact: MARK.contact } as never, recordedBy: { kind: "model", model: "opus-5.5", session: "s1" }, executedBy: sova, authorization: { kind: "person-decision" } },
      rationale: {
        what: "Bank sync deferred for Q1",
        reason: { text: `The ledger export is not approved ${MARK.aReason}`, author: { kind: "person", id: "priya" }, contemporaneous: true },
        options: [
          { id: "csv", label: "Weekly approved CSV" },
          { id: "bank", label: "Direct bank API", condition: "until ledger validation is approved" },
          { id: "manual", label: `Manual entry ${MARK.aOption}`, reason: "too much repeated entry" },
        ],
        quotes: [{ n: 1, text: `Let's not do bank sync yet ${MARK.aQuote} ${MARK.contact}` }],
      },
    }),
  );
  // E7 and E8 in one step: the build is grouped under the promotion (same journal, recorded trigger)
  now.t += 5 * 60_000;
  const [e7, e8] = await host.record([
    input("promotion.made", "done", "e7", { triggeredBy: [{ event: ids["E6"]!, via: "operator-act" }], actors: { initiatedBy: op, decidedBy: op, recordedBy: op, executedBy: { kind: "project-overseer", id: P_B, session: MARK.otherSession } } }),
    input("build.started", "started", "e8", { parentKeys: [{ key: "e7", via: "effect" }], actors: { initiatedBy: op, decidedBy: { kind: "statechart" }, recordedBy: sova, executedBy: { kind: "worker" } } }),
  ]);
  ids["E7"] = e7!;
  ids["E8"] = e8!;
  // E9: the other project's consequence of the build, with private words
  await rec("E9", input("validation.observed", "observed", "e9", { projects: { primary: P_B }, triggeredBy: [{ event: ids["E8"]!, via: "effect" }], rationale: { what: `Ledger check ${MARK.bChild}` } }));
  // Z: an org-level event
  await rec("Z", input("setting.changed", "done", "z", { projects: { primary: null }, actors: { initiatedBy: op, decidedBy: op, recordedBy: op, executedBy: sova }, rationale: { what: `Owner changed ${MARK.orgWhat}` } }));
  return {
    root,
    workspaceDir,
    stateDir,
    host,
    now,
    ids,
    async close() {
      await host.close();
      if (!opts.root) rmSync(root, { recursive: true, force: true });
    },
  };
}
