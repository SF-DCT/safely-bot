import cron from "node-cron";
import { app } from "../app.js";
import { SLACK_USER_ID } from "../config/env.js";
import {
  extractWeeklyMgrIdeas,
  formatExtractSummaryForSlack,
  formatExtractDetailForSlack,
} from "../data-sources/mgr-idea-extract.js";

/**
 * MGR Weekly MTG「3.アイディアから吸い上げ」自動更新
 * 毎週金曜 14:00 JST に各メンバー日報からSFアイディアを抽出し、
 * 最新MGRページに書き込み + Slack DMにも全内容を送信。
 *
 * NOTION_API_KEY 未設定時はNotion書き込みをスキップし、Slack DMのみで完結。
 */
export function scheduleMgrIdeaExtract(): void {
  cron.schedule(
    "0 14 * * 5",
    async () => {
      console.log("[Scheduler] Starting MGR weekly idea extraction...");
      try {
        const result = await extractWeeklyMgrIdeas();

        const summary = formatExtractSummaryForSlack(result);
        const detail = formatExtractDetailForSlack(result);

        const dm = await app.client.conversations.open({
          users: SLACK_USER_ID,
        });
        if (dm.channel?.id) {
          // サマリ
          const parent = await app.client.chat.postMessage({
            channel: dm.channel.id,
            text: summary,
          });
          // 詳細をスレッドに（Slackの4000字制限回避＋見やすさ）
          if (detail.trim().length > 0 && parent.ts) {
            await app.client.chat.postMessage({
              channel: dm.channel.id,
              text: detail,
              thread_ts: parent.ts,
            });
          }
        }
        console.log(
          `[Scheduler] MGR idea extraction posted. (notionStatus=${result.notionWriteStatus}, sfIdeas=${result.sfIdeas.length})`,
        );
      } catch (e) {
        console.error("[Scheduler] MGR idea extraction failed:", e);
        try {
          const dm = await app.client.conversations.open({
            users: SLACK_USER_ID,
          });
          if (dm.channel?.id) {
            await app.client.chat.postMessage({
              channel: dm.channel.id,
              text: `⚠️ MGR金曜アイディア抽出でエラー: \n${e instanceof Error ? e.message : String(e)}`,
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
