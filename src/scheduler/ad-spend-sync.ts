import cron from "node-cron";
import { app } from "../app.js";
import { SLACK_USER_ID } from "../config/env.js";
import { syncAdSpendToSheets } from "../data-sources/ad-spend-sync.js";
/**
 * 広告費自動入力スケジューラ
 * 毎朝 8:00 JST（土日祝含む毎日）に前日の Google Ads 広告費を各PFのスプレッドシートに書き込む
 */
export function scheduleAdSpendSync(): void {
  cron.schedule(
    "0 8 * * *",
    async () => {
      console.log("[Scheduler] Starting ad spend sync...");
      try {
        const report = await syncAdSpendToSheets();
        const dm = await app.client.conversations.open({
          users: SLACK_USER_ID,
        });
        if (dm.channel?.id) {
          await app.client.chat.postMessage({
            channel: dm.channel.id,
            text: report,
          });
        }
        console.log("[Scheduler] Ad spend sync completed.");
      } catch (e) {
        console.error("[Scheduler] Ad spend sync failed:", e);
        try {
          const dm = await app.client.conversations.open({
            users: SLACK_USER_ID,
          });
          if (dm.channel?.id) {
            await app.client.chat.postMessage({
              channel: dm.channel.id,
              text: `⚠️ 広告費自動入力でエラーが発生しました:\n${e instanceof Error ? e.message : String(e)}`,
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
