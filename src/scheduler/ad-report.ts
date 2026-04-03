import cron from "node-cron";
import { app } from "../app.js";
import { SLACK_USER_ID } from "../config/env.js";
import { generateDailyAdReport } from "../data-sources/ad-report.js";
/**
 * 日次広告レポートスケジューラ
 * 毎朝 9:05 JST（土日祝含む毎日）にスプレッドシートからデータを読み取り、
 * 異常検知レポートをSlack DMに投稿する
 */
export function scheduleAdReport(): void {
  cron.schedule(
    "5 9 * * *",
    async () => {
      console.log("[Scheduler] Starting ad report generation...");
      try {
        const report = await generateDailyAdReport();
        const dm = await app.client.conversations.open({
          users: SLACK_USER_ID,
        });
        if (dm.channel?.id) {
          await app.client.chat.postMessage({
            channel: dm.channel.id,
            text: report,
          });
        }
        console.log("[Scheduler] Ad report posted.");
      } catch (e) {
        console.error("[Scheduler] Ad report failed:", e);
        try {
          const dm = await app.client.conversations.open({
            users: SLACK_USER_ID,
          });
          if (dm.channel?.id) {
            await app.client.chat.postMessage({
              channel: dm.channel.id,
              text: `⚠️ 広告日次レポート生成でエラーが発生しました:\n${e instanceof Error ? e.message : String(e)}`,
            });
          }
        } catch {
          // DM送信自体が失敗した場合はログのみ
        }
      }
    },
    { timezone: "Asia/Tokyo" },
  );
}
