// The Views a share or owner page draws (src/share/vis.tsx), in one chunk of the share build: the
// business kinds, sequence and state (flow's View), and the html frame, which on a share page loads
// the static frame host (the page's CSP runs no inline script, so no srcdoc). Never the code kind
// (it brings the chat's highlighter).
export { default as chart } from "./kinds/chart/View";
export { default as flow } from "./kinds/flow/View";
export { default as html } from "./kinds/frame/View";
export { default as state } from "./kinds/flow/View";
export { default as layers } from "./kinds/layers/View";
export { default as matrix } from "./kinds/matrix/View";
export { default as sequence } from "./kinds/sequence/View";
export { default as steps } from "./kinds/steps/View";
export { default as timeline } from "./kinds/timeline/View";
export { default as tree } from "./kinds/tree/View";
export { default as wireframe } from "./kinds/wireframe/View";
