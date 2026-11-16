// Naming a design's versions, for anything that reads or looks at a page on a model's behalf (the main chat's lookbook
// read, the Creative Director's design_browse and design_status): "A" is its latest version, "A11" version 11, several
// separated by commas or spaces. Each page read starts with a header saying which version it is, of how many, when it
// was made, which versions exist, and whether a newer one is being written. Pure: it reads only the records it is given.
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
    if (!v) throw new Error(`Design ${d.label} has no version ${n}. Its versions: ${versionsLine(d.versions)}.`);
    return { d, v, last };
  });
}

/** A design's versions as ranges: "1–16", or "1–3, 5" where one is missing. */
export function versionsLine(versions: readonly Pick<DesignVersion, "n">[]): string {
  const ns = [...versions.map((v) => v.n)].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < ns.length; i++) {
    let j = i;
    while (j + 1 < ns.length && ns[j + 1] === ns[j]! + 1) j++;
    runs.push(j > i ? `${ns[i]}\u2013${ns[j]}` : `${ns[i]}`);
    i = j;
  }
  return runs.join(", ");
}

/** The header a page read starts with: exactly which version it is and which versions exist, and a second line when a
    newer version is being written. */
export function versionHeading({ d, v, last }: PickedVersion): string {
  const head = `Design ${d.label} \u00b7 version ${v.n} of ${last.n}${v.n === last.n ? " (latest)" : ""} \u00b7 made ${versionTime(v.at)} \u00b7 ${d.versions.length === 1 ? "version" : "versions"} ${versionsLine(d.versions)}`;
  const writing = d.live ? `Version ${d.live.version} is being written now; this isn't it.` : d.status === "writing" || d.status === "fixing" ? "A newer version is being written now; this isn't it." : "";
  return writing ? `${head}\n${writing}` : head;
}

/** A design's version count, for an overview line: "16 versions", "1 version", "no version yet". */
export const versionCount = (d: Pick<DesignRecord, "versions">): string => (d.versions.length ? `${d.versions.length} version${d.versions.length === 1 ? "" : "s"}` : "no version yet");

/** Kilobytes, to one decimal: "14.1 KB". */
export const kb = (bytes: number): string => `${(bytes / 1024).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KB`;

/** A page's size, for a read that hands over its file instead of its text: "14.1 KB · 14,393 characters, 312 lines". */
export function pageSize(text: string): string {
  const lines = text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
  return `${kb(Buffer.byteLength(text, "utf8"))} \u00b7 ${text.length.toLocaleString("en-US")} characters, ${lines.toLocaleString("en-US")} line${lines === 1 ? "" : "s"}`;
}
