import { render } from "solid-js/web";
import "./design/tokens.css";
import "./design/base.css";
import "./app.css";
import { App } from "./App";

render(() => <App />, document.getElementById("root")!);
