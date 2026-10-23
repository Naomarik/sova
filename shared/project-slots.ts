/**
 * Slots, port numbering and the copy limit in force for a project (§app.project-services/instances).
 *
 * - Places: every copy's slot comes from one fixed range, 1 to COPY_SLOT_TOP; conformance's two
 *   scratch slots sit above it. Which of them a definition can use is its own layout (`slotLayoutOf`):
 *   a slot whose ports overlap another place's is skipped. The limit never moves either.
 * - Numbering: each port's `base`/`stride`/`fixed` is the main checkout's saved file's
 *   (`numberedPorts`, `copyLimitOf().numbering`).
 * - The limit: how many copies may run at once. `copyLimitOf` is the one rule that gives it: this
 *   machine's own value (passed in by the server, which keeps it in its state) ?? the main checkout's
 *   saved file ?? the definition in use ?? the default. Every reader goes through it; the machine
 *   value is never merged into a definition or its hash.
 *
 * Erasable syntax and explicit `.ts` imports only: the playbook imports this file with Node's type stripping.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_FILE, COPY_SLOT_TOP, parseDefinition, portFor, SCRATCH_FROM, SLOT_CAP_DEFAULT, type PortDecl, type ProjectDef } from "./project-contract.ts";

/** A definition's places (§app.project-services/instances). */
export interface SlotLayout {
  /** The usable slots of 1 to COPY_SLOT_TOP, lowest first: the ones a copy may take. */
  ordinary: number[];
  /** The slots of 1 to COPY_SLOT_TOP no copy takes, each with why ("its ports overlap slot 10's"). */
  unavailable: { slot: number; why: string }[];
  /** Conformance's two scratch slots: the two lowest from SCRATCH_FROM whose ports meet no other place's. */
  scratch: [number, number];
  /** Set when no two such slots exist within 65535: the scratch slots are then 17 and 18, and this says so. */
  scratchNote: string | null;
}

/** How far above SCRATCH_FROM the scratch search looks before it falls back. */
const SCRATCH_SEARCH = 200;

/**
 * The places `def` can use, its ports numbered by `numbering` as every copy's are (§app.project-services/instances):
 * a slot of 1 to 16 is usable when each of its ports is at most 65535 and none meets a port of slot 0 or of a lower
 * usable slot; the scratch slots are the two lowest from 17 up that meet none of those nor each other. Ports declared
 * `fixed` are the same in every slot by design and never count. Pure.
 */
export function slotLayoutOf(def: Pick<ProjectDef, "services">, numbering: Pick<ProjectDef, "services"> | null): SlotLayout {
  const own = def.services.filter((x) => x.scope === "checkout");
  const portsAt = (slot: number): number[] => {
    const all = numberedPorts({ services: own }, numbering, slot);
    const out: number[] = [];
    for (const svc of own)
      for (const [k, p] of Object.entries(svc.ports)) {
        const decl: PortDecl = numbering?.services.find((x) => x.name === svc.name)?.ports[k] ?? p;
        if (!(slot === 0 && svc.adopt) && "fixed" in decl) continue;
        out.push(all[svc.name]![k]!);
      }
    return out;
  };
  const taken = new Map<number, number>();
  for (const p of portsAt(0)) taken.set(p, 0);
  const problem = (slot: number): string | null => {
    const ports = portsAt(slot);
    for (const [i, p] of ports.entries()) {
      if (p > 65535) return `its port ${p} is past 65535`;
      if (ports.indexOf(p) !== i) return `two of its ports are both ${p}`;
      const other = taken.get(p);
      if (other !== undefined) return `its ports overlap slot ${other}'s`;
    }
    return null;
  };
  const claim = (slot: number) => {
    for (const p of portsAt(slot)) taken.set(p, slot);
  };
  const ordinary: number[] = [];
  const unavailable: SlotLayout["unavailable"] = [];
  for (let slot = 1; slot <= COPY_SLOT_TOP; slot++) {
    const why = problem(slot);
    if (why) unavailable.push({ slot, why });
    else {
      ordinary.push(slot);
      claim(slot);
    }
  }
  const found: number[] = [];
  for (let slot = SCRATCH_FROM; found.length < 2 && slot < SCRATCH_FROM + SCRATCH_SEARCH; slot++) {
    if (portsAt(slot).some((p) => p > 65535)) break;
    if (problem(slot)) continue;
    found.push(slot);
    claim(slot);
  }
  if (found.length === 2) return { ordinary, unavailable, scratch: [found[0]!, found[1]!], scratchNote: null };
  return {
    ordinary,
    unavailable,
    scratch: [SCRATCH_FROM, SCRATCH_FROM + 1],
    scratchNote: `no two slots from ${SCRATCH_FROM} up have ports clear of the other places within 65535, so conformance uses ${SCRATCH_FROM} and ${SCRATCH_FROM + 1}, whose ports overlap other places'`,
  };
}

/** "Slot 14 is unavailable: its ports overlap slot 10's." */
export const unavailableSentence = (u: { slot: number; why: string }): string => `Slot ${u.slot} is unavailable: ${u.why}.`;

/** Where the limit in force comes from. */
export type CopyLimitSource = "machine" | "file" | "in-use" | "default";

/** The copy limit in force, where it came from, and the numbering every copy's ports follow. */
export interface CopyLimit {
  /** How many of the project's copies may run at once (the main checkout's and conformance's not counted). */
  cap: number;
  source: CopyLimitSource;
  /** Where it came from, in words. */
  from: string;
  /** The main checkout's saved file's own value (its default when it sets none), or null: that file is missing or invalid. */
  fileCap: number | null;
  /** The definition whose ports number every copy's (the main checkout's), or null: each copy's own. */
  numbering: Pick<ProjectDef, "services"> | null;
}

/**
 * The limit in force for the project whose main checkout is `main` (§app.project-services/instances):
 * `machine` (this machine's own value, from Sova's state) when set; else the main checkout's saved
 * file; else `inUse` (the definition the verb runs from) when that file is missing or invalid; else the
 * default. `read` is the file reader (tests fake it).
 */
export function copyLimitOf(
  main: string,
  opts: { inUse?: Pick<ProjectDef, "slots" | "services"> | null; machine?: number | null; read?: (file: string) => string } = {},
): CopyLimit {
  const file = join(main, CONTRACT_FILE);
  const read = opts.read ?? ((f: string) => readFileSync(f, "utf8"));
  let def: ProjectDef | null = null;
  let why = "";
  try {
    def = parseDefinition(read(file));
  } catch (err) {
    why = (err as { code?: string }).code === "ENOENT" ? "missing" : "invalid";
  }
  const fileCap = def ? def.slots.cap : null;
  const numbering = def;
  if (typeof opts.machine === "number") return { cap: opts.machine, source: "machine", from: "set on this machine", fileCap, numbering };
  if (def) return { cap: def.slots.cap, source: "file", from: `from the project's file (the main checkout's ${CONTRACT_FILE}, as saved)`, fileCap, numbering };
  if (opts.inUse) return { cap: opts.inUse.slots.cap, source: "in-use", from: `from the definition in use (the main checkout's ${CONTRACT_FILE} is ${why})`, fileCap, numbering: null };
  return { cap: SLOT_CAP_DEFAULT, source: "default", from: `the default (the main checkout's ${CONTRACT_FILE} is ${why})`, fileCap, numbering: null };
}

/**
 * Every port of `def` in `slot`, numbered by `numbering` where it declares the same service's same
 * port, else by `def`'s own (§app.project-services/instances). Slot 0's adopted ports stay the unit's.
 */
export function numberedPorts(def: Pick<ProjectDef, "services">, numbering: Pick<ProjectDef, "services"> | null, slot: number): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const s of def.services) {
    out[s.name] = {};
    const theirs = numbering?.services.find((x) => x.name === s.name);
    for (const [k, p] of Object.entries(s.ports)) {
      if (slot === 0 && s.adopt) {
        out[s.name]![k] = s.adopt.ports[k]!;
        continue;
      }
      const decl: PortDecl = theirs?.ports[k] ?? p;
      out[s.name]![k] = portFor(decl, slot);
    }
  }
  return out;
}

/**
 * The sentence a start or create meets when `running` copies already run and the limit is `cap`
 * (§app.project-services/instances), or null: there is room. At the limit: "{n} copies are running, and
 * this machine allows {cap} at once: stop one first."; above it: "{n} running, {k} over the limit of {cap}: no new
 * copy starts until {k + 1} stop." (digits, as the design system writes numbers). Pure: the Branches tab shows the second one too.
 */
export function overLimitSentence(running: number, cap: number): string | null {
  if (running < cap) return null;
  if (running === cap) return `${running} cop${running === 1 ? "y is" : "ies are"} running, and this machine allows ${cap} at once: stop one first.`;
  const over = running - cap;
  const need = over + 1;
  return `${running} running, ${over} over the limit of ${cap}: no new copy starts until ${need} stop.`;
}
