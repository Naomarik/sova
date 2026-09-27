// The share page's tab id (§app.baton/visits): a random value made once per browser tab and kept
// in sessionStorage, so a reload, a socket reconnect or a server restart continues the same visit
// instead of starting a new one. It grants nothing and means nothing outside the visit log. Sent as
// `?v=` on `/api/h/<token>` and `/ws/h`; the server ignores a value of any other shape.

const KEY = "sova:share-visit";
export const VISIT_TAB_RE = /^[A-Za-z0-9_-]{22}$/;

/** 16 random bytes as 22 base64url characters. */
export function newVisitTab(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const bytes = random(new Uint8Array(16));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** This tab's id: the stored one when it has the right shape, else a new one (stored when it can
    be; a blocked or full sessionStorage still gets an id, for this page load only). */
export function visitTab(store: Pick<Storage, "getItem" | "setItem"> | null, make: () => string = newVisitTab): string {
  let cur: string | null = null;
  try {
    cur = store?.getItem(KEY) ?? null;
  } catch {
    /* blocked */
  }
  if (cur && VISIT_TAB_RE.test(cur)) return cur;
  const v = make();
  try {
    store?.setItem(KEY, v);
  } catch {
    /* blocked or full */
  }
  return v;
}
