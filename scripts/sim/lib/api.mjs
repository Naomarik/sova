// The operator's REST API (x-sova-token) and the share listener's outsider API, as the simulation
// uses them. Only routes that exist today; the contracts ARCH.md defines plug in through scenario
// hooks (scripts/sim/run.mjs), never guessed here.
export function api({ port, token }) {
  const base = `http://127.0.0.1:${port}`;
  async function call(method, path, body) {
    const r = await fetch(base + path, {
      method,
      headers: { "x-sova-token": token, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    if (!r.ok) {
      const e = new Error(`${method} ${path} → ${r.status}: ${text.slice(0, 400)}`);
      e.status = r.status;
      e.body = json;
      throw e;
    }
    return json;
  }
  return {
    base,
    call,
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b ?? {}),
    put: (p, b) => call("PUT", p, b ?? {}),
    patch: (p, b) => call("PATCH", p, b ?? {}),
  };
}

export function share({ sharePort }) {
  const base = `http://127.0.0.1:${sharePort}`;
  return {
    base,
    async view(token) {
      const r = await fetch(`${base}/api/h/${token}`);
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    async send(token, text) {
      const r = await fetch(`${base}/api/h/${token}/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
  };
}

/** A link URL's token: the last path segment. */
export const tokenOf = (url) => String(url).replace(/[?#].*$/, "").split("/").filter(Boolean).at(-1);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
