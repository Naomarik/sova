import { mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface ModelIdentity { provider: string; id: string }
const key = (model: ModelIdentity) => JSON.stringify([model.provider, model.id]);

/** Global preferences, separate from session history and Pi's model cycling scope. */
export class ModelFavorites {
  private models: Map<string, ModelIdentity>;
  constructor(readonly path: string) { this.models = this.read(); }

  private read(): Map<string, ModelIdentity> {
    let text: string;
    try { text = readFileSync(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw error;
    }
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== "object" || Object.keys(data).length !== 2 ||
      !("version" in data) || data.version !== 1 ||
      !("models" in data) || !Array.isArray(data.models) || !data.models.every(model =>
        model && typeof model === "object" && Object.keys(model).length === 2 &&
        typeof model.provider === "string" && model.provider.length > 0 &&
        typeof model.id === "string" && model.id.length > 0)) {
      throw new Error(`Invalid model favorites file: ${this.path}`);
    }
    return new Map(data.models.map(model => [key(model), { provider: model.provider, id: model.id }]));
  }

  has(model: ModelIdentity): boolean { return this.models.has(key(model)); }

  set(model: ModelIdentity, favorite: boolean): void {
    mkdirSync(dirname(this.path), { recursive: true });
    // Serialize the read/modify/rename across Pi processes. Never silently lose a
    // favorite saved by another pane, or replace malformed data with an empty set.
    const lock = `${this.path}.lock`;
    try { mkdirSync(lock); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Favorites are locked; retry. If no palette is saving, remove ${lock}`);
      }
      throw error;
    }
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const next = this.read();
      if (favorite) next.set(key(model), { provider: model.provider, id: model.id });
      else next.delete(key(model));
      writeFileSync(temp, JSON.stringify({ version: 1, models: [...next.values()] }, null, 2) + "\n",
        { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(temp, this.path);
      this.models = next;
    } finally {
      try { unlinkSync(temp); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      finally { rmdirSync(lock); }
    }
  }
}
