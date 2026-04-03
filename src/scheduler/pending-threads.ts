import cron from "node-cron";
import { app } from "../app.js";
import { SLACK_USER_ID } from "../config/env.js";
import { checkPendingThreads } from "../data-sources/pending-threads.js";

/**
 * 毎朝9:30 JST（平日）に返信待ちスレッドをチェックし、Slack DMで報告
 */
export function schedulePendingThreadsCheck(): void {
  cron.schedule(
    "30 9 * * 1-5",
    async () => {
      console.log("[Scheduler] Starting pending threads check...");
      try {
        const result = await checkPendingThreads();

        const dm = await app.client.conversations.open({
          users: SLACK_USER_ID,
        });
        const channelId = dm.channel?.id;
        if (channelId) {
          await app.client.chat.postMessage({
            channel: channelId,
            text: result,
            mrkdwn: true,
          });
        }

        console.log("[Scheduler] Pending threads check completed.");
      } catch (e) {
        console.error("[Scheduler] Pending threads check failed:", e);

        try {
          const dm = await app.client.conversations.open({
            users: SLACK_USER_ID,
          });
          const channelId = dm.channel?.id;
          if (channelId) {
            await app.client.chat.postMessage({
              channel: channelId,
              text: `:x: 返信待ちスレッドチェックでエラーが発生しました: ${e instanceof Error ? e.message : String(e)}`,
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
    "[Scheduler] Pending threads check scheduled: weekdays 9:30 JST",
  );
}
