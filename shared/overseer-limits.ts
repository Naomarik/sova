/**
 * Settings → Overseer's limits, read by the form (src/lib/overseer-draft.ts) and by the save
 * (server/overseer-store.ts), so the form never sends what the server refuses and both say it in
 * the same words (shared/form-rules.ts).
 */
import type { TextRule, WholeRule } from "./form-rules";
import type { OverseerCaps, OverseerPingLimits } from "./protocol";

export const CAP_MAX = 1000;
export const QUICK_ACTIONS_MAX = 12;
export const NOTES_MAX = 8000;
/** Past QUICK_ACTIONS_MAX: the form and the save say this. */
export const TOO_MANY_QUICK_ACTIONS = `There can be at most ${QUICK_ACTIONS_MAX} quick actions.`;
export const EXTRA_PROMPT_MAX = 8000;

export const CAP_KEYS = ["createPerTurn", "promptsPerTurn", "archivesPerTurn", "concurrentSessions", "explorePerTurn", "linksPerTurn", "orgWritesPerTurn", "gatherPerTurn", "extRunsPerTurn"] as const satisfies readonly (keyof OverseerCaps)[];

export const DEFAULT_CAPS: OverseerCaps = { createPerTurn: 5, promptsPerTurn: 10, archivesPerTurn: 50, concurrentSessions: 10, explorePerTurn: 2, linksPerTurn: 3, orgWritesPerTurn: 20, gatherPerTurn: 3, extRunsPerTurn: 5 };

export const CAP_LABEL: Record<keyof OverseerCaps, { label: string; hint: string }> = {
  createPerTurn: { label: "Sessions created", hint: "New sessions it may create, per message you send." },
  promptsPerTurn: { label: "Prompts to other sessions", hint: "Messages it may send to other sessions, per message you send." },
  archivesPerTurn: { label: "Sessions archived", hint: "Sessions it may archive, per message you send." },
  concurrentSessions: {
    label: "Running at once",
    hint:
      "How many sessions the Overseer started or messaged may be working at the same time. Starting a session, or messaging one " +
      "that isn't already counted, needs a free slot; when none is free, the Overseer waits or asks you. Sessions you started " +
      "count only once the Overseer messages them.",
  },
  explorePerTurn: { label: "Ideas explored", hint: "Idea explorers it may launch, per message you send." },
  linksPerTurn: { label: "Links made", hint: "Sessions it may link across hosts, per message you send." },
  orgWritesPerTurn: { label: "Organization changes", hint: "Changes it may make to organizations, projects, rosters and project overseers, per message you send." },
  gatherPerTurn: { label: "Gathering sessions started", hint: "Gathering sessions and offers it may start, per message you send." },
  extRunsPerTurn: { label: "Extension commands run", hint: "Extension commands it may run, per message you send." },
};

/** Sessions' pings' limits (§app.overseer-pings/limits), each a whole number from 0 to CAP_MAX. */
export const PING_LIMIT_KEYS = ["sessionPerHour", "sessionPerDay", "turnGapMin", "turnsPerDay", "relayRecipients", "relayPerDay", "recipientPerHour"] as const satisfies readonly (keyof OverseerPingLimits)[];

export const DEFAULT_PING_LIMITS: OverseerPingLimits = { sessionPerHour: 3, sessionPerDay: 10, turnGapMin: 2, turnsPerDay: 30, relayRecipients: 3, relayPerDay: 20, recipientPerHour: 3 };

export const PING_LIMIT_LABEL: Record<keyof OverseerPingLimits, { label: string; hint: string }> = {
  sessionPerHour: { label: "Pings per session an hour", hint: "Pings one session may send the Overseer in any hour." },
  sessionPerDay: { label: "Pings per session a day", hint: "Pings one session may send the Overseer in a day." },
  turnGapMin: { label: "Minutes between ping turns", hint: "The Overseer wakes for pings at most once in this many minutes." },
  turnsPerDay: { label: "Ping turns a day", hint: "Turns the Overseer may start for pings in a day." },
  relayRecipients: { label: "Sessions per pass-on", hint: "Sessions one note may be passed on to." },
  relayPerDay: { label: "Pass-ons a day on its own", hint: "Sessions the Overseer may pass notes on to in a day, in turns you didn't start." },
  recipientPerHour: { label: "Notes per session an hour", hint: "Passed-on notes one session may get in any hour." },
};

export const PING_LIMIT_RULES = Object.fromEntries(PING_LIMIT_KEYS.map((k) => [k, { kind: "whole", label: PING_LIMIT_LABEL[k].label, min: 0, max: CAP_MAX }])) as Record<keyof OverseerPingLimits, WholeRule>;

/** A settings object's ping limits, every one absent or out of range read as its default. */
export function pingLimitsOf(s: { pings?: Partial<OverseerPingLimits> } | null | undefined): OverseerPingLimits {
  const out = { ...DEFAULT_PING_LIMITS };
  for (const k of PING_LIMIT_KEYS) {
    const v = s?.pings?.[k];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= CAP_MAX) out[k] = v;
  }
  return out;
}

export const CAP_RULES = Object.fromEntries(CAP_KEYS.map((k) => [k, { kind: "whole", label: CAP_LABEL[k].label, min: 0, max: CAP_MAX }])) as Record<keyof OverseerCaps, WholeRule>;

/** A quick action's three boxes; the label each sentence uses is "Quick action {n}'s label". */
export const QA_RULES = {
  label: { kind: "text", label: "label", min: 1, max: 40, trim: true },
  description: { kind: "text", label: "description", max: 120, trim: true },
  prompt: { kind: "text", label: "prompt", min: 1, max: 2000, trim: true },
} satisfies Record<"label" | "description" | "prompt", TextRule>;

export const qaLabel = (n: number, field: keyof typeof QA_RULES): string => `Quick action ${n}'s ${QA_RULES[field].label}`;

export const NOTES_RULE: TextRule = { kind: "text", label: "Standing notes", max: NOTES_MAX };
export const EXTRA_PROMPT_RULE: TextRule = { kind: "text", label: "Extra instructions", max: EXTRA_PROMPT_MAX };
