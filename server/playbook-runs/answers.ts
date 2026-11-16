// Your answers per playbook per project: the last run's choices (Same as last time),
// and the ones you saved with Save as My Defaults (Your standing answer). In Sova's own state folder, one file.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PlaybookInput, PlaybookSpec } from "../../shared/playbook-format";
import type { PlaybookCardEdits, PlaybookChoiceOrigin, PlaybookRoleEdit } from "../../shared/playbook-run";
import { stateRoot } from "../state-root";

export interface SavedAnswers {
  choices: Record<string, unknown>;
  roles?: Record<string, PlaybookRoleEdit>;
  stops?: Record<string, boolean>;
  cycle?: { max?: number; askEvery?: number; until?: "rule" | "max" };
  at: string;
}

interface AnswersFile {
  v: 1;
  /** `<source>:<id>@<project folder>` → its answers. */
  playbooks: Record<string, { last?: SavedAnswers; defaults?: SavedAnswers }>;
}

export const answersFile = (): string => join(stateRoot(), "playbook-answers.json");
export const answersKey = (p: { source: string; id: string }, project: string): string => `${p.source}:${p.id}@${project}`;

function readAll(): AnswersFile {
  try {
    const f = JSON.parse(readFileSync(answersFile(), "utf8")) as AnswersFile;
    if (f?.v === 1 && f.playbooks && typeof f.playbooks === "object") return f;
  } catch {
    // None yet, or broken: no answers.
  }
  return { v: 1, playbooks: {} };
}

function writeAll(f: AnswersFile): void {
  const file = answersFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, JSON.stringify(f), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

export const readAnswers = (key: string): { last?: SavedAnswers; defaults?: SavedAnswers } => readAll().playbooks[key] ?? {};

export function saveAnswers(key: string, which: "last" | "defaults", a: Omit<SavedAnswers, "at">): void {
  const f = readAll();
  f.playbooks[key] = { ...f.playbooks[key], [which]: { ...a, at: new Date().toISOString() } };
  writeAll(f);
}

/**
 * A new card's first values and where each came from: your saved defaults (Your standing answer), else a
 * once-asked choice's last answer (Your standing answer), else the last run's (Same as last time), else the
 * playbook's default. Role picks, stops and cycle settings come from your defaults only.
 */
export function firstValues(spec: PlaybookSpec, saved: { last?: SavedAnswers; defaults?: SavedAnswers }): { choices: Record<string, unknown>; origins: Record<string, PlaybookChoiceOrigin> } & Omit<PlaybookCardEdits, "choices"> {
  const choices: Record<string, unknown> = {};
  const origins: Record<string, PlaybookChoiceOrigin> = {};
  const has = (a: SavedAnswers | undefined, input: PlaybookInput) => !!a && Object.prototype.hasOwnProperty.call(a.choices, input.id) && a.choices[input.id] !== null;
  for (const input of spec.inputs) {
    if (has(saved.defaults, input)) {
      choices[input.id] = saved.defaults!.choices[input.id];
      origins[input.id] = "standing";
    } else if (has(saved.last, input)) {
      choices[input.id] = saved.last!.choices[input.id];
      origins[input.id] = input.ask === "once" ? "standing" : "last";
    } else if (input.default !== undefined) {
      choices[input.id] = input.default;
      origins[input.id] = "default";
    } else origins[input.id] = "default";
  }
  const d = saved.defaults;
  return { choices, origins, ...(d?.roles ? { roles: d.roles } : {}), ...(d?.stops ? { stops: d.stops } : {}), ...(d?.cycle ? { cycle: d.cycle } : {}) };
}
