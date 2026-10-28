import { obj, Refusal, str } from "./project-overseer-tools";
import { whatsappTool } from "./overseer-whatsapp";
import { contributeProjectPart, spaceOf } from "./projects/contributions";

/**
 * Outreach's part of every project (§app.outreach/overseer-sender): the project overseer's `sova_whatsapp`, the
 * sender its organization sends through (this host's default for a standalone project). Contributed, because the
 * project layer never reaches outreach (§app.projects/seam). Status in any run; Start Sender only in a run the
 * operator started. The tool logs each call in the overseer's activity itself, naming the sender by its label.
 */

/** sova_whatsapp start in a run the operator did not start. */
export const WA_START_OPERATOR = "Starting the WhatsApp sender is the operator's: ask them in your reply or with sova_card.";

contributeProjectPart({
  overseerTools: (ctx) => [
    whatsappTool({
      who: "project",
      orgOf: () => {
        const space = spaceOf(ctx.engine, ctx.projectId);
        return space.kind === "org" ? space.orgId : null;
      },
      attended: () => ctx.attended(),
      unattendedRefusal: WA_START_OPERATOR,
      overseerId: () => ctx.overseerId(),
      actionsFile: () => ctx.paths.actions,
      refusal: (m) => new Refusal(m),
      obj,
      str,
    }),
  ],
});
