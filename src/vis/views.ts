// Every kind's View in one module, so one chunk: the first visual on a page loads them all, and a
// second kind never pops in on its own later. registry.ts imports this lazily, keeping itself (and
// markdown.ts, which parses through it) free of Solid and CSS.
export { default as chart } from "./kinds/chart/View";
export { default as code } from "./kinds/code/View";
export { default as flow } from "./kinds/flow/View";
export { default as frame } from "./kinds/frame/View";
export { default as layers } from "./kinds/layers/View";
export { default as matrix } from "./kinds/matrix/View";
export { default as sequence } from "./kinds/sequence/View";
export { default as timeline } from "./kinds/timeline/View";
export { default as tree } from "./kinds/tree/View";
