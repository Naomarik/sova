// pi's extension types, for the code outside the adapter that still hands pi an inline extension or a loader
// override (§app.harness/session-special): the special loadouts' factories (server/overseer.ts,
// server/project-overseer.ts, server/baton-loadout.ts) are typed from these, through the loadout their
// registry declares (server/chat-manager.ts), never from pi; so are the other inline extensions (vis-check.ts,
// topics.ts, resource-monitor.ts, project-services/note.ts and tools.ts), the loadout's skills override
// (session-loadout.ts) and the context windows read off the model runtime (models.ts). Types only.
import type { CreateAgentSessionServicesOptions, ExtensionAPI, ModelRuntime, ResourceDiagnostic, Skill, ToolDefinition } from "@earendil-works/pi-coding-agent";

/** pi's resource loader options for a runtime: the extensions it loads and any loader overrides. */
export type PiLoaderOptions = NonNullable<CreateAgentSessionServicesOptions["resourceLoaderOptions"]>;
/** An extension factory entry of a loader's `extensionFactories`. */
export type PiExtensionFactory = NonNullable<PiLoaderOptions["extensionFactories"]>[number];
/** What an inline extension's factory is handed. */
export type PiExtensionAPI = ExtensionAPI;
export type PiModelRuntime = ModelRuntime;
export type PiToolDefinition = ToolDefinition;
/** A skill as pi's loader lists it, and a loader diagnostic (a loader's skills override takes and returns them). */
export type PiSkill = Skill;
export type PiResourceDiagnostic = ResourceDiagnostic;
