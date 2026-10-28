// Shared by the in-place sign-in integration files (runner-signin-inplace, runner-signin-midtour): a made-up
// app that draws its sign-in form in place of any page. Not a test file: no glob matches it.
import { once } from "node:events";
import { createServer } from "node:http";
import { PASS, USER, script } from "./runner-signin.integration.fixture";

// A hash-routed app that draws its sign-in form IN PLACE of any page while signed out (200, no redirect,
// no 401, no sign-in route of its own), about 500 ms after its session check; signed in, any route draws
// its page after the same delay. `blank`: signed out it draws neither the form nor a signed-in page.
// Signed in, a page shows a green block (never on the form). `expireAtDocs`: the site ends the session as
// its nth document ("/") loads. `drawOnFillAtDoc`: on that document, filling the page's note box draws the
// sign-in form in place of the signed-in content (no request: a request after a fill is refused).
// `#/reauth`, signed in, draws only a password box named like the sign-in's, with no signed-in heading.
export async function inPlaceApp(mode: { blank?: boolean; lostWhenSignedIn?: boolean; expireAtDocs?: number[]; drawOnFillAtDoc?: number } = {}) {
  let posts = 0, docs = 0, session = "";
  const app = (doc: number) => `<!doctype html><html><head><style>body{margin:0;font:18px sans-serif}h1{margin:0 0 12px}</style></head><body><main id="app"><p>Starting</p></main><script>
    const app = document.getElementById("app");
    const show = async () => {
      // Its sign-in route judges by the token the page kept, not by the server: signed in, it's a "no such page".
      if (${mode.lostWhenSignedIn ? "true" : "false"} && location.hash === "#/login" && localStorage.getItem("token")) { await new Promise(r => setTimeout(r, 500)); app.innerHTML = "<h1>That made-up page no longer exists.</h1>"; return; }
      const me = await fetch("/api/me");
      await new Promise(r => setTimeout(r, 500));
      if (!me.ok) {
        if (${mode.blank ? "true" : "false"}) { app.innerHTML = "<p>Still starting</p>"; return; }
        app.innerHTML = '<form id="f"><label>Username <input name="username"></label><label>Password <input type="password" name="password" data-testid="password"></label><button>Sign in</button></form>';
        document.getElementById("f").addEventListener("submit", e => { e.preventDefault(); const f = e.target; fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: f.username.value, password: f.password.value }) }).then(r => { if (!r.ok) return; localStorage.setItem("token", "made-up"); if (${mode.lostWhenSignedIn ? "true" : "false"} && location.hash === "#/login") location.hash = "#/dashboard"; else show(); }); });
        return;
      }
      if (location.hash === "#/reauth") { app.innerHTML = '<form><label>Confirm <input type="password" data-testid="password"></label></form>'; return; }
      app.innerHTML = '<h1>Your account</h1><div id="ok" style="position:absolute;left:0;top:200px;width:300px;height:40px;background:#00aa00"></div><p>Made-up page ' + (location.hash || "#/") + '</p><details style="position:absolute;left:400px;top:60px"><summary data-testid="more">More</summary><p>More detail</p></details><form style="position:absolute;left:20px;top:300px"><input aria-label="Note" data-note="1"></form>';
    };
    if (${mode.drawOnFillAtDoc === doc ? "true" : "false"}) {
      const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      Object.defineProperty(HTMLInputElement.prototype, "value", { configurable: true, get() { return native.get.call(this); }, set(v) {
        native.set.call(this, v);
        if (this.dataset.note) { document.querySelector("h1")?.remove(); document.getElementById("ok")?.remove(); app.insertAdjacentHTML("beforeend", '<form style="position:absolute;left:20px;top:400px"><label>Username <input name="username"></label><label>Password <input type="password" name="password" data-testid="password"></label><button>Sign in</button></form>'); }
      } });
    }
    addEventListener("hashchange", show); show();
  </script></body></html>`;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/api/me") { res.statusCode = session && (req.headers.cookie ?? "").includes(`sid=${session}`) ? 200 : 401; res.end("{}"); return; }
    if (url.pathname === "/api/login" && req.method === "POST") {
      posts++;
      const body = await new Promise<string>(r => { let b = ""; req.on("data", c => { b += c; }); req.on("end", () => r(b)); });
      const v = JSON.parse(body || "{}") as Record<string, string>;
      if (v.username !== USER || v.password !== PASS) { res.statusCode = 401; res.end(); return; }
      session = `s${Math.random()}`; res.setHeader("set-cookie", `sid=${session}; Path=/; HttpOnly`); res.end("{}"); return;
    }
    if (url.pathname === "/") { docs++; if (mode.expireAtDocs?.includes(docs)) session = "ended-by-the-site"; }
    res.setHeader("content-type", "text/html"); res.end(app(docs));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, posts: () => posts, docs: () => docs, expire: () => { session = "ended-by-the-site"; }, close: () => { server.closeAllConnections(); server.close(); } };
}
export const inPlace = (origin: string) => { const s = script(origin, ["/#/dashboard"]); s.signIn!.route = "/#/login"; return s; };
