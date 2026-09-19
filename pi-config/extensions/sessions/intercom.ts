// Protocol types for the sessions presence channel. Originally a vendored subset
// of pi-intercom's extension-channel protocol; the broker dependency is gone and
// these types are now implemented locally by the filesystem bus in presence.ts.

export interface SessionInfo {
  id: string;
  endpointEpoch?: string;
  name?: string;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
}

export type IntercomExtensionEvent =
  | { type: "connection"; connected: boolean; supported: boolean }
  | { type: "message"; fromSessionId: string; payload: unknown }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "presence_update"; session: SessionInfo };

export interface IntercomExtensionChannel {
  readonly namespace: string;
  snapshot(): { connected: boolean; supported: boolean };
  publish(payload: unknown, options?: { audience?: "owner" | "capable"; ownerOnly?: boolean }): void;
  listSessions(): Promise<SessionInfo[]>;
}
