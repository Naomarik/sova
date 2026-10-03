/**
 * The Services tab and the host-wide Running copies (§app.project-services/services-ui), as the pages
 * read them: `GET /api/projects/:pid/services` and `GET /api/services`. The engine's status joined with
 * what the definition says about each service's HTTP readiness and the copy's share endpoints. The
 * verbs answer the engine's own result (`VerbResult`, shared/project-contract.ts).
 */

import type { Check, InstanceState, InstanceSummary, ServiceState, ServiceView } from "./project-contract";

/** A service as the tab shows it: the engine's view, plus the port its readiness probes over HTTP (a static service's port too). */
export interface ServiceRowView extends ServiceView {
  http?: { port: number; path: string };
}

/** One copy (an instance of a checkout) with its checkout services only; its links and share standing as status gives them. */
export interface CopyView extends Omit<InstanceSummary, "services"> {
  services: ServiceRowView[];
  /** The systemd unit slot 0 adopts (§app.project-services/adopt): Sova never starts, stops or tears it down. */
  adopted?: string;
}

export interface ProjectServicesView {
  projectId: string;
  root: string;
  /** The main checkout's definition declares data derived from production: no copy is ever shared. */
  sensitive: boolean;
  /** Slot 0 first, then by slot. */
  copies: CopyView[];
  /** The project's shared services, once each. */
  shared: ServiceRowView[];
  /** The engine's supervisor check (informational). */
  supervisor: Check | null;
  /** Why status could not be read (the copies are then empty). */
  error?: string;
}

/** A copy that runs now, as the host-wide list shows it. */
export interface RunningCopy {
  instance: string;
  slot: number;
  branch: string | null;
  state: InstanceState;
  /** The sum of its services' resident memory; null when none reports one. */
  rssBytes: number | null;
  createdBy: string;
  /** Degraded only because a service is still starting (`isStarting`). */
  starting?: true;
  /** The unit an adopted slot 0 runs as: no Stop is offered. */
  adopted?: string;
}

export interface RunningShared {
  name: string;
  state: ServiceState;
  rssBytes: number | null;
  /** A copy of the project, which the Stop of a shared service names (the engine stops it by name). */
  via: string;
}

export interface RunningProject {
  /** Null for a root no registered project holds. */
  projectId: string | null;
  name: string;
  root: string;
  orgName?: string;
  copies: RunningCopy[];
  shared: RunningShared[];
}

/** `GET /api/services`: every project on this host with something running now, by name. */
export interface HostServicesView {
  projects: RunningProject[];
}

/** Verbs the Services routes run as the operator. */
export const SERVICES_UI_VERBS = ["up", "down", "apply", "reset", "teardown", "logs", "share", "revoke"] as const;
export type ServicesUiVerb = (typeof SERVICES_UI_VERBS)[number];
export const SERVICES_LOG_LINES = 200;

/** A degraded copy whose only trouble is a service still starting (none failed or degraded): it reads as Starting. */
export function isStarting(state: InstanceState, services: readonly Pick<ServiceView, "state">[]): boolean {
  return state === "degraded" && services.some((s) => s.state === "starting") && !services.some((s) => s.state === "failed" || s.state === "degraded");
}
