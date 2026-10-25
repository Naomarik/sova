import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { isTourId, isTourOrigin } from "../../shared/tour";
import { privateTourDirectory, readPrivateTourJson, writePrivateTourJson } from "./job";

export interface TourTestAccount { id: string; origin: string; kind: "http-basic"; createdAt: string }
interface StoredAccount extends TourTestAccount { username: string; password: string }
export interface TourAccountInput { origin: string; username: string; password: string; testAccount: true }
const credentialsOk = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(v);
const metadata = (a: TourTestAccount): TourTestAccount => ({ id: a.id, origin: a.origin, kind: "http-basic", createdAt: a.createdAt });

/** Secret fields cannot leak via object spread, JSON.stringify, inspect, or accidental error logging. */
export class TourAccountSecret {
  #account: StoredAccount;
  constructor(account: StoredAccount) { this.#account = { ...account }; }
  toJSON(): TourTestAccount { return metadata(this.#account); }
  [inspect.custom](): string { return "[TourAccountSecret: redacted]"; }
  /** Trusted runner IPC only. Never persist, return through HTTP, or log this projection. */
  credentials(): { origin: string; username: string; password: string } {
    const { origin, username, password } = this.#account;
    return { origin, username, password };
  }
}

/** The only durable password copy: protected host-local storage, excluded from editions and backups. */
export class TourAccountStore {
  constructor(readonly root: string) { privateTourDirectory(root); }
  private read(): StoredAccount[] {
    try {
      const data = readPrivateTourJson(this.root, "test-accounts.json") as { v?: unknown; accounts?: unknown };
      if (data?.v !== 1 || !Array.isArray(data.accounts) || !data.accounts.every(a =>
        a && typeof a === "object" && Object.keys(a).every(k => ["id", "origin", "kind", "createdAt", "username", "password"].includes(k)) &&
        isTourId(a.id) && isTourOrigin(a.origin) && a.kind === "http-basic" && typeof a.createdAt === "string" && Number.isFinite(Date.parse(a.createdAt)) && credentialsOk(a.username) && !a.username.includes(":") && credentialsOk(a.password)
      ) || new Set(data.accounts.map(a => a.id)).size !== data.accounts.length) throw new Error("Invalid test-account state.");
      return data.accounts;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      // JSON parser errors can quote the input; never propagate the underlying exception.
      throw new Error("Test accounts could not be read. Repair the protected host-local account state.");
    }
  }
  list(): TourTestAccount[] { return this.read().map(metadata); }
  save(input: TourAccountInput): TourTestAccount {
    if (input.testAccount !== true || !isTourOrigin(input.origin) || !credentialsOk(input.username) || input.username.includes(":") || !credentialsOk(input.password)) throw new Error("Use a test account with an exact HTTP(S) origin and valid HTTP Basic credentials.");
    const accounts = this.read();
    // One account per exact origin: storing again replaces it in place (same opaque id), so a
    // password is never held twice and every tour of that origin uses the current one.
    const existing = accounts.find(a => a.origin === input.origin);
    const account: StoredAccount = { id: existing?.id ?? randomUUID(), origin: input.origin, kind: "http-basic", createdAt: new Date().toISOString(), username: input.username, password: input.password };
    writePrivateTourJson(this.root, "test-accounts.json", { v: 1, accounts: [...accounts.filter(a => a.origin !== input.origin), account] });
    return metadata(account);
  }
  /** The stored account for exactly this origin; null when none (or, from older state, more than one). */
  forOrigin(origin: string): TourAccountSecret | null {
    if (!isTourOrigin(origin)) return null;
    const matches = this.read().filter(a => a.origin === origin);
    return matches.length === 1 ? new TourAccountSecret(matches[0]!) : null;
  }
  resolve(id: string, origin: string): TourAccountSecret | null {
    if (!isTourId(id) || !isTourOrigin(origin)) return null;
    const account = this.read().find(a => a.id === id && a.origin === origin);
    return account ? new TourAccountSecret(account) : null;
  }
  remove(id: string): void {
    if (!isTourId(id)) throw new Error("Invalid test-account reference.");
    writePrivateTourJson(this.root, "test-accounts.json", { v: 1, accounts: this.read().filter(a => a.id !== id) });
  }
}
