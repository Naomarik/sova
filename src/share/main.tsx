import { render } from "solid-js/web";
import "../design/tokens.css";
import "../design/base.css";
import "./share.css";
import "./owner.css";
import { OwnerApp } from "./OwnerApp";
import { SessionShareApp } from "./SessionShareApp";
import { ShareApp } from "./ShareApp";

// The share build (§app.baton/outsider-view, §app.owner-page/page, §app/session-share): its own
// bundle, served only by the share listener. `/i/<token>` is the Owner page; `/s/<token>` a shared
// session; `/h/<token>` one conversation. It imports nothing of the operator app but the design
// CSS, the wire types and pure helpers.
const path = location.pathname;
const App = path.startsWith("/i/") ? OwnerApp : path.startsWith("/s/") ? SessionShareApp : ShareApp;
render(() => <App />, document.getElementById("root")!);
