/**
 * A run's view made whole before the card reads it. A run started before a field existed (its plan was
 * frozen in an older shape: teams without members or goals, steps without teams, no Who runs counts)
 * still opens: every missing list reads as empty, every missing text as "", and nothing throws.
 * Pure; DOM- and Solid-free.
 */
import { HELPER_LIMIT, type PlaybookMemberView, type PlaybookRunView, type PlaybookStepView, type PlaybookTeamView } from "../../shared/playbook-run";

const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const text = (v: unknown): string => (typeof v === "string" ? v : "");

function member(m: Partial<PlaybookMemberView>): PlaybookMemberView {
  return {
    ...m,
    id: text(m.id),
    label: text(m.label) || text(m.id),
    brief: text(m.brief),
    count: typeof m.count === "number" ? m.count : 1,
    optional: !!m.optional,
    on: m.on ?? true,
    only: !!m.only,
    chain: list(m.chain),
    models: list(m.models),
    options: list(m.options),
    resolved: m.resolved ?? null,
    runnable: m.runnable ?? true,
    note: text(m.note),
  };
}

function team(t: Partial<PlaybookTeamView>): PlaybookTeamView {
  return { ...t, id: text(t.id), label: text(t.label) || text(t.id), goal: text(t.goal), steps: list(t.steps), note: text(t.note), members: list<Partial<PlaybookMemberView>>(t.members).map(member) };
}

const step = (s: Partial<PlaybookStepView>): PlaybookStepView => ({ ...s, id: text(s.id), title: text(s.title), stop: s.stop ?? "never", stopOn: !!s.stopOn, teams: list(s.teams) });

/** The view with every field the card reads present; a whole view comes back as it was. */
export function normalizeRunView(raw: PlaybookRunView): PlaybookRunView {
  const v = raw as Partial<PlaybookRunView>;
  const teams = list<Partial<PlaybookTeamView>>(v.teams).map(team);
  const who = v.who && typeof v.who.teams === "number" && typeof v.who.members === "number" ? v.who : { teams: teams.length, members: teams.reduce((n, t) => n + t.members.filter((m) => m.on).length, 0) };
  return {
    ...raw,
    choices: list(v.choices),
    teams,
    who,
    steps: list<Partial<PlaybookStepView>>(v.steps).map(step),
    cycle: v.cycle ?? null,
    howItRuns: text(v.howItRuns),
    commands: list(v.commands),
    helpers: v.helpers && typeof v.helpers.total === "number" ? v.helpers : { total: 0, limit: HELPER_LIMIT },
    startBlocked: v.startBlocked ?? null,
  };
}
