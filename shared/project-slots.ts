/**
 * Slots, port numbering and the copy limit in force for a project (§app.project-services/instances).
 *
 * - Places: every copy's slot comes from one fixed range, 1 to COPY_SLOT_TOP; conformance's two
 *   scratch slots sit outside it. The limit never moves either (`SLOT_LAYOUT`).
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
import { CONTRACT_FILE, COPY_SLOT_TOP, parseDefinition, portFor, SCRATCH_SLOTS, SLOT_CAP_DEFAULT, SLOT_TOP, type PortDecl, type ProjectDef } from "./project-contract.ts";

/** The fixed places: copies search `ordinary` (1 to 16); conformance alone takes `scratch` (17, 18); `top` is the highest of all. */
export const SLOT_LAYOUT: { ordinary: readonly number[]; scratch: readonly [number, number]; top: number } = {
  ordinary: Array.from({ length: COPY_SLOT_TOP }, (_, i) => i + 1),
  scratch: SCRATCH_SLOTS,
  top: SLOT_TOP,
};

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

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const word = (n: number) => WORDS[n] ?? String(n);

/**
 * The sentence a start or create meets when `running` copies already run and the limit is `cap`
 * (§app.project-services/instances), or null: there is room. At the limit: "{n} copies are running, and
 * this machine allows {cap} at once: stop one first."; above it: "{n} running, {k} over the limit: no new
 * copy starts until {k + 1} stop." Pure: the Branches tab shows the second one too.
 */
export function overLimitSentence(running: number, cap: number): string | null {
  if (running < cap) return null;
  if (running === cap) return `${running} cop${running === 1 ? "y is" : "ies are"} running, and this machine allows ${cap} at once: stop one first.`;
  const over = running - cap;
  const need = over + 1;
  return `${running} running, ${over} over the limit: no new copy starts until ${word(need)} stop${need === 1 ? "s" : ""}.`;
}
