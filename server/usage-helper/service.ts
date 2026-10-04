import path from "node:path";
import { USAGE_RANGES, MAX_USAGE_SESSIONS, type UsageRange } from "../../shared/usage/wire";
import { Ledger } from "./ledger";
import { createPriceBook, type PriceBook, type PriceBookOptions } from "./price-book";
import { orgCosts, projectCost, type ProjectDeps, type ProjectScope } from "./project";
import { Queries } from "./query";

/**
 * The helper's world in one object: the price book, the ledger and the queries over it, wired so a
 * price change folds the affected days again. The child (main.ts) and the tests build it the same way.
 */

export interface ServiceOptions {
  usageRoot: string;
  stateDir: string;
  pricesPath: string;
  device?: () => string | null;
  now?: () => number;
  log?: (line: string) => void;
  prices?: Omit<PriceBookOptions, "path">;
}

export interface Service {
  ledger: Ledger;
  prices: PriceBook;
  queries: Queries;
  /** One request, as the client sends it: `{op, ...}`. Throws a `BadRequest` on a bad one. */
  answer(req: Record<string, unknown>): Promise<unknown>;
}

export class BadRequest extends Error {}

/** A project scope as the server sends it (server/project-costs.ts). */
function scopeOf(v: unknown): ProjectScope {
  const s = v as Partial<ProjectScope> | null;
  if (!s || typeof s.projectId !== "string" || typeof s.costsPath !== "string" || !path.isAbsolute(s.costsPath) || !Array.isArray(s.sources)) {
    throw new BadRequest("a project scope needs projectId, an absolute costsPath and sources");
  }
  for (const src of s.sources) {
    if (!src || typeof src.key !== "string" || typeof src.sessionId !== "string" || typeof src.kind !== "string" || typeof src.by !== "string") throw new BadRequest("a scope source needs key, sessionId, kind and by");
  }
  return { projectId: s.projectId, costsPath: s.costsPath, sources: s.sources };
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : typeof v === "string" ? [v] : []);

export function createService(opts: ServiceOptions): Service {
  const log = opts.log ?? ((l: string) => console.warn(`[usage-helper] ${l}`));
  const prices = createPriceBook({ ...opts.prices, path: opts.pricesPath, ...(opts.now ? { now: opts.now } : {}), log });
  const ledger = new Ledger({ usageRoot: opts.usageRoot, stateDir: opts.stateDir, prices, ...(opts.now ? { now: opts.now } : {}), log });
  const queries = new Queries({ ledger, prices, device: opts.device ?? (() => null), ...(opts.now ? { now: opts.now } : {}) });
  prices.onChange((prev, next) => {
    const days = ledger.repriced(prev, next);
    if (days.length) log(`prices changed: folded ${days.length} day(s) again (${days[0]}${days.length > 1 ? ` … ${days[days.length - 1]}` : ""})`);
  });

  const projectDeps: ProjectDeps = { ledger, queries, prices, device: opts.device ?? (() => null), now: opts.now ?? Date.now };

  const answer = async (req: Record<string, unknown>): Promise<unknown> => {
    const tz = typeof req.tz === "string" ? req.tz : "UTC";
    switch (req.op) {
      case "costs": {
        const range = (req.range ?? "30d") as UsageRange;
        if (!USAGE_RANGES.includes(range)) throw new BadRequest(`range must be one of ${USAGE_RANGES.join(", ")}`);
        return queries.costs({ range, providers: strings(req.provider), models: strings(req.model), tz });
      }
      case "today":
        return queries.today({ tz });
      case "session": {
        if (typeof req.sid !== "string" || !req.sid) throw new BadRequest("sid is required");
        return queries.session({ sid: req.sid });
      }
      case "sessions": {
        const sids = strings(req.sids);
        if (sids.length > MAX_USAGE_SESSIONS) throw new BadRequest(`at most ${MAX_USAGE_SESSIONS} sids`);
        return queries.sessions({ sids });
      }
      case "prices":
        return prices.info();
      case "refresh":
        await prices.refresh(true);
        return prices.info();
      case "project":
        return projectCost(projectDeps, scopeOf(req.scope));
      case "org": {
        if (typeof req.orgId !== "string" || !Array.isArray(req.scopes)) throw new BadRequest("orgId and scopes are required");
        return orgCosts(projectDeps, req.orgId, req.scopes.map(scopeOf));
      }
      case "stats":
        return { ...ledger.stats, owners: ledger.owners.size, days: ledger.dayNames().length };
      default:
        throw new BadRequest(`unknown op ${String(req.op)}`);
    }
  };

  return { ledger, prices, queries, answer };
}
