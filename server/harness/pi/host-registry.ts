// Each hosted chat's pi runtime, by its driving session (host.ts registers it): what testing/handle.ts hands the
// tests that drive or patch pi directly. No server code reads it. Kept apart from host.ts so a test can import
// the handle statically without loading the server.
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

export const hostedRuntimes = new WeakMap<object, AgentSessionRuntime>();
