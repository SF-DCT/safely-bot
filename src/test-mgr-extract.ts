import { WebClient } from "@slack/web-api";
import { env, SLACK_USER_ID } from "./config/env.js";
import {
  extractWeeklyMgrIdeas,
  formatExtractSummaryForSlack,
  formatExtractDetailForSlack,
} from "./data-sources/mgr-idea-extract.js";

/**
 * MGR Weekly idea extraction の手動実行用スクリプト
 *  - Sheets取得 → SF仕分け → (Notion書き込み) → Slack DM送信
 *  - Railway 上で `railway run -- node dist/test-mgr-extract.js` で叩ける
 *  - 環境変数 DRY_RUN=1 を指定すると Slack DM を送らずコンソールのみ出力
 */
async function main() {
  console.log("[Test] Starting MGR weekly idea extraction (manual run)...");
  const dryRun = process.env.DRY_RUN === "1";

  try {
    const result = await extractWeeklyMgrIdeas();
    const summary = formatExtractSummaryForSlack(result);
    const detail = formatExtractDetailForSlack(result);

    console.log("\n--- summary ---");
    console.log(summary);
    console.log("\n--- detail ---");
    console.log(detail);

    if (dryRun) {
      console.log("\n[Test] DRY_RUN=1 のため Slack DM は送信しません。");
      process.exit(0);
    }

    // Slack DM 送信
    const slack = new WebClient(env.SLACK_BOT_TOKEN);
    const dm = await slack.conversations.open({ users: SLACK_USER_ID });
    if (!dm.channel?.id) {
      throw new Error("Failed to open DM channel");
    }

    const parent = await slack.chat.postMessage({
      channel: dm.channel.id,
      text: summary,
    });
    if (detail.trim().length > 0 && parent.ts) {
      await slack.chat.postMessage({
        channel: dm.channel.id,
        text: detail,
        thread_ts: parent.ts,
      });
    }
    console.log("\n[Test] ✅ Slack DM 送信完了");
    console.log(
      `   notionStatus=${result.notionWriteStatus}, sfIdeas=${result.sfIdeas.length}/${result.totalRawIdeas}`,
    );
    process.exit(0);
  } catch (e) {
    console.error("[Test] Extraction failed:", e);
    process.exit(1);
  }
}

main();
