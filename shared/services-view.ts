/**
 * The Branches tab and the host-wide Running branches (§app.project-services/services-ui), as the pages
 * read them: `GET /api/projects/:pid/services` and `GET /api/services`. The engine's status joined with
 * what the definition says about each service's HTTP readiness, the copy's share endpoints and its entry point. The
 * verbs answer the engine's own result (`VerbResult`, shared/project-contract.ts).
 */

import type { Check, InstanceState, InstanceSummary, ServiceState, ServiceView } from "./project-contract";

/** A service as the tab shows it: the engine's view, plus the port its readiness probes over HTTP (a static service's port too). */
export interface ServiceRowView extends ServiceView {
  http?: { port: number; path: string };
}

/** A copy's entry point (the definition's `open`): its endpoint, that endpoint's port in this copy, and the page's path. */
export interface EntryView {
  endpoint: string;
  port: number;
  path: string;
}

/** One copy (an instance of a checkout) with its checkout services only; its links and share standing as status gives them. */
export interface CopyView extends Omit<InstanceSummary, "services"> {
  services: ServiceRowView[];
  /** The systemd unit slot 0 adopts (§app.project-services/adopt): Sova never starts, stops or tears it down. */
  adopted?: string;
  /** Where a person opens it, when its definition declares `open` and it has that port. */
  open?: EntryView;
}

/**
 * The copy limit as the Branches tab shows it (§app.project-services/services-ui): the limit in force and where
 * it comes from, how many copies there are and run, the sentence while more run than it allows, what a copy
 * takes in memory (conformance's reading) and this machine's memory.
 */
export interface CopyLimitView {
  value: number;
  /** `machine`: set on this machine; `file`: the main checkout's file's value (or the default without a valid file). */
  source: "machine" | "file";
  /** The main checkout's file's own value, or null: that file is missing or invalid (4 applies). */
  file: number | null;
  /** The project's copies besides the main checkout's and conformance's. */
  copies: number;
  /** Those of them that run (wanting a service running). */
  running: number;
  /** "{n} running, {k} over the limit of {cap}: …" while more run than the limit allows, else null. */
  over: string | null;
  /** How many slots of 1 to 16 the main checkout's definition can use (its layout). */
  usable: number;
  /** One sentence per slot of 1 to 16 it can't ("Slot 14 is unavailable: its ports overlap slot 10's."). */
  unavailable: string[];
  /** Per copy, the larger of conformance's two scratch copies' readings; null: none measured. */
  estimate: { steadyBytes: number; peakBytes: number; source: "current" | "older"; at: string } | null;
  /** This machine's memory now, or null when it can't be read. */
  host: { totalBytes: number; availableBytes: number } | null;
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
  /** The copy limit and its cost (the route adds it). */
  limit?: CopyLimitView;
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
  /** Where a person opens it, as on the tab, and whether the entry's own service is ready (this view lists no services). */
  open?: EntryView & { ready: boolean };
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

/** Verbs the Branches tab's routes run as the operator. */
export const SERVICES_UI_VERBS = ["up", "down", "apply", "reset", "teardown", "logs", "share", "revoke"] as const;
export type ServicesUiVerb = (typeof SERVICES_UI_VERBS)[number];
export const SERVICES_LOG_LINES = 200;

/** A degraded copy whose only trouble is a service still starting (none failed or degraded): it reads as Starting. */
export function isStarting(state: InstanceState, services: readonly Pick<ServiceView, "state">[]): boolean {
  return state === "degraded" && services.some((s) => s.state === "starting") && !services.some((s) => s.state === "failed" || s.state === "degraded");
}
