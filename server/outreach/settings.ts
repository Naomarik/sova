import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { OutreachFile, OutreachPatch, SenderRoute } from "../../shared/outreach";
import { stateRoot } from "../state-root";

/**
 * `<stateRoot>/outreach.json` (§app.outreach/sender-route): how this host reaches the WhatsApp
 * sender, who may send through it, and the pause switch. 0600, written atomically, parsed strictly
 * (an unknown key or a wrong type is a problem, never guessed at). No file: off.
 */

export const OFF: OutreachFile = { version: 1, sender: "off", acceptFrom: [], paused: false };

export const outreachFile = (): string => join(stateRoot(), "outreach.json");

/** The sender's home by default (services/whatsapp/IPC.md): `<agent dir>/sova/whatsapp`. */
export const defaultSenderHome = (): string => join(getAgentDir(), "sova", "whatsapp");
/** pi's own default agent dir's sender home, whatever this server's agent dir is (a hermetic server). */
export const piDefaultSenderHome = (): string => join(homedir(), ".pi", "agent", "sova", "whatsapp");

/** The local sender's socket: the setting's, else $SOVA_WA_SOCKET, else $SOVA_WA_HOME/sender.sock, else the default home's. */
export function localSocket(route: SenderRoute, env: NodeJS.ProcessEnv = process.env): string | null {
  if (typeof route !== "object" || !("local" in route)) return null;
  return route.local.socket || env.SOVA_WA_SOCKET || join(env.SOVA_WA_HOME || defaultSenderHome(), "sender.sock");
}

class ParseError extends Error {}
const fail = (why: string): never => {
  throw new ParseError(why);
};
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, keys: readonly string[], what: string) => {
  for (const k of Object.keys(o)) if (!keys.includes(k)) fail(`${what}: unknown key ${JSON.stringify(k)}`);
};
const NODE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function parseRoute(v: unknown): SenderRoute {
  if (v === "off") return "off";
  if (!isObj(v)) return fail('sender must be "off", {local} or {via}');
  if ("local" in v) {
    onlyKeys(v, ["local"], "sender");
    if (!isObj(v.local)) return fail("sender.local must be an object");
    onlyKeys(v.local, ["socket"], "sender.local");
    const socket = v.local.socket;
    if (socket === undefined || socket === "") return { local: {} };
    if (typeof socket !== "string" || !isAbsolute(socket)) return fail("sender.local.socket must be an absolute path");
    return { local: { socket } };
  }
  if ("via" in v) {
    onlyKeys(v, ["via"], "sender");
    if (!isObj(v.via)) return fail("sender.via must be an object");
    onlyKeys(v.via, ["nodeId"], "sender.via");
    if (typeof v.via.nodeId !== "string" || !NODE_ID.test(v.via.nodeId)) return fail("sender.via.nodeId must be a peer's StableID");
    return { via: { nodeId: v.via.nodeId } };
  }
  return fail('sender must be "off", {local} or {via}');
}

function parseAccept(v: unknown): "all" | string[] {
  if (v === "all") return "all";
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !NODE_ID.test(x))) return fail('acceptFrom must be "all" or a list of StableIDs');
  if (new Set(v).size !== v.length) fail("acceptFrom names a node twice");
  return [...v] as string[];
}

export function parseOutreach(raw: unknown): OutreachFile {
  if (!isObj(raw)) return fail("not an object");
  onlyKeys(raw, ["version", "sender", "acceptFrom", "paused", "authDir"], "outreach.json");
  if (raw.version !== 1) fail("version must be 1");
  const out: OutreachFile = { version: 1, sender: parseRoute(raw.sender), acceptFrom: raw.acceptFrom === undefined ? [] : parseAccept(raw.acceptFrom), paused: false };
  if (raw.paused !== undefined) {
    if (typeof raw.paused !== "boolean") fail("paused must be true or false");
    out.paused = raw.paused as boolean;
  }
  if (raw.authDir !== undefined && raw.authDir !== "") {
    if (typeof raw.authDir !== "string" || !isAbsolute(raw.authDir)) fail("authDir must be an absolute path");
    out.authDir = raw.authDir as string;
  }
  return out;
}

/** The setting and, when the file is there but unreadable, why (it then reads as off). */
export function readOutreachState(): { file: OutreachFile; problem?: string } {
  let text: string;
  try {
    text = readFileSync(outreachFile(), "utf8");
  } catch {
    return { file: { ...OFF } };
  }
  try {
    return { file: parseOutreach(JSON.parse(text)) };
  } catch (err) {
    return { file: { ...OFF }, problem: err instanceof ParseError ? err.message : "not JSON" };
  }
}

export const readOutreach = (): OutreachFile => readOutreachState().file;

function write(file: OutreachFile): void {
  const path = outreachFile();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Apply a patch (each key whole); refused with the parse problem, and never over an unreadable file. */
export function saveOutreach(patch: OutreachPatch): { file: OutreachFile } | { error: string } {
  const cur = readOutreachState();
  if (cur.problem) return { error: `outreach.json can't be read (${cur.problem}); fix or remove it first.` };
  try {
    const next = parseOutreach({ ...cur.file, ...patch });
    write(next);
    return { file: next };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Record the auth directory the local sender reports, when it differs from the default (so it is protected). */
export function noteAuthDir(authDir: string): void {
  const cur = readOutreachState();
  if (cur.problem || !isAbsolute(authDir) || cur.file.authDir === authDir) return;
  if (authDir === join(defaultSenderHome(), "auth") && !cur.file.authDir) return;
  write({ ...cur.file, authDir });
}
