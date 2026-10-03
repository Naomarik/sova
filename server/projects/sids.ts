/**
 * The project layer's statechart session ids (design §2): `project/<p>`, `watch/<p>`, `build/<p>/<s>`,
 * `runtime/<p>`. They name no organization, so a project's sessions keep their ids in any engine.
 * Never parse one: a session's project is its data's `projectId`.
 */
export const projectSid = (projectId: string): string => `project/${projectId}`;
export const watchSid = (projectId: string): string => `watch/${projectId}`;
export const buildSid = (projectId: string, sessionId: string): string => `build/${projectId}/${sessionId}`;
export const runtimeSid = (projectId: string): string => `runtime/${projectId}`;
