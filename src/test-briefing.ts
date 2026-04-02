/**
 * テスト用スクリプト: ダミーデータでブリーフィングをSlack DMに送信
 * 実行: npx tsx src/test-briefing.ts
 */
import { app } from "./app.js";
import { SLACK_USER_ID } from "./config/env.js";
import { sendTestBriefing } from "./slack-handlers/briefing-sender.js";

(async () => {
  console.log("⚡ Starting test briefing...");
  await app.start();
  console.log("✅ Bot connected.");

  try {
    await sendTestBriefing(app.client, SLACK_USER_ID);
    console.log("✅ Test briefing sent to DM!");
  } catch (e) {
    console.error("❌ Failed:", e);
  }

  // 送信後に終了
  await app.stop();
  process.exit(0);
})();
