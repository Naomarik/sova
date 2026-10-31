import type { JSX } from "solid-js";
import { Icon } from "./ui";

/** A one-line note in the transcript: the info icon and its text. */
export function InfoRow(props: { children: JSX.Element }) {
  return (
    <div class="info-row" role="note">
      <span class="info-row-text">
        <Icon name="info" small />
        <span>{props.children}</span>
      </span>
    </div>
  );
}
