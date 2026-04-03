import cron from "node-cron";
import { app } from "../app.js";
import { SLACK_USER_ID } from "../config/env.js";
import { sendDailyReportDraft } from "../report/report-sender.js";
import { isBusinessDay } from "../utils/jp-holidays.js";

/**
 * 毎日19:00 JST（平日）に日報ドラフトをDMで送信
 */
export function scheduleDailyReport(): void {
  cron.schedule(
    "0 19 * * 1-5",
    async () => {
      if (!isBusinessDay()) {
        console.log("[Scheduler] Skipping daily report (holiday).");
        return;
      }
      console.log("[Scheduler] Starting daily report draft...");
      try {
        await sendDailyReportDraft(app.client, SLACK_USER_ID);
        console.log("[Scheduler] Daily report draft sent successfully.");
      } catch (e) {
        console.error("[Scheduler] Daily report draft failed:", e);
      }
    },
    { timezone: "Asia/Tokyo" },
  );

  console.log("[Scheduler] Daily report scheduled: weekdays 19:00 JST");
}
