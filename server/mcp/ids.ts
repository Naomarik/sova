// A row's opaque id: computer + name, or project + checkout + name, URL-safe.
import type { McpOwner } from "./trust";

export interface RowRef {
  owner: McpOwner;
  name: string;
}

export function rowId({ owner, name }: RowRef): string {
  const parts = owner.kind === "computer" ? ["c", name] : ["p", owner.projectId, owner.checkout, name];
  return Buffer.from(JSON.stringify(parts)).toString("base64url");
}

/** The ref an id names, or null when it is no id of ours. Where it points is the caller's to check. */
export function parseRowId(id: string): RowRef | null {
  try {
    const parts = JSON.parse(Buffer.from(id, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parts) || !parts.every((p) => typeof p === "string" && p)) return null;
    if (parts[0] === "c" && parts.length === 2) return { owner: { kind: "computer" }, name: parts[1] };
    if (parts[0] === "p" && parts.length === 4) return { owner: { kind: "project", projectId: parts[1], checkout: parts[2] }, name: parts[3] };
  } catch {
    // not ours
  }
  return null;
}
