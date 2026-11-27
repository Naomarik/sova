/**
 * The server's automatic archive compression (§app.session-list/archive-compression "On its own"),
 * wired to the last listing's rows, Clean Up's compress and Settings' switch (storage.autoCompress,
 * on by default). Lab knobs, for test copies only: SOVA_ARCHIVE_COMPRESS_AGE_DAYS (default 60) and
 * SOVA_ARCHIVE_COMPRESS_FIRST_MS (the first pass, default 10 minutes after start).
 */
import { cleanupSessions, lastListedRows, listSessions } from "../sessions-index";
import { autoCompressOn } from "../web-settings";
import { AUTO_AGE_DAYS, autoCandidates, FIRST_PASS_MS, startAutoCompress } from "./auto";
import { finishPending } from "./compress";

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
};

export function startArchiveCompression(env: Record<string, string | undefined> = process.env): () => void {
  try {
    const n = finishPending();
    if (n > 0) console.log(`[archive] finished ${n} compressions cut short`);
  } catch (err) {
    console.warn(`[archive] couldn't finish compressions cut short: ${err instanceof Error ? err.message : String(err)}`);
  }
  const ageDays = num(env.SOVA_ARCHIVE_COMPRESS_AGE_DAYS, AUTO_AGE_DAYS);
  const auto = startAutoCompress({
    enabled: autoCompressOn,
    // The last listing's rows; none yet (no window has listed since the start): one listing of its own.
    rows: () => (lastListedRows().size > 0 ? lastListedRows().values() : listSessions()),
    candidates: (rows) => autoCandidates(rows, Date.now(), ageDays),
    run: async (paths) => {
      const r = await cleanupSessions({ mode: "paths", paths, dryRun: false, action: "compress", by: "auto" });
      return { compressedIds: r.compressedIds ?? [] };
    },
    firstMs: num(env.SOVA_ARCHIVE_COMPRESS_FIRST_MS, FIRST_PASS_MS),
  });
  return auto.stop;
}
