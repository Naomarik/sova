import type { MeshSettings } from "./protocol";

// Types of this host's own /api/mesh/* routes: main listener only, never on the peer listener and
// never proxied host to host (the page only reads the host serving it). They stay out of
// protocol.ts on purpose: its hash is the mesh's compatibility fingerprint, and a field only the
// serving host's page reads must not make hosts on different builds "skewed".

/** GET/PUT /api/mesh/settings: MeshSettings plus fields only this host's page uses. */
export interface MeshLocalSettings extends MeshSettings {
  /** Hosts left out of the front door (ids, this host possible), e.g. a phone with no tailscale
      serve. Absent = every host is an upstream. In a PUT, null or [] clears it; leaving out every
      host is refused. */
  frontDoorExclude?: string[] | null;
}
