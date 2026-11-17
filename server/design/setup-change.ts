// Every change to an open Setup card goes through here: the user's whole-card save and the main chat's edit alike. The
// latest change wins the whole card. Inside one store change it checks the card, refreshes what follows from it (the
// links its words name, and with the brief open the brief's version and estimate), and stamps the run.
import { designEffortOf, designerSkills, designHasEfforts, designPlan, runOwnImage, type DesignModelChoice, type DesignRun, type DesignSetup, type DesignSkill, type DesignSkillMissing } from "../../shared/design";
import { designInGroup, designSectionOf, designSectionOfWord } from "../../shared/design-models";
import { readAssets } from "./assets";
import { cleanSetup, effortProblem, estimateUsd } from "./setup";
import { skillReadTokens, SKILL_LIMITS } from "./skills";
import { changeDesigns } from "./store";
import { rememberHidden } from "./standing";

/** A change that can't be made: words, and the status a route answers with. */
export class SetupRefused extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
    /** A save made from a card older than the newest change: the run as it is now, for the card to take. */
    readonly stale?: DesignRun,
  ) {
    super(message);
  }
}

/** The stamp a save names as the card it was made from: the newest Setup change, else the run's making. */
export const setupBase = (run: Pick<DesignRun, "setupAt" | "createdAt">): string => run.setupAt ?? run.createdAt;

/** The phases a Setup may still change in: setup (all of it), and until Start on the brief (the smaller set). */
export const setupOpen = (run: Pick<DesignRun, "phase">): boolean => run.phase === "setup" || run.phase === "researching" || run.phase === "brief";

/** What a change makes of the run: the whole card, as cleanSetup takes it, and the run's own fields it sets. */
export interface SetupChange {
  setup: unknown;
  run?: Partial<Pick<DesignRun, "images" | "imagesLeftOut" | "skills" | "skillsMissing" | "hiddenSections" | "hiddenAsked">>;
}

/**
 * The one way a run's Setup changes. `make` reads the run as it is inside the store change and returns the card it
 * should hold (or words to refuse with). The card is checked by cleanSetup (only rows and names the card offers; with
 * the Creative Director started, only models, efforts, styles and layouts), its links re-read from its words, and with
 * the brief on the card its version raised and its estimate redone. Throws SetupRefused.
 */
export function commitSetup(sessionId: string, runId: string, make: (run: DesignRun, briefOpen: boolean) => SetupChange | string, opts: { base?: string } = {}): DesignRun {
  return changeDesigns(sessionId, (s) => {
    const r = s.runs.find((x) => x.id === runId);
    if (!r) throw new SetupRefused("No such design run.", 404);
    if (!setupOpen(r)) throw new SetupRefused("This run has started, so its Setup is closed.", 409);
    // The latest change wins: a save made from an older card (the chat changed it meanwhile) changes nothing.
    if (opts.base !== undefined && opts.base !== setupBase(r)) throw new SetupRefused("The card changed since this save was made.", 409, structuredClone(r));
    const briefOpen = r.phase !== "setup";
    const change = make(r, briefOpen);
    if (typeof change === "string") throw new SetupRefused(change);
    // Hidden as the card stood before this change: a Hide itself unticks its rows and moves the seat.
    const next = cleanSetup(r.setup, change.setup, briefOpen, r.hiddenSections ?? []);
    if (typeof next === "string") throw new SetupRefused(next);
    r.setup = next;
    Object.assign(r, change.run ?? {});
    for (const k of ["images", "imagesLeftOut", "skills", "skillsMissing", "hiddenSections", "hiddenAsked"] as const) if (Array.isArray(r[k]) && !r[k]!.length) delete r[k];
    // Always later than the stamp before, even within one millisecond: it is the next save's base.
    const at = new Date(Math.max(Date.now(), r.setupAt ? Date.parse(r.setupAt) + 1 : 0)).toISOString();
    r.setupAt = at;
    r.updatedAt = at;
    if (r.phase === "brief" && r.brief && r.brief.startedRev === undefined) {
      // On the card, so what Start starts from has moved; and so has what it should cost.
      r.brief.rev++;
      const estimate = estimateUsd(next, Date.now(), skillReadTokens(designerSkills(r)));
      if (estimate === null) delete r.brief.estimateUsd;
      else r.brief.estimateUsd = estimate;
    }
    return r;
  });
}

// ---- the providers the user hides -----------------------------------------------------------------

/**
 * Hide or show a provider's section on a run's card, and remember it for later cards. Hidden rows stay on the card,
 * unticked; the Creative Director, before it starts, moves to the first ticked shown model, else the first shown one.
 * The last shown section can't be hidden.
 */
export function hideSection(sessionId: string, runId: string, section: string, hidden: boolean): DesignRun {
  const run = commitSetup(sessionId, runId, (r, briefOpen) => {
    const sections = new Set(r.setup.models.map((m) => designSectionOf(m.ref).id));
    if (!sections.has(section)) return "That provider isn't on this card.";
    const now = new Set(r.hiddenSections ?? []);
    if (hidden) now.add(section);
    else now.delete(section);
    if ([...sections].every((x) => now.has(x))) return "Keep at least one provider on the card.";
    const shown = (m: DesignModelChoice) => !now.has(designSectionOf(m.ref).id);
    const models = r.setup.models.map((m) => ({ ...m, ...(shown(m) ? {} : { design: false }) }));
    if (!briefOpen && !models.some((m) => m.coordinator && shown(m))) {
      const seat = models.find((m) => m.design && shown(m)) ?? models.find(shown);
      for (const m of models) m.coordinator = m === seat;
    }
    const inSection = (name: string) => designSectionOfWord(name) === section || designSectionOf(rowFor(r.setup.models, name)?.ref ?? "").id === section;
    const { links: _links, ...card } = r.setup;
    return { setup: { ...card, models }, run: { hiddenSections: [...now], ...(hidden ? {} : { hiddenAsked: (r.hiddenAsked ?? []).filter((n) => !inSection(n)) }) } };
  });
  rememberHidden(section, hidden);
  return run;
}

// ---- the main chat's edit ------------------------------------------------------------------------

/** What the main chat changes on an open card: only what the user asked to change. Lists add or remove. */
export interface SetupDelta {
  brief?: string;
  models?: string[];
  removeModels?: string[];
  modelGroups?: string[];
  removeModelGroups?: string[];
  /** A thinking level per model, by its name or provider/id; "all" names every ticked designer. */
  efforts?: Record<string, string>;
  coordinator?: string;
  directions?: string[];
  removeDirections?: string[];
  layouts?: string[];
  removeLayouts?: string[];
  combine?: "pair" | "every";
  /** Images to take off this run, by name (they stay in the chat's images). */
  removeImages?: string[];
  removeSkills?: string[];
}

/** What a delta brings that had to be fetched first: images already added to the chat, skills already found. */
export interface DeltaFetched {
  addedImages?: string[];
  /** The names of the run's own images now (runOwnImage over the chat's images). */
  ownImages?: readonly string[];
  skills?: { skills: DesignSkill[]; missing: DesignSkillMissing[] };
}

const lower = (s: string) => s.trim().toLowerCase();
const providerOf = (ref: string) => ref.slice(0, ref.indexOf("/")).toLowerCase();

/** The card's row a name means: provider/id exactly, else a bare id (a ticked row first, then the chat's provider, then the first). */
function rowFor(rows: readonly DesignModelChoice[], name: string, chatModel?: string): DesignModelChoice | undefined {
  const want = lower(name);
  const exact = rows.find((m) => m.ref.toLowerCase() === want);
  if (exact || want.includes("/")) return exact;
  const same = rows.filter((m) => m.name.toLowerCase() === want);
  const chat = chatModel?.includes("/") ? providerOf(chatModel) : null;
  return same.find((m) => m.design) ?? same.find((m) => providerOf(m.ref) === chat) ?? same[0];
}

/**
 * The whole card a delta makes of `run`, with what couldn't be applied and why. Only rows the card offers; a hidden
 * section's rows are refused with its name; the brief's words, images, skills and the Creative Director only before
 * Start Creative Director (after it, those go to the Creative Director with tell).
 */
export function applySetupDelta(run: DesignRun, delta: SetupDelta, briefOpen: boolean, fetched: DeltaFetched = {}, chatModel?: string): { change: SetupChange; notes: string[] } {
  const notes: string[] = [];
  const hidden = run.hiddenSections ?? [];
  const models = run.setup.models.map((m) => ({ ...m }));
  const isHidden = (m: DesignModelChoice) => hidden.includes(designSectionOf(m.ref).id);
  const hiddenNote = (name: string, m: DesignModelChoice) => `${name}: ${designSectionOf(m.ref).name} is hidden on this card; the user can bring it back with Show under the models.`;
  const missingModel = (name: string) => {
    const left = (run.leftOut ?? []).find((l) => l.section === designSectionOfWord(name) || (l.models ?? []).some((x) => lower(x) === lower(name)));
    return `${name}: ${left ? `${left.name} isn't on this card (${leftOutWords(left.why)})` : "there's no such model on this card"}.`;
  };
  const tick = (name: string, on: boolean) => {
    const m = rowFor(models, name, chatModel);
    if (!m) return void notes.push(missingModel(name));
    if (on && isHidden(m)) return void notes.push(hiddenNote(name, m));
    m.design = on;
  };
  for (const n of delta.models ?? []) tick(n, true);
  for (const n of delta.removeModels ?? []) tick(n, false);
  const group = (word: string, on: boolean) => {
    const rows = models.filter((m) => designInGroup(m.ref, word));
    if (!rows.length) return void notes.push(missingModel(word));
    const shown = rows.filter((m) => !on || !isHidden(m));
    if (!shown.length) return void notes.push(hiddenNote(word, rows[0]!));
    for (const m of shown) m.design = on;
  };
  for (const g of delta.modelGroups ?? []) group(g, true);
  for (const g of delta.removeModelGroups ?? []) group(g, false);
  for (const [name, level] of Object.entries(delta.efforts ?? {})) {
    const rows = lower(name) === "all" ? models.filter((m) => m.design && designHasEfforts(m)) : [rowFor(models, name, chatModel)].filter((m): m is DesignModelChoice => !!m);
    if (!rows.length) {
      notes.push(lower(name) === "all" ? "effort: no ticked designer takes an effort." : missingModel(name));
      continue;
    }
    for (const m of rows) {
      const problem = effortProblem(m, lower(level));
      if (problem) notes.push(problem);
      else m.effort = lower(level);
    }
  }
  if (delta.coordinator !== undefined) {
    const m = rowFor(models, delta.coordinator, chatModel);
    if (briefOpen) notes.push("The Creative Director is already at work, so it can't change now.");
    else if (!m) notes.push(missingModel(delta.coordinator));
    else if (isHidden(m)) notes.push(hiddenNote(delta.coordinator, m));
    else for (const x of models) x.coordinator = x === m;
  }
  const ticks = (list: readonly { name: string; on: boolean }[] | undefined, add: readonly string[] = [], remove: readonly string[] = [], what: string) => {
    const out = (list ?? []).map((d) => ({ ...d }));
    for (const [names, on] of [[add, true], [remove, false]] as const) {
      for (const n of names) {
        const d = out.find((x) => lower(x.name) === lower(n));
        if (d) d.on = on;
        else notes.push(`${n}: there's no ${what} by that name on this card.`);
      }
    }
    return out;
  };
  const directions = ticks(run.setup.directions, delta.directions, delta.removeDirections, "style");
  const layouts = run.setup.layouts ? ticks(run.setup.layouts, delta.layouts, delta.removeLayouts, "layout") : undefined;
  if (!run.setup.layouts && (delta.layouts?.length || delta.removeLayouts?.length)) notes.push("This card has no layouts.");
  const combine = delta.combine ?? run.setup.combine;
  let brief = run.setup.brief;
  if (delta.brief !== undefined) {
    if (briefOpen) notes.push("The request's words go to the Creative Director now: pass them on with op tell.");
    else brief = delta.brief.trim();
  }
  const runFields: SetupChange["run"] = {};
  // Images: added only before Start Creative Director (the caller adds them to the chat first); taken off by name.
  if (fetched.addedImages?.length) {
    runFields.images = [...new Set([...(run.images ?? []), ...fetched.addedImages])];
    runFields.imagesLeftOut = (run.imagesLeftOut ?? []).filter((n) => !fetched.addedImages!.includes(n));
  }
  if (delta.removeImages?.length) {
    if (briefOpen) notes.push("Images go to the Creative Director now: ask it with op tell to leave one out.");
    else {
      const own = new Set(fetched.ownImages ?? []);
      const out = new Set(runFields.imagesLeftOut ?? run.imagesLeftOut ?? []);
      for (const n of delta.removeImages) {
        if (own.has(n) || (runFields.images ?? run.images ?? []).includes(n)) out.add(n);
        else notes.push(`${n}: there's no image by that name on this run.`);
      }
      runFields.imagesLeftOut = [...out];
      runFields.images = (runFields.images ?? run.images ?? []).filter((n) => !out.has(n));
    }
  }
  // Skills: only before Start Creative Director; after, the Creative Director reads them and is told.
  if (fetched.skills || delta.removeSkills?.length) {
    if (briefOpen) notes.push("Skills go to the Creative Director now: pass the change on with op tell.");
    else {
      let skills = [...(run.skills ?? [])];
      let missing = [...(run.skillsMissing ?? [])];
      for (const k of fetched.skills?.skills ?? []) {
        if (skills.some((x) => x.dir === k.dir || lower(x.name) === lower(k.name))) continue;
        if (skills.length >= SKILL_LIMITS.perRun) {
          notes.push(`${k.name}: a Lookbook takes at most ${SKILL_LIMITS.perRun} skills.`);
          continue;
        }
        skills.push(k);
      }
      for (const m of fetched.skills?.missing ?? []) {
        notes.push(`${m.asked}: ${m.reason}`);
        if (!missing.some((x) => x.asked === m.asked)) missing.push(m);
      }
      for (const n of delta.removeSkills ?? []) {
        const had = skills.length + missing.length;
        skills = skills.filter((k) => lower(k.name) !== lower(n));
        missing = missing.filter((k) => lower(k.asked) !== lower(n));
        if (skills.length + missing.length === had) notes.push(`${n}: there's no skill by that name on this card.`);
      }
      runFields.skills = skills;
      runFields.skillsMissing = missing;
    }
  }
  // Links are re-read from the words by cleanSetup, keeping each one's use: none is sent as a fresh choice.
  const { links: _links, ...card } = run.setup;
  const setup: DesignSetup = { ...card, brief, models, directions, ...(layouts ? { layouts } : {}), ...(combine ? { combine } : {}) };
  return { change: { setup, run: runFields }, notes };
}

/** Why a provider was left off a card, in a few words. */
export function leftOutWords(why: NonNullable<DesignRun["leftOut"]>[number]["why"]): string {
  switch (why) {
    case "signed-out": return "its sign-in has run out";
    case "bad-key": return "its key was refused";
    case "no-key": return "it has no key";
    case "not-running": return "it isn't running";
    case "not-downloaded": return "that model isn't downloaded";
  }
}

// ---- what the card holds, in words ---------------------------------------------------------------

const EFFORT_WORDS: Record<string, string> = { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "extra high", max: "max" };

/** The names of a run's own images now. */
export const runImageNames = (sessionId: string, run: DesignRun): string[] => readAssets(sessionId).assets.filter((a) => runOwnImage(a, run)).map((a) => a.name);

/** What an open Setup card holds, for the main chat: only what is ticked, counts and names. */
export function setupSummary(sessionId: string, run: DesignRun): string {
  const s = run.setup;
  const designers = s.models.filter((m) => m.design).map((m) => {
    const level = m.efforts === undefined ? (m.effort ?? "low") : designEffortOf(m);
    return `${m.ref}${level ? ` · ${EFFORT_WORDS[level] ?? level}` : ""}`;
  });
  const cd = s.models.find((m) => m.coordinator);
  const styles = s.directions.filter((d) => d.on).map((d) => d.name);
  const layouts = (s.layouts ?? []).filter((d) => d.on).map((d) => d.name);
  const images = runImageNames(sessionId, run);
  const n = designPlan(s).items.length;
  const phase = run.phase === "setup" ? "waiting for Start Creative Director" : run.phase === "brief" ? "the brief is on the card, waiting for Start" : "the Creative Director is writing the brief";
  const lines = [
    `The Setup card (run ${run.id}, ${phase}) holds:`,
    `Designers (${designers.length}): ${designers.join(", ") || "none ticked"}.`,
    `Creative Director: ${cd?.ref ?? "none"}.`,
    `Styles (${styles.length}): ${styles.join(", ") || "none"}.`,
    `Layouts: ${layouts.length ? layouts.join(", ") : "Designer's Choice"}${layouts.length ? `, ${s.combine === "every" ? "Every Mix" : "Pair Up"}` : ""}.`,
    `Designs: ${n}.`,
    `Images (${images.length}): ${images.join(", ") || "none"}.`,
    ...(run.skills?.length || run.skillsMissing?.length ? [`Skills: ${[...(run.skills ?? []).map((k) => k.name), ...(run.skillsMissing ?? []).map((m) => `${m.asked} (not found)`)].join(", ")}.`] : []),
    `Request: ${s.brief ? `${s.brief.length > 160 ? `${s.brief.slice(0, 159)}…` : s.brief}` : "(empty)"}`,
    ...(run.brief?.estimateUsd !== undefined && run.phase === "brief" ? [`Estimated cost: $${run.brief.estimateUsd.toFixed(2)}.`] : []),
  ];
  return lines.join("\n");
}

// ---- the main chat's edit, whole -----------------------------------------------------------------

/** The run a chat's edit means: the one named, else the chat's newest run while its Setup is open. */
export function editableRun(sessionId: string, runId: string | undefined, runs: readonly DesignRun[]): DesignRun {
  const run = runId ? runs.find((r) => r.id === runId) : runs.at(-1);
  if (!run) throw new SetupRefused(runId ? `There's no Lookbook run ${runId} in this chat.` : "This chat has no Lookbook Setup card to change: put one up with op start.", 404);
  if (!setupOpen(run)) throw new SetupRefused(`Run ${run.id} has started its designs, so its Setup can't change any more. Ask the Creative Director with op tell, or start a new Lookbook only if the user asks for one.`, 409);
  return run;
}

/** What the chat's edit reports: the card's summary, then each thing that couldn't be applied. */
export interface EditOutcome {
  run: DesignRun;
  text: string;
}

export interface EditDeps {
  /** Add images named by path to the chat's set: their names, and refusals in words. */
  addImages(paths: readonly string[]): Promise<{ names: string[]; refused: string[] }>;
  findSkills(names: readonly string[]): Promise<{ skills: DesignSkill[]; missing: DesignSkillMissing[] }>;
  runs(): readonly DesignRun[];
  chatModel?: string;
}

/** The main chat's edit of an open card, whole: images and skills fetched first, then one change through commitSetup. */
export async function editSetup(sessionId: string, runId: string | undefined, delta: SetupDelta & { images?: string[]; skills?: string[] }, deps: EditDeps): Promise<EditOutcome> {
  const before = editableRun(sessionId, runId, deps.runs());
  const briefOpen = before.phase !== "setup";
  const early: string[] = [];
  const fetched: DeltaFetched = { ownImages: runImageNames(sessionId, before) };
  if (delta.images?.length) {
    if (briefOpen) early.push("Images go to the Creative Director now: pass them with op tell.");
    else {
      const got = await deps.addImages(delta.images);
      fetched.addedImages = got.names;
      early.push(...got.refused);
    }
  }
  if (delta.skills?.length && !briefOpen) fetched.skills = await deps.findSkills(delta.skills);
  else if (delta.skills?.length) early.push("Skills go to the Creative Director now: pass the change on with op tell.");
  let notes: string[] = [];
  const run = commitSetup(sessionId, before.id, (r, open) => {
    // The images are read again here: one added since the fetch is the run's too.
    const out = applySetupDelta(r, delta, open, { ...fetched, ownImages: runImageNames(sessionId, r) }, deps.chatModel);
    notes = out.notes;
    return out.change;
  });
  const all = [...early, ...notes];
  return { run, text: [setupSummary(sessionId, run), all.length ? `Not changed:\n${all.map((n) => `- ${n}`).join("\n")}` : ""].filter(Boolean).join("\n\n") };
}
