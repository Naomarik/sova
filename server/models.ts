import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelInfo } from "../shared/protocol";
import { getModelRuntime } from "./chat-manager";

/** The command-palette extension's favorites (READ-ONLY here): {version:1, models:[{provider,id}]}. */
const FAVORITES_FILE = join(getAgentDir(), "model-favorites.json");

function readFavorites(): Set<string> {
  try {
    const data = JSON.parse(readFileSync(FAVORITES_FILE, "utf8"));
    if (data?.version !== 1 || !Array.isArray(data.models)) return new Set();
    return new Set(
      data.models
        .filter((m: any) => typeof m?.provider === "string" && typeof m?.id === "string")
        .map((m: any) => `${m.provider}/${m.id}`),
    );
  } catch {
    return new Set(); // missing or corrupt: no favorites
  }
}

/** Models with configured auth (what the palette lists without a scoped-model setting). */
export async function listModels(): Promise<ModelInfo[]> {
  const favorites = readFavorites();
  const models = await (await getModelRuntime()).getAvailable();
  return models.map((m) => {
    const ref = `${m.provider}/${m.id}`;
    return { ref, provider: m.provider, id: m.id, favorite: favorites.has(ref) };
  });
}
