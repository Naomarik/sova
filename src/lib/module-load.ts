// A view's code file that can't be loaded (§chat.transcript-cards/toolkit), told apart where it is
// loaded, never by its words: each browser says it its own way ("Failed to fetch dynamically imported
// module", "error loading dynamically imported module", "Importing a module script failed"). After a
// rebuild the page's older build names a file the server no longer has; the browser keeps a failed
// import for the page's life, so only loading the page again draws it. No Solid, no DOM.

/** A code file that couldn't be loaded; its message is the browser's own, its cause the browser's error. */
export class ModuleLoadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ModuleLoadError";
  }
}

/** Whether a failure is a code file that couldn't be loaded. */
export const isModuleLoadError = (err: unknown): err is ModuleLoadError => err instanceof ModuleLoadError;

/** A module's loader whose failure says it is one (ModuleLoadError). */
export const loadsModule =
  <T>(load: () => Promise<T>): (() => Promise<T>) =>
  () =>
    load().catch((err: unknown) => {
      throw new ModuleLoadError(err);
    });
