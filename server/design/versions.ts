// Naming a design's versions, for anything that reads or looks at a page on a model's behalf (the main chat's lookbook
// read, the Creative Director's design_browse and design_status): "A" is its latest version, "A11" version 11, several
// separated by commas or spaces. Each page read comes under one line saying which version it is, of how many, when it
// was made, and whether a newer one is being written. Pure: it reads only the records it is given.
import { isDesignLabel, type DesignRecord, type DesignVersion } from "../../shared/design";

export interface PickedVersion {
  d: DesignRecord;
  v: DesignVersion;
  last: DesignVersion;
}

const NAME = /^([A-Z]{1,4})(\d+)?$/;

/** A version's time as a person reads it: "2026-11-16 10:03 UTC". */
export const versionTime = (iso: string): string => iso.replace("T", " ").replace(/:\d\d(\.\d+)?Z$/, " UTC");

/** The pages `asked` names, in the order named, each once. Throws, naming what there is, for a name that isn't a design,
    a design with no finished page, or a version it doesn't have: then nothing is read. `version` stands in for a number
    on a bare label (the Creative Director's older form, label "A" with version 11). */
export function pickVersions(designs: readonly DesignRecord[], asked: string, version?: number): PickedVersion[] {
  const names = [...new Set(asked.split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean))];
  if (!names.length) throw new Error("label names no design: give a label such as A, or A11 for its version 11.");
  const labels = designs.map((d) => d.label).join(", ") || "none yet";
  return names.map((name) => {
    const m = NAME.exec(name);
    const d = m && isDesignLabel(m[1]) ? designs.find((x) => x.label === m[1]) : undefined;
    if (!m || !d) throw new Error(`No design ${name} in this chat. Its designs: ${labels}.`);
    const last = d.versions.at(-1);
    if (!last) throw new Error(`Design ${d.label} has no finished page yet.`);
    const n = m[2] !== undefined ? Number(m[2]) : (version ?? last.n);
    const v = d.versions.find((x) => x.n === n);
    if (!v) throw new Error(`Design ${d.label} has no version ${n}: it has ${d.versions.length === 1 ? `version ${last.n}` : `versions ${d.versions[0]!.n} to ${last.n}`}.`);
    return { d, v, last };
  });
}

/** The line a page read comes under, and a second when a newer version is being written. */
export function versionHeading({ d, v, last }: PickedVersion): string {
  const head = `Design ${d.label} · version ${v.n} of ${last.n} · ${v.n === last.n ? "latest" : `not the latest (version ${last.n} is, from ${versionTime(last.at)})`} · ${versionTime(v.at)}`;
  const writing = d.live ? `Version ${d.live.version} is being written now; this isn't it.` : d.status === "writing" || d.status === "fixing" ? "A newer version is being written now; this isn't it." : "";
  return writing ? `${head}\n${writing}` : head;
}
