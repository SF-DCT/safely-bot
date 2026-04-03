import cron from "node-cron";
import { app } from "../app.js";
import { SLACK_USER_ID } from "../config/env.js";
import { runEnhancedCvUpload } from "../data-sources/enhanced-cv.js";
import { isBusinessDay } from "../utils/jp-holidays.js";

/**
 * 毎朝9:00 JST（平日）に拡張CVアップロードを実行し、結果をSlack DMで報告
 */
export function scheduleEnhancedCvUpload(): void {
  cron.schedule(
    "0 9 * * 1-5",
    async () => {
      if (!isBusinessDay()) {
        console.log("[Scheduler] Skipping enhanced CV upload (holiday).");
        return;
      }
      console.log("[Scheduler] Starting enhanced CV upload...");
      try {
        const result = await runEnhancedCvUpload(2);

        // Slack DMで結果報告
        const dm = await app.client.conversations.open({
          users: SLACK_USER_ID,
        });
        const channelId = dm.channel?.id;
        if (channelId) {
          await app.client.chat.postMessage({
            channel: channelId,
            text: result,
          });
        }

        console.log("[Scheduler] Enhanced CV upload completed.");
      } catch (e) {
        console.error("[Scheduler] Enhanced CV upload failed:", e);

        // エラー時もDMで通知
        try {
          const dm = await app.client.conversations.open({
            users: SLACK_USER_ID,
          });
          const channelId = dm.channel?.id;
          if (channelId) {
            await app.client.chat.postMessage({
              channel: channelId,
              text: `:x: 拡張CV自動アップロードでエラーが発生しました: ${e instanceof Error ? e.message : String(e)}`,
            });
          }
        } catch {
          // DM送信自体が失敗した場合はログのみ
        }
      }
    },
    { timezone: "Asia/Tokyo" },
  );

  console.log(
    "[Scheduler] Enhanced CV upload scheduled: weekdays 9:00 JST",
  );
}
