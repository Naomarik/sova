import { render } from "solid-js/web";
import "../design/tokens.css";
import "../design/base.css";
import "./share.css";
import { ShareApp } from "./ShareApp";

// The share page (§app.baton/outsider-view): its own build, served only by the share listener.
// It imports nothing of the operator app but the design CSS and the wire types.
render(() => <ShareApp />, document.getElementById("root")!);
