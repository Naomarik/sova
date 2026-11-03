import type { ModelPick } from "../shared/powers";
import type { ModelInfo } from "../shared/protocol";
import type { AssistantModelProblem, AssistantModelSource } from "../shared/project-assistant";
import { modelDenial, readModelPolicy } from "./model-policy";
import { effectiveAssistantModel } from "./project-assistant-store";

/**
 * Whether the Project Assistant answers (§app.project-assistant/chat, /models): ONE predicate that
 * every reader asks (the owner page, the chat's view, photos, uploads, messages, the Owner card).
 * Ready = a reply model resolves (the org's pick, else the host's default), this host can run it
 * (it is in the host's model list: known, with credentials) and Settings → Models hasn't turned it
 * off. The send path keeps its own chat-side checks as the last guard.
 */

export interface ReplyModelState {
  pick: ModelPick;
  source: AssistantModelSource;
  ready: boolean;
  problem: AssistantModelProblem | null;
  /** The model's `input` lists `image`; unknown is no. */
  images: boolean;
}

/** The host's runnable models (GET /api/models' list). Imported late: models.ts reaches the chat runtime. */
let available: () => Promise<Pick<ModelInfo, "ref" | "input">[]> = async () => (await import("./models")).listModels();

/** Tests: the list the predicate reads, in place of the host's model runtime; null puts the real one back. */
export function setAssistantModelListForTests(fn: (() => Promise<Pick<ModelInfo, "ref" | "input">[]>) | null): void {
  available = fn ?? (async () => (await import("./models")).listModels());
}

/** The resolved reply model and whether it runs here; null when none resolves. */
export async function assistantReplyState(orgId: string): Promise<ReplyModelState | null> {
  const r = effectiveAssistantModel(orgId, "reply");
  if (!r) return null;
  const ref = r.pick.model;
  const list = await available().catch((): Pick<ModelInfo, "ref" | "input">[] => []);
  const found = list.find((m) => m.ref === ref);
  const problem: AssistantModelProblem | null = !found ? "unavailable" : modelDenial(readModelPolicy(), ref) ? "turned-off" : null;
  return { pick: r.pick, source: r.source, ready: problem === null, problem, images: !!found?.input?.includes("image") };
}

/** The assistant takes messages now. */
export const assistantReady = async (orgId: string): Promise<boolean> => (await assistantReplyState(orgId))?.ready === true;
