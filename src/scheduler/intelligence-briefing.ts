import cron from "node-cron";
import { app } from "../app.js";
import { SLACK_USER_ID } from "../config/env.js";
import { sendBriefing } from "../slack-handlers/briefing-sender.js";
import { isBusinessDay } from "../utils/jp-holidays.js";

/**
 * 毎朝9:00 JST（平日）にインテリジェンスブリーフィングを配信
 */
export function scheduleIntelligenceBriefing(): void {
  cron.schedule(
    "0 9 * * 1-5",
    async () => {
      if (!isBusinessDay()) {
        console.log("[Scheduler] Skipping briefing (holiday).");
        return;
      }
      console.log("[Scheduler] Starting intelligence briefing...");
      try {
        await sendBriefing(app.client, SLACK_USER_ID);
        console.log("[Scheduler] Briefing sent successfully.");
      } catch (e) {
        console.error("[Scheduler] Briefing failed:", e);
      }
    },
    { timezone: "Asia/Tokyo" },
  );

  console.log("[Scheduler] Intelligence briefing scheduled: weekdays 9:00 JST");
}
