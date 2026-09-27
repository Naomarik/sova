import { render } from "solid-js/web";
import "../design/tokens.css";
import "../design/base.css";
import "./share.css";
import "./owner.css";
import { OwnerApp } from "./OwnerApp";
import { ShareApp } from "./ShareApp";

// The share build (§app.baton/outsider-view, §app.owner-page/page): its own bundle, served only by
// the share listener. `/i/<token>` is the Owner page; `/h/<token>` one conversation. It imports
// nothing of the operator app but the design CSS, the wire types and pure helpers.
const owner = location.pathname.startsWith("/i/");
render(() => (owner ? <OwnerApp /> : <ShareApp />), document.getElementById("root")!);
