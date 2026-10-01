import cron from "node-cron";
import { app } from "../app.js";
import { enqueueJob } from "../data-sources/llm-jobs.js";

/**
 * MGR Weekly MTG「3.アイディアから吸い上げ」自動更新
 * 毎週金曜 14:00 JST に PC の worker へ依頼する（SF アイディアの仕分けに Claude を使うため）。
 * 実処理は data-sources/mgr-idea-extract.ts の runMgrIdeaExtractAndNotify。
 */
export function scheduleMgrIdeaExtract(): void {
  cron.schedule(
    "0 14 * * 5",
    async () => {
      try {
        await enqueueJob(app.client, "mgr_extract");
        console.log("[Scheduler] MGR weekly idea extraction requested to PC worker.");
      } catch (e) {
        console.error("[Scheduler] MGR idea extraction request failed:", e);
      }
    },
    { timezone: "Asia/Tokyo" },
  );
}
