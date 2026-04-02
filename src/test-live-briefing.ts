/**
 * テスト用スクリプト: 実際のWeb検索でブリーフィングを送信
 * 実行: npx tsx src/test-live-briefing.ts
 */
import { app } from "./app.js";
import { SLACK_USER_ID } from "./config/env.js";
import { sendBriefing } from "./slack-handlers/briefing-sender.js";

(async () => {
  console.log("⚡ Starting live briefing test...");
  await app.start();
  console.log("✅ Bot connected.");

  try {
    await sendBriefing(app.client, SLACK_USER_ID);
    console.log("✅ Live briefing sent to DM!");
  } catch (e) {
    console.error("❌ Failed:", e);
  }

  await app.stop();
  process.exit(0);
})();
