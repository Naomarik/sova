// The harness contract (§app/harness): what Sova code outside server/harness/<harness>/ speaks instead of
// a harness's own shapes. A types-only barrel: one file per part, each owned by the milestone named in
// its header, so this file never changes. Every shared/harness*.ts imports only its siblings and emits
// no code (server/harness-boundary.test.ts checks it).
export * from "./harness-core";
export * from "./harness-tools";
export * from "./harness-history";
export * from "./harness-wire";
export * from "./harness-state";
export * from "./harness-session";
