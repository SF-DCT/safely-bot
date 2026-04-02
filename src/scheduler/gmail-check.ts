import cron from "node-cron";
import { app } from "../app.js";
import { SLACK_USER_ID } from "../config/env.js";
import { sendGmailDigest } from "../slack-handlers/gmail-sender.js";

/**
 * 毎朝8:30 JST（平日）にGmailチェックを実行
 * ブリーフィング（9:00）の前に配信
 */
export function scheduleGmailCheck(): void {
  cron.schedule(
    "30 8 * * 1-5",
    async () => {
      console.log("[Scheduler] Starting Gmail check...");
      try {
        await sendGmailDigest(app.client, SLACK_USER_ID);
        console.log("[Scheduler] Gmail check completed.");
      } catch (e) {
        console.error("[Scheduler] Gmail check failed:", e);
      }
    },
    { timezone: "Asia/Tokyo" },
  );

  console.log("[Scheduler] Gmail check scheduled: weekdays 8:30 JST");
}
