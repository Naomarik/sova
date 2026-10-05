// What a hosted chat holds of its pi runtime (§app.harness/session): the driving session, and the few
// runtime-level steps that are not a session's (binding the extensions, the provider-read install, the model
// runtime the context windows come from, disposal). server/chat-manager.ts holds one per ChatSession and
// never sees the runtime or its AgentSession; tests reach them through testing/handle.ts (host-registry.ts).
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { DialogBridge, HarnessSession } from "../../../shared/harness";
import { useSlicedProviderReads } from "../../runtime-quirks";
import type { PiModelRuntime } from "./extension-types";
import { hostedRuntimes } from "./host-registry";
import { PiHarnessSession } from "./session";
import { bindPiExtensions } from "./ui-bridge";

export class PiChatHost {
  /** The driving session: the runtime's current session, looked up at each call. */
  readonly harness: HarnessSession;

  constructor(private readonly runtime: AgentSessionRuntime) {
    this.harness = new PiHarnessSession(runtime);
    hostedRuntimes.set(this.harness, runtime);
  }

  /** P8: provider bodies in reads no bigger than Node's (runtime-quirks.ts), on the current session's agent. */
  useSlicedProviderReads(): void {
    useSlicedProviderReads(this.runtime.session.agent);
  }

  /** The current session's extensions, bound to the chat's dialogs (ui-bridge.ts). */
  bindExtensions(dialogs: DialogBridge, onError: (extensionPath: string, error: string) => void): Promise<void> {
    return bindPiExtensions(this.runtime.session, dialogs, onError);
  }

  /** The model runtime this chat's sessions resolve models and context windows against (models.ts). */
  get models(): PiModelRuntime {
    return this.runtime.services.modelRuntime;
  }

  dispose(): Promise<void> {
    return this.runtime.dispose();
  }
}
