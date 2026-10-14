// Overseers run with memory on by default; a test whose overseer turns would build
// summaries (a summarizer call: a process the unit tier refuses) or pins what the model saw before turns it off.
import { readOverseerSettings, writeOverseerSettings } from "../overseer-store";
import { projectOverseerPaths, readPoSettings, writePoSettings } from "../project-overseer-store";

const OFF = { on: false, type: "uniichat" as const, size: 128 };

/** The Overseer's own switch, off (overseer.json under the state root). */
export function overseerMemoryOff(): void {
  writeOverseerSettings({ ...readOverseerSettings(), memory: { ...OFF } });
}

/** A project overseer's own switch, off (its overseer.json in the engine that holds the project). */
export function projectOverseerMemoryOff(projectId: string): void {
  const p = projectOverseerPaths(projectId);
  writePoSettings(p, { ...readPoSettings(p), memory: { ...OFF } });
}
