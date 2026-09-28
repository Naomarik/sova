import type { VisBase } from "./core/grammar";
import type { ViewProps } from "./types";

/**
 * The View of a registered kind nobody has drawn yet: a calm line instead of a picture. The shell's
 * Source toggle still shows what the model wrote. A kind leaves this behind by getting its own View.
 */
export default function StubView(props: ViewProps<VisBase & { kind: string }>) {
  return <p class="vis-stub">This {props.spec.kind} visual isn't drawn yet. Source shows what was written.</p>;
}
