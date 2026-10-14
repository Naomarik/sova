/** A refusal a route answers with its status and sentence (`code`: one the client acts on by name). Its
    own module, so the org engine's glue can throw it without importing server/orgs.ts. */
export class OrgError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 410 = 400,
    /** A refusal the client acts on by name (`held`: attach an org another host holds). */
    readonly code?: string,
    /** What the overseer's model reads after the sentence (a statechart refusal's `tail`); never shown on the page. */
    readonly tail?: string,
  ) {
    super(message);
  }
}
