// A pi worker's spec census while Sova runs chat modes: the loader's in-place rewrite (modes.ts
// modesEntryFor) answers mode/spec-worker.ts with this file, in the same slot. The hooks are the
// extension's own (spec-worker.ts: the same census, write guard, landed file and hand-over), so a worker
// sees exactly what it did; the file moves into Sova when the extension is retired.
export { default } from "../../../pi-config/extensions/mode/spec-worker.ts";
