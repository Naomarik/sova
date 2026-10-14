/**
 * Project minor modes, the contract Sova's server and web app share (pi-config never imports shared/, so the
 * one copy lives in the mode extension and is re-exported here). This module is browser-safe: the format,
 * shapes, id rule and namespace only. The server reads folders with
 * pi-config/extensions/mode/project-discovery.ts (node builtins, no pi).
 */
export * from "../pi-config/extensions/mode/project-format";
