// A pi worker's project mode tools while Sova runs chat modes: the loader's in-place rewrite answers
// mode/project-tools-worker.ts with this file, in the same slot. The same hooks as the extension's file
// (project-tools-worker.ts): the parent's saved copies, the same definitions, on for the worker's life,
// refused while its sandbox is on. One addition: a personal mode's programs are told the worker's checkout
// as their project root (§chat.mode-menu/personal-modes), as the parent chat's are: asked at each call, since these
// register before session_start and until then `cwd` is the process's own folder, Sova's code.
import { SANDBOX_DISCOVER_EVENT, SANDBOX_STATE_EVENT } from "../../../pi-config/extensions/sandbox/state.ts";
import { projectToolDefinitions, PROJECT_TOOLS_FILE_ENV, readWorkerToolsFile } from "../../../pi-config/extensions/mode/project-tools.ts";
import { isPersonalDir, projectRootForDir } from "../../modes/personal";
import type { PiExtensionAPI } from "./extension-types";

export default function projectToolsWorker(pi: PiExtensionAPI): void {
  const file = process.env[PROJECT_TOOLS_FILE_ENV];
  const copies = file ? readWorkerToolsFile(file) : [];
  if (copies.length === 0) return;
  let cwd = process.cwd();
  let sandboxOn = false;
  const names: string[] = [];
  for (const copy of copies) {
    const projectRoot = isPersonalDir(copy.dir) ? { projectRoot: () => projectRootForDir(copy.dir, cwd) } : {};
    for (const definition of projectToolDefinitions(copy, { ...projectRoot, cwd: () => cwd, sandboxOn: () => sandboxOn })) {
      pi.registerTool(definition as never);
      names.push(definition.name);
    }
  }

  pi.events?.on(SANDBOX_STATE_EVENT, (data: unknown) => {
    if ((data as { version?: unknown } | undefined)?.version === 1) sandboxOn = (data as { on?: unknown }).on === true;
  });
  pi.events?.emit(SANDBOX_DISCOVER_EVENT, { version: 1 });

  // Registered with defaultActive false (as in the parent): put them in the loadout once the session exists.
  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    const active = pi.getActiveTools();
    const next = [...active, ...names.filter((name) => !active.includes(name))];
    if (next.length !== active.length) pi.setActiveTools(next);
  });
}
