/**
 * The copy limit and the port numbering in force for a project (§app.project-services/instances):
 * both come from the main checkout's `.sova/project.json` as saved in its folder (uncommitted edits
 * included, never HEAD), whichever checkout a copy is of, and for conformance too. Every reader of
 * the limit goes through `slotLimitOf`: create's search, its "slot is at most" check, conformance's
 * scratch slots and the Project verbs playbook's port audit. Erasable syntax and explicit `.ts`
 * imports only: the playbook imports this file with Node's type stripping.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_FILE, parseDefinition, portFor, type PortDecl, type ProjectDef } from "./project-contract.ts";

const CAP_DEFAULT = 4;

/** The limit in force, where it came from, and the slots it implies. */
export interface SlotLimit {
  /** How many copies Sova runs for the project besides the main checkout's (conformance's not counted). */
  cap: number;
  /** Where the cap was read, in words: the main checkout's file, or the definition in use. */
  from: string;
  /** Conformance's two scratch slots: cap + 1 and cap + 2. No other copy takes them. */
  scratch: [number, number];
  /** The highest slot any copy may take: 2 × cap + 2 (so the search can pass the cap by a cap's worth). */
  top: number;
  /** The slots an ordinary copy is searched over, lowest first: 1 to top, the scratch slots skipped. */
  ordinary: number[];
  /** The definition whose ports number every copy's (the main checkout's), or null: each copy's own. */
  numbering: Pick<ProjectDef, "services"> | null;
}

/** The slots a cap implies (pure). */
export function slotPlan(cap: number): Pick<SlotLimit, "cap" | "scratch" | "top" | "ordinary"> {
  const scratch: [number, number] = [cap + 1, cap + 2];
  const top = 2 * cap + 2;
  const ordinary: number[] = [];
  for (let s = 1; s <= top; s++) if (s !== scratch[0] && s !== scratch[1]) ordinary.push(s);
  return { cap, scratch, top, ordinary };
}

/**
 * The limit in force for the project whose main checkout is `main`: its saved file's `slots.cap`
 * and ports. With that file missing or invalid, `inUse` (the definition the verb runs from) gives
 * both, else the default cap. `read` is the file reader (tests fake it).
 */
export function slotLimitOf(main: string, inUse?: Pick<ProjectDef, "slots" | "services"> | null, read: (file: string) => string = (f) => readFileSync(f, "utf8")): SlotLimit {
  const file = join(main, CONTRACT_FILE);
  let def: ProjectDef | null = null;
  let why = "";
  try {
    def = parseDefinition(read(file));
  } catch (err) {
    why = (err as { code?: string }).code === "ENOENT" ? "missing" : "invalid";
  }
  if (def) return { ...slotPlan(def.slots.cap), from: `the main checkout's ${CONTRACT_FILE} (${file}, as saved)`, numbering: def };
  if (inUse) return { ...slotPlan(inUse.slots.cap), from: `the definition in use (the main checkout's ${CONTRACT_FILE} is ${why})`, numbering: null };
  return { ...slotPlan(CAP_DEFAULT), from: `the default (the main checkout's ${CONTRACT_FILE} is ${why})`, numbering: null };
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
