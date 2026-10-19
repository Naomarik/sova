import { projectTourPublic, type TourManifest, type TourPresentation } from "../../shared/tour";
import { redactShareLinks } from "../link-tokens";
import { serverRedactor } from "../overseer-redact";
/** Redact display strings only: never change inventory names, hashes or structural identities. */
export function publicTour(manifest: TourManifest, ids: { id: string; editionId: string }, phrase: (text: string) => string = x => x): TourPresentation {
  const m = projectTourPublic(manifest, ids), secrets = serverRedactor();
  const text = (s: string) => phrase(redactShareLinks(secrets.redact(s)));
  m.title = text(m.title); m.summary = text(m.summary);
  for (const c of m.chapters) c.title = text(c.title);
  for (const s of m.steps) {
    s.title = text(s.title); s.summary = text(s.summary);
    for (const v of s.views) {
      v.title = text(v.title); v.note = text(v.note);
      if (v.reference !== undefined) v.reference = text(v.reference);
      if (v.unavailableReason !== undefined) v.unavailableReason = text(v.unavailableReason);
      for (const capture of Object.values(v.captures)) for (const mark of capture.marks) mark.label = text(mark.label);
    }
  }
  return m;
}
