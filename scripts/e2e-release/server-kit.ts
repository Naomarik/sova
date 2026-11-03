/**
 * Tests and e2e drives only. One hermetic Sova (server/testing/hermetic-server.ts: throwaway agent dir, sentinel
 * HOME, stand-in `claude`) whose every chat talks to the scripted model (scripted-model.mjs) instead of the default
 * stand-in, so a test decides which tool calls a release chat makes. Never ~/.pi, never port 4800/4810.
 *
 *   const k = await startReleaseServer();
 *   const id = await k.register(fx.project, "pub");
 *   await k.verb("release.start", { project: fx.project });              // the operator route (browser = operator)
 *   await k.verb("release.publish", {...}, { callerKey: "ck_…" });       // the same, from a chat's script (t17)
 *   await k.model.script("release", [{ tool: "project_verbs", args: { verb: "release.step", ... } }]);
 *   await k.stop();
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startHermeticServer, type HermeticServer } from "../../server/testing/hermetic-server";

const HERE = resolve(import.meta.dirname);

export interface ModelAction {
  tool?: string;
  args?: Record<string, unknown>;
  text?: string;
}
export interface ModelLogEntry {
  at: number;
  match: string | null;
  tools: string[];
  last: string;
  toolResults: string[];
  action: ModelAction | null;
  called?: string;
  missing?: string;
}

export interface VerbAnswer {
  status: number;
  // The verb result (shared/project-contract.ts VerbResult); loosely typed so the kit doesn't pin the contract.
  json: Record<string, any>;
}

export interface ReleaseServer {
  hs: HermeticServer;
  base: string;
  model: {
    port: number;
    script(match: string, actions: ModelAction[]): Promise<void>;
    log(): Promise<ModelLogEntry[]>;
    reset(): Promise<void>;
  };
  http(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<VerbAnswer>;
  /** POST /api/project-services/<verb> with the server token. `callerKey` adds x-sova-caller (a chat's script). */
  verb(name: string, body: Record<string, unknown>, o?: { callerKey?: string }): Promise<VerbAnswer>;
  register(root: string, name: string): Promise<string>;
  stop(): Promise<string[]>;
}

function lineFrom(child: ChildProcess, re: RegExp, ms: number): Promise<RegExpExecArray> {
  return new Promise((ok, fail) => {
    let buf = "";
    const t = setTimeout(() => fail(new Error(`scripted model: no ${re} within ${ms} ms`)), ms).unref();
    child.stdout?.on("data", (d) => {
      buf += String(d);
      const m = re.exec(buf);
      if (m) {
        clearTimeout(t);
        ok(m);
      }
    });
    child.once("exit", (c) => fail(new Error(`scripted model exited ${c}`)));
  });
}

/** `env`: the server's test knobs (SOVA_RELEASE_QUIET_MS, SOVA_RELEASE_STALL_POLL_MS, …). */
export async function startReleaseServer(o: { env?: Record<string, string> } = {}): Promise<ReleaseServer> {
  const model = spawn("node", [join(HERE, "scripted-model.mjs"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
  const port = Number((await lineFrom(model, /^listening (\d+)$/m, 10_000))[1]);
  let hs: HermeticServer;
  try {
    hs = await startHermeticServer({ bootTimeoutMs: 90_000, env: o.env });
  } catch (e) {
    model.kill("SIGKILL");
    throw e;
  }
  // Every chat started from now on reads models.json at its start: repoint the stand-in provider at the scripted one.
  const mf = join(hs.agentDir, "models.json");
  const models = JSON.parse(readFileSync(mf, "utf8")) as { providers: Record<string, { baseUrl: string }> };
  for (const p of Object.values(models.providers)) p.baseUrl = `http://127.0.0.1:${port}/v1`;
  writeFileSync(mf, JSON.stringify(models, null, 2));

  const ctl = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    return r.json();
  };
  const http = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<VerbAnswer> => {
    const r = await fetch(hs.base + path, {
      method,
      headers: { "content-type": "application/json", "x-sova-token": hs.token, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json: Record<string, any>;
    try {
      json = JSON.parse(text) as Record<string, any>;
    } catch {
      json = { raw: text };
    }
    return { status: r.status, json };
  };
  return {
    hs,
    base: hs.base,
    model: {
      port,
      script: async (match, actions) => void (await ctl("POST", "/script", { match, actions })),
      log: async () => (await ctl("GET", "/log")) as ModelLogEntry[],
      reset: async () => void (await ctl("POST", "/reset")),
    },
    http,
    verb: (name, body, o = {}) => http("POST", `/api/project-services/${name}`, body, o.callerKey ? { "x-sova-caller": o.callerKey } : {}),
    register: async (root, name) => {
      const list = await http("GET", "/api/projects");
      const found = ((list.json.projects ?? []) as { root: string; id: string }[]).find((p) => p.root === root);
      if (found) return found.id;
      const r = await http("POST", "/api/projects", { root, name });
      if (r.status !== 201) throw new Error(`register ${name}: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
      return (r.json.project?.id ?? r.json.id) as string;
    },
    stop: async () => {
      model.kill("SIGKILL");
      return hs.stop();
    },
  };
}
