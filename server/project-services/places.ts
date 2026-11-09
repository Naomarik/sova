import { adoptedService, COPY_SLOT_TOP, type ProjectDef } from "../../shared/project-contract";
import { checkoutPortsAt, slotLayoutOf, type SlotLayout } from "../../shared/project-slots";
import { countsAsRunning } from "./copy-limit";
import { slotStanding, type InstanceRecord, type SlotRegistry } from "./store";

/**
 * A project's usable places, each by what stands on it (§app.projects/home-glance): the project cards' Copies and the
 * Branches tab's line, by the rule a new copy's start uses (`slotStanding`).
 */

export type PlaceState = "running" | "stopped" | "elsewhere" | "free" | "unchecked";

export interface PlaceCounts {
  usable: number;
  running: number;
  stopped: number;
  elsewhere: number;
  /** null: not every place could be checked, so how many are free is unknown. */
  free: number | null;
}

type Defn = Pick<ProjectDef, "services">;

/** The slots that are places under `layout`; every slot of 1 to 16 when there's no valid definition to lay out. */
export const placeSlots = (layout: Pick<SlotLayout, "ordinary"> | null): number[] => layout?.ordinary ?? Array.from({ length: COPY_SLOT_TOP }, (_, i) => i + 1);

export interface PlacesInput {
  registry: {
    instances: readonly (SlotRegistry["instances"][number] & Pick<InstanceRecord, "createdBy" | "desired">)[];
    shared: SlotRegistry["shared"];
  };
  project: string;
  /** Whether a record's project path is this project, whatever its spelling. */
  isProject(path: string): boolean;
  /** The main checkout's definition; null: invalid, so no slot's ports are known. */
  def: Defn | null;
  numbering: Defn | null;
  /** The ports with a listener, from one look; null: the host has no such list. */
  listening: ReadonlySet<number> | null;
}

/** Whether a place nothing is known to hold can be called free: its ports are known and so are the host's listeners. */
const placesChecked = (x: Pick<PlacesInput, "def" | "listening">): boolean => x.def !== null && x.listening !== null;

/** Each usable place of the project and what stands on it. Pure. */
export function placeStates(x: PlacesInput): { slot: number; state: PlaceState }[] {
  const own = (p: string) => (x.isProject(p) ? x.project : p);
  const registry: SlotRegistry = {
    instances: x.registry.instances.map((i) => ({ ...i, project: own(i.project) })),
    shared: x.registry.shared.map((s) => ({ ...s, project: own(s.project) })),
  };
  const adopted = x.def ? adoptedService(x.def) : null;
  const adoptedPorts = new Set(adopted ? Object.values(adopted.adopt!.ports) : []);
  const listening = (p: number): boolean => adoptedPorts.has(p) || (x.listening?.has(p) ?? false);
  const checked = placesChecked(x);
  return placeSlots(x.def ? slotLayoutOf(x.def, x.numbering) : null).map((slot) => {
    const standing = slotStanding(registry, x.project, slot, x.def ? checkoutPortsAt(x.def, x.numbering, slot) : [], listening);
    if (standing.state === "free") return { slot, state: checked ? "free" : "unchecked" };
    if (standing.state === "elsewhere") return { slot, state: "elsewhere" };
    // A record that is no copy (conformance's) is still not a place a copy can take.
    const copy = x.registry.instances.find((i) => i.slot === slot && x.isProject(i.project) && !i.createdBy.startsWith("conform:"));
    return { slot, state: !copy ? "elsewhere" : countsAsRunning(copy) ? "running" : "stopped" };
  });
}

/** How many places stand each way. Whether `free` is known depends on what could be checked, never on how the places happen to fall. */
export function countPlaces(x: PlacesInput): PlaceCounts {
  const places = placeStates(x);
  const n = (s: PlaceState) => places.filter((p) => p.state === s).length;
  return { usable: places.length, running: n("running"), stopped: n("stopped"), elsewhere: n("elsewhere"), free: placesChecked(x) ? n("free") : null };
}
