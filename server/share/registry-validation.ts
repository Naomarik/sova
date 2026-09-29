import type { RegistrySnapshot } from "../../shared/public-links";

/**
 * The registry snapshot check (§mesh.public/registry): pure, all or nothing, against
 * REGISTRY_LIMITS and the RegistrySnapshot rules in shared/public-links.ts. The byte cap is the
 * route's, before parsing; collisions, peer removal and replay are the registry transaction's.
 * Until the security milestone implements it, every snapshot is rejected.
 */

export interface SnapshotContext {
  /** ms epoch the expiry bounds are judged against. */
  now: number;
}

export type SnapshotCheck = { ok: true; snapshot: RegistrySnapshot } | { ok: false; error: "bad-snapshot"; why: string };

export function validateSnapshot(body: unknown, ctx: SnapshotContext): SnapshotCheck {
  void body;
  void ctx;
  return { ok: false, error: "bad-snapshot", why: "not implemented yet" };
}
