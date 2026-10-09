import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { ENTRY_ID, labelProblem, NUMBER_ID, type LocalNumber, type OutreachFile, type OutreachPatch, type SenderRoute } from "../../shared/outreach";
import { agentRoot, stateRoot } from "../state-root";

/**
 * `<stateRoot>/outreach.json` (§app.outreach/sender-route): how this host reaches the WhatsApp
 * sender, who may send through it, and the pause switch. 0600, written atomically, parsed strictly
 * (an unknown key or a wrong type is a problem, never guessed at). No file: off.
 */

export const OFF: OutreachFile = { version: 1, sender: "off", acceptFrom: [], paused: false };

export const outreachFile = (): string => join(stateRoot(), "outreach.json");

/** The sender's home by default (services/whatsapp/IPC.md): `<agent dir>/sova/whatsapp`. */
export const defaultSenderHome = (): string => join(agentRoot(), "sova", "whatsapp");
/** pi's own default agent dir's sender home, whatever this server's agent dir is (a hermetic server). */
export const piDefaultSenderHome = (): string => join(homedir(), ".pi", "agent", "sova", "whatsapp");

/** A local sender's socket: an added number's own; this host's: the setting's, else $SOVA_WA_SOCKET, else
    $SOVA_WA_HOME/sender.sock, else the default home's. Null for off and a peer. */
export function localSocket(route: SenderRoute, env: NodeJS.ProcessEnv = process.env, numbers: readonly LocalNumber[] = []): string | null {
  if (typeof route !== "object") return null;
  if ("number" in route) return numbers.find((n) => n.id === route.number.id)?.socket ?? null;
  if (!("local" in route)) return null;
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
  if (!isObj(v)) return fail('sender must be "off", {local}, {number} or {via}');
  if ("number" in v) {
    onlyKeys(v, ["number"], "sender");
    if (!isObj(v.number)) return fail("sender.number must be an object");
    onlyKeys(v.number, ["id"], "sender.number");
    if (typeof v.number.id !== "string" || !NUMBER_ID.test(v.number.id)) return fail("sender.number.id must be an added number's name");
    return { number: { id: v.number.id } };
  }
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
  return fail('sender must be "off", {local}, {number} or {via}');
}

function parseNumbers(v: unknown): LocalNumber[] {
  if (!Array.isArray(v)) return fail("numbers must be a list");
  const out: LocalNumber[] = [];
  for (const n of v) {
    if (!isObj(n)) return fail("each number must be an object");
    onlyKeys(n, ["id", "socket"], "numbers[]");
    if (typeof n.id !== "string" || !NUMBER_ID.test(n.id)) return fail("a number's name must be lowercase letters, digits and dashes, at most 32");
    if (typeof n.socket !== "string" || !isAbsolute(n.socket)) return fail(`number ${n.id}: socket must be an absolute path`);
    if (out.some((x) => x.id === n.id)) return fail(`two numbers are named ${n.id}`);
    if (out.some((x) => x.socket === n.socket)) return fail(`two numbers use the socket ${n.socket}`);
    out.push({ id: n.id, socket: n.socket });
  }
  return out;
}

function parseIdMap(v: unknown, what: string, value: (k: string, x: unknown) => string): Record<string, string> {
  if (!isObj(v)) return fail(`${what} must be an object`);
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) out[k] = value(k, x);
  return out;
}

function parseAccept(v: unknown): "all" | string[] {
  if (v === "all") return "all";
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !NODE_ID.test(x))) return fail('acceptFrom must be "all" or a list of StableIDs');
  if (new Set(v).size !== v.length) fail("acceptFrom names a node twice");
  return [...v] as string[];
}

export function parseOutreach(raw: unknown): OutreachFile {
  if (!isObj(raw)) return fail("not an object");
  onlyKeys(raw, ["version", "sender", "numbers", "labels", "orgs", "acceptFrom", "paused", "authDir", "senderAuthDir"], "outreach.json");
  if (raw.version !== 1) fail("version must be 1");
  const out: OutreachFile = { version: 1, sender: parseRoute(raw.sender), acceptFrom: raw.acceptFrom === undefined ? [] : parseAccept(raw.acceptFrom), paused: false };
  // Absent stays absent, so a file an earlier version wrote is written back as it was.
  const numbers = raw.numbers === undefined ? [] : parseNumbers(raw.numbers);
  if (raw.numbers !== undefined) out.numbers = numbers;
  const def = out.sender;
  if (typeof def === "object" && "number" in def && !numbers.some((n) => n.id === def.number.id)) fail(`the default is ${def.number.id}, which is not an added number`);
  if (raw.labels !== undefined)
    out.labels = parseIdMap(raw.labels, "labels", (k, x) => {
      if (!ENTRY_ID.test(k)) fail(`labels: ${JSON.stringify(k)} is not a sender's id`);
      if (typeof x !== "string") return fail(`labels.${k} must be a string`);
      const why = labelProblem(x);
      return why ? fail(`labels.${k}: ${why}`) : x.trim();
    });
  if (raw.orgs !== undefined)
    out.orgs = parseIdMap(raw.orgs, "orgs", (k, x) => {
      if (!NODE_ID.test(k)) fail(`orgs: ${JSON.stringify(k)} is not an organization's id`);
      if (typeof x !== "string" || !ENTRY_ID.test(x)) return fail(`orgs.${k} must be a sender's id`);
      return x;
    });
  if (raw.paused !== undefined) {
    if (typeof raw.paused !== "boolean") fail("paused must be true or false");
    out.paused = raw.paused as boolean;
  }
  if (raw.authDir !== undefined && raw.authDir !== "") {
    if (typeof raw.authDir !== "string" || !isAbsolute(raw.authDir)) fail("authDir must be an absolute path");
    out.authDir = raw.authDir as string;
  }
  if (raw.senderAuthDir !== undefined && raw.senderAuthDir !== "") {
    if (typeof raw.senderAuthDir !== "string" || !isAbsolute(raw.senderAuthDir)) fail("senderAuthDir must be an absolute path");
    out.senderAuthDir = raw.senderAuthDir as string;
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
export function saveOutreach(patch: OutreachPatch & Pick<OutreachFile, "orgs">): { file: OutreachFile } | { error: string } {
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

/** Record the auth directory the local sender reports (beside the operator's own `authDir`), so it is protected. */
export function noteAuthDir(authDir: string): void {
  const cur = readOutreachState();
  if (cur.problem || !isAbsolute(authDir) || cur.file.senderAuthDir === authDir) return;
  write({ ...cur.file, senderAuthDir: authDir });
}
