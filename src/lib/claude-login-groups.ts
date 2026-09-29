import { shortDate } from "./format";

// Claude logins by account (§app.claude-logins/registry, "Accounts, then logins" and "Names"):
// Settings → Accounts' blocks and the Usage page's account cards. The server already sends every
// order with each account's logins together (accounts.ts groupByAccount); these fold such a list
// into its accounts, move an account or a login inside one, and name a login. Pure.

/** What the helpers read of a login, from any of the wire shapes (a registry row, a pool login, a Usage login). */
export interface LoginFacts {
  id: string;
  label?: string;
  addedAt?: number;
  account?: string;
}

/** One account's logins, in their order; `key` is the account, else the login's own id. */
export interface AccountGroup<T> {
  key: string;
  logins: T[];
}

/** The logins of one account together, each account where its first login falls, in their order. */
export function accountGroups<T>(logins: readonly T[], facts: (l: T) => LoginFacts): AccountGroup<T>[] {
  const groups: AccountGroup<T>[] = [];
  const byAccount = new Map<string, AccountGroup<T>>();
  for (const l of logins) {
    const f = facts(l);
    const group = f.account ? byAccount.get(f.account) : undefined;
    if (group) {
      group.logins.push(l);
      continue;
    }
    const fresh = { key: f.account ?? f.id, logins: [l] };
    groups.push(fresh);
    if (f.account) byAccount.set(f.account, fresh);
  }
  return groups;
}

const ids = <T>(groups: readonly AccountGroup<T>[], facts: (l: T) => LoginFacts) => groups.flatMap((g) => g.logins.map((l) => facts(l).id));

/** The whole order with account `index` moved by one place, or null at an end. */
export function moveAccount<T>(groups: readonly AccountGroup<T>[], index: number, by: -1 | 1, facts: (l: T) => LoginFacts): string[] | null {
  const to = index + by;
  if (index < 0 || index >= groups.length || to < 0 || to >= groups.length) return null;
  const next = [...groups];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return ids(next, facts);
}

/** The whole order with login `login` of account `index` moved by one place inside its account, or null at an end. */
export function moveLogin<T>(groups: readonly AccountGroup<T>[], index: number, login: number, by: -1 | 1, facts: (l: T) => LoginFacts): string[] | null {
  const group = groups[index];
  const to = login + by;
  if (!group || login < 0 || login >= group.logins.length || to < 0 || to >= group.logins.length) return null;
  const logins = [...group.logins];
  [logins[login], logins[to]] = [logins[to]!, logins[login]!];
  return ids(groups.map((g, i) => (i === index ? { ...g, logins } : g)), facts);
}

/**
 * A login's name: its label; `default` is "Claude Code's own login"; else "Login N", N its place
 * among `account`'s logins (itself included) by when they were added, the oldest first.
 */
export function loginName(login: LoginFacts, account: readonly LoginFacts[]): string {
  if (login.label) return login.label;
  if (login.id === "default") return "Claude Code's own login";
  const added = account.filter((l) => l.id !== "default").sort((a, b) => (a.addedAt ?? Infinity) - (b.addedAt ?? Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const n = added.findIndex((l) => l.id === login.id);
  return `Login ${n < 0 ? added.length + 1 : n + 1}`;
}

/** "added Sep 29" (the year when it isn't this one), or null when unknown. */
export function addedText(addedAt: number | undefined, now = Date.now()): string | null {
  return addedAt === undefined ? null : `added ${shortDate(addedAt, now)}`;
}

/** "2 logins share one quota" for an account of several logins, else null. */
export function sharedQuotaText(n: number): string | null {
  return n > 1 ? `${n} logins share one quota` : null;
}
