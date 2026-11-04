// The page's MCP routes (§app/mcp). Reads are open to every caller; every write is the page's own
// (`pageOnlyRefusal`): adding and editing count as approving, and everything that changes a server stays on the page
// (§app.mcp/reads). A refusal's `error` is the deck's sentence (§design.copy-deck/mcp-servers).
import type { Context, Hono } from "hono";
import type { McpErrorCode, McpNewServer, McpServerRow, McpSignIn } from "../../shared/mcp";
import { pageOnlyRefusal, type PageOnlyWords } from "../page-only";
import { readProject } from "../projects/spaces";
import { OrgError } from "../org-error";
import { checkServer } from "./check";
import { normalizeEntry, putComputerEntry, readComputerList, removeComputerEntry, reservedName, type McpEntry } from "./config";
import { versionOf } from "./fingerprint";
import { parseRowId, rowId, type RowRef } from "./ids";
import { baseOf, currentEntry, refusalOf } from "./resolve";
import { removeServerSecrets, removeSecret, saveSecret } from "./secrets";
import { pasteAddress, signInState, startSignIn, stopSignIn } from "./sign-in";
import { changeRow, forgetRow } from "./store";
import { approve, forgetApprovals, type McpOwner } from "./trust";
import { isSecretName } from "./values";
import { computerServers, projectServers, rowOf } from "./view";
import { forgetSignIn } from "./forget-sign-in";

const NO_STORE = { "Cache-Control": "no-store" };
const words = (what: string): PageOnlyWords => ({ overseer: what, local: what, chat: what, script: what, extension: what });
const APPROVE_ONLY = words("Only you can approve a server, on the page.");
const SIGN_IN_ONLY = words("Only you can sign in to a server, on the page.");
export const RESERVED = "The name sova is Sova's own. Pick another.";
export const CHANGED = "This server changed since you looked. Check what it runs, then approve it again.";

class Refusal extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409, readonly code?: McpErrorCode, readonly row?: McpServerRow) {
    super(message);
  }
}

const handle =
  (fn: (c: Context) => Promise<Response>) =>
  async (c: Context): Promise<Response> => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof Refusal) return c.json({ error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.row ? { row: err.row } : {}) }, err.status, NO_STORE);
      if (err instanceof OrgError) return c.json({ error: err.message }, err.status, NO_STORE);
      throw err;
    }
  };

const page =
  (only: PageOnlyWords, fn: (c: Context) => Promise<Response>) =>
  handle(async (c) => {
    const notYou = pageOnlyRefusal(c, only);
    if (notYou) throw new Refusal(notYou, 403, "page-only");
    return fn(c);
  });

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    if (b && typeof b === "object" && !Array.isArray(b)) return b as Record<string, unknown>;
  } catch {
    // below
  }
  throw new Refusal("Expected a JSON body.", 400, "invalid");
}

const refOf = (c: Context): RowRef => {
  const ref = parseRowId(c.req.param("id") ?? "");
  if (!ref) throw new Refusal("No such server.", 404);
  return ref;
};

const liveRow = async (ref: RowRef): Promise<McpServerRow> => {
  const row = await rowOf(ref);
  if (!row) throw new Refusal("No such server.", 404);
  return row;
};

/** One command line into a command and its arguments: quotes hold spaces, and nothing is expanded. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) out.push(m[1]?.replace(/\\(.)/g, "$1") ?? m[2] ?? m[3]!);
  return out;
}

const SECRET_NAME = "API_KEY";

function filledName(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new Refusal("Give the server a name.", 400, "invalid");
  const name = raw.trim();
  if (reservedName(name)) throw new Refusal(RESERVED, 400, "reserved");
  return name;
}

function addressEntry(name: string, address: unknown, secret: boolean): McpEntry {
  if (typeof address !== "string" || !/^https?:\/\//i.test(address.trim())) throw new Refusal("Give the server's address, starting with https://.", 400, "invalid");
  return normalizeEntry(name, { url: address.trim(), ...(secret ? { headers: { Authorization: `Bearer \${${SECRET_NAME}}` } } : {}) }, "computer");
}

function commandEntry(name: string, command: unknown, secretName: string | undefined): McpEntry {
  const parts = typeof command === "string" ? splitCommand(command) : [];
  if (!parts.length) throw new Refusal("Give the command that starts the server.", 400, "invalid");
  return normalizeEntry(name, { command: parts[0], args: parts.slice(1), ...(secretName ? { env: { [secretName]: `\${${secretName}}` } } : {}) }, "computer");
}

/** An entry in the shape other tools write it: alone, or under `mcpServers`, or keyed by its name. */
function pastedEntry(name: string, text: unknown): McpEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof text === "string" ? text : "");
  } catch (err) {
    throw new Refusal(`That isn't an entry Sova can read: ${(err as Error).message}`, 400, "invalid");
  }
  const servers = (parsed as { mcpServers?: unknown })?.mcpServers ?? parsed;
  const o = (servers ?? {}) as Record<string, unknown>;
  const raw = "command" in o || "url" in o ? o : (o[name] ?? Object.values(o)[0]);
  const entry = normalizeEntry(name, raw, "computer");
  if (entry.problems) throw new Refusal(`That isn't an entry Sova can read: ${entry.problems.join(", ")}`, 400, "invalid");
  return entry;
}

function entryOfNew(b: Partial<McpNewServer> & Record<string, unknown>): { entry: McpEntry; secret?: { name: string; value: string } } {
  const name = filledName(b.name);
  const secret = typeof b.secret === "string" && b.secret ? b.secret : undefined;
  if (b.way === "address") return { entry: addressEntry(name, b.address, !!secret), ...(secret ? { secret: { name: SECRET_NAME, value: secret } } : {}) };
  if (b.way === "command") {
    const given = typeof b.secretName === "string" && b.secretName.trim() ? b.secretName.trim() : secret ? SECRET_NAME : undefined;
    if (given && !isSecretName(given)) throw new Refusal("A secret's name is letters, digits and underscores.", 400, "invalid");
    return { entry: commandEntry(name, b.command, given), ...(secret ? { secret: { name: given!, value: secret } } : {}) };
  }
  if (b.way === "paste") return { entry: pastedEntry(name, b.text) };
  throw new Refusal("Expected way: address, command or paste.", 400, "invalid");
}

const computer: McpOwner = { kind: "computer" };

/** Save, approve that exact entry and Check it: what Add and Edit are (§app.mcp/add-server). */
async function saveApproved(entry: McpEntry, secret?: { name: string; value: string }): Promise<McpServerRow> {
  putComputerEntry(entry);
  if (secret) saveSecret(computer, entry.name, secret.name, secret.value);
  approve(computer, entry.name, versionOf(entry, baseOf(computer)));
  await checkServer(computer, entry.name);
  return liveRow({ owner: computer, name: entry.name });
}

export function registerMcpRoutes(app: Hono<any>): void {
  app.get("/api/mcp/servers", handle(async (c) => c.json(await computerServers(), 200, NO_STORE)));
  app.get("/api/mcp/rows/:id", handle(async (c) => c.json(await liveRow(refOf(c)), 200, NO_STORE)));
  app.get("/api/projects/:pid/mcp", handle(async (c) => c.json(await projectServers(readProject(c.req.param("pid") ?? "")), 200, NO_STORE)));

  app.post(
    "/api/mcp/servers",
    page(APPROVE_ONLY, async (c) => {
      const { entry, secret } = entryOfNew(await body(c));
      if (readComputerList().entries.some((e) => e.name === entry.name)) throw new Refusal(`There's already a server named ${entry.name}.`, 409, "exists");
      return c.json(await saveApproved(entry, secret), 200, NO_STORE);
    }),
  );

  app.put(
    "/api/mcp/rows/:id",
    page(APPROVE_ONLY, async (c) => {
      const ref = refOf(c);
      if (ref.owner.kind !== "computer") throw new Refusal("A project's server changes through its file.", 409, "invalid");
      const was = currentEntry(ref.owner, ref.name);
      if (!was) throw new Refusal("No such server.", 404);
      if (reservedName(ref.name)) throw new Refusal(RESERVED, 400, "reserved");
      const b = await body(c);
      const value = typeof b.secret === "string" && b.secret ? b.secret : undefined;
      const given = typeof b.secretName === "string" && b.secretName.trim() ? b.secretName.trim() : undefined;
      if (given && !isSecretName(given)) throw new Refusal("A secret's name is letters, digits and underscores.", 400, "invalid");
      if (typeof b.address === "string") {
        // A pasted header stays; the Secret field is the Bearer header's.
        const kept = addressEntry(ref.name, b.address, !!value);
        const headers = value ? kept.headers : was.headers;
        return c.json(await saveApproved({ ...kept, ...(headers ? { headers } : {}) }, value ? { name: SECRET_NAME, value } : undefined), 200, NO_STORE);
      }
      const name = given ?? (value ? SECRET_NAME : undefined);
      return c.json(await saveApproved(commandEntry(ref.name, b.command, name), value ? { name: name!, value } : undefined), 200, NO_STORE);
    }),
  );

  app.delete(
    "/api/mcp/rows/:id",
    page(APPROVE_ONLY, async (c) => {
      const ref = refOf(c);
      if (ref.owner.kind !== "computer") throw new Refusal("A project's server changes through its file.", 409, "invalid");
      const e = currentEntry(ref.owner, ref.name);
      if (!e) throw new Refusal("No such server.", 404);
      stopSignIn(ref);
      removeComputerEntry(ref.name);
      forgetApprovals(ref.owner, ref.name);
      forgetRow(ref.owner, ref.name);
      removeServerSecrets(ref.owner, ref.name);
      forgetSignIn(e);
      return c.json(await computerServers(), 200, NO_STORE);
    }),
  );

  app.patch(
    "/api/mcp/rows/:id",
    page(APPROVE_ONLY, async (c) => {
      const ref = refOf(c);
      await liveRow(ref);
      const b = await body(c);
      if (typeof b.newChats === "boolean") changeRow(ref.owner, ref.name, (r) => void (r.settings.newChats = b.newChats as boolean));
      else if (typeof b.tool === "string" && typeof b.on === "boolean") {
        const { tool, on } = b as { tool: string; on: boolean };
        changeRow(ref.owner, ref.name, (r) => {
          const off = new Set(r.settings.offTools);
          if (on) off.delete(tool);
          else off.add(tool);
          r.settings.offTools = [...off];
        });
      } else throw new Refusal("Expected {newChats} or {tool, on}.", 400, "invalid");
      return c.json(await liveRow(ref), 200, NO_STORE);
    }),
  );

  app.post(
    "/api/mcp/rows/:id/approve",
    page(APPROVE_ONLY, async (c) => {
      const ref = refOf(c);
      const row = await liveRow(ref);
      const b = await body(c);
      if (row.refused) throw new Refusal(row.refused.why === "reserved" ? "This entry uses the name sova, which is Sova's own, so it won't run." : `This entry can't run: ${row.refused.names.join(", ")}.`, 409, row.refused.why === "reserved" ? "reserved" : "invalid");
      // Read again at the moment of approving: what you approve is what you saw.
      const e = currentEntry(ref.owner, ref.name)!;
      if (refusalOf(e)) throw new Refusal(CHANGED, 409, "changed", row);
      const version = versionOf(e, baseOf(ref.owner));
      if (b.version !== version) throw new Refusal(CHANGED, 409, "changed", await liveRow(ref));
      approve(ref.owner, ref.name, version);
      await checkServer(ref.owner, ref.name);
      return c.json(await liveRow(ref), 200, NO_STORE);
    }),
  );

  app.post(
    "/api/mcp/rows/:id/check",
    page(APPROVE_ONLY, async (c) => {
      const ref = refOf(c);
      await liveRow(ref);
      await checkServer(ref.owner, ref.name);
      return c.json(await liveRow(ref), 200, NO_STORE);
    }),
  );

  app.put(
    "/api/mcp/rows/:id/secrets/:name",
    page(APPROVE_ONLY, async (c) => {
      const ref = refOf(c);
      await liveRow(ref);
      const name = c.req.param("name") ?? "";
      const b = await body(c);
      if (!isSecretName(name) || typeof b.value !== "string" || !b.value) throw new Refusal("Expected {value} for a named secret.", 400, "invalid");
      saveSecret(ref.owner, ref.name, name, b.value);
      return c.json(await liveRow(ref), 200, NO_STORE);
    }),
  );

  app.delete(
    "/api/mcp/rows/:id/secrets/:name",
    page(APPROVE_ONLY, async (c) => {
      const ref = refOf(c);
      await liveRow(ref);
      const name = c.req.param("name") ?? "";
      if (!isSecretName(name)) throw new Refusal("That's no secret's name.", 400, "invalid");
      removeSecret(ref.owner, ref.name, name);
      return c.json(await liveRow(ref), 200, NO_STORE);
    }),
  );

  const stateOf = (ref: RowRef, row: McpServerRow): McpSignIn => signInState(ref, () => row);
  app.post(
    "/api/mcp/rows/:id/sign-in",
    page(SIGN_IN_ONLY, async (c) => {
      const ref = refOf(c);
      const row = await liveRow(ref);
      if (row.state === "waiting") throw new Refusal("This server runs nothing until you approve it.", 409, "invalid");
      if (row.kind !== "address") throw new Refusal("Only an address server signs in.", 409, "invalid");
      let run;
      try {
        run = startSignIn(ref);
      } catch (err) {
        throw new Refusal((err as Error).message, 409, "invalid");
      }
      await run.url;
      return c.json(stateOf(ref, row), 200, NO_STORE);
    }),
  );
  app.get(
    "/api/mcp/rows/:id/sign-in",
    page(SIGN_IN_ONLY, async (c) => {
      const ref = refOf(c);
      return c.json(stateOf(ref, await liveRow(ref)), 200, NO_STORE);
    }),
  );
  app.post(
    "/api/mcp/rows/:id/sign-in/address",
    page(SIGN_IN_ONLY, async (c) => {
      const ref = refOf(c);
      const row = await liveRow(ref);
      const b = await body(c);
      if (typeof b.address !== "string" || !b.address.trim()) throw new Refusal("Paste the address from the browser.", 400, "invalid");
      if (!pasteAddress(ref, b.address.trim())) throw new Refusal("No sign-in is running.", 409, "invalid");
      return c.json(stateOf(ref, row), 200, NO_STORE);
    }),
  );
  app.delete(
    "/api/mcp/rows/:id/sign-in",
    page(SIGN_IN_ONLY, async (c) => {
      stopSignIn(refOf(c));
      return c.body(null, 204);
    }),
  );
}

export { rowId };
