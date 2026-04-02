import { app } from "./app.js";
import { SLACK_USER_ID } from "./config/env.js";
import { scheduleIntelligenceBriefing } from "./scheduler/intelligence-briefing.js";
import {
  sendBriefing,
  sendTestBriefing,
} from "./slack-handlers/briefing-sender.js";

// DM message handler
app.message(async ({ message, say }) => {
  // Only respond to user messages (not bot messages)
  if (message.subtype) return;

  if ("text" in message && message.text) {
    const text = message.text.toLowerCase();

    if (text.includes("hello") || text.includes("こんにちは")) {
      await say(
        "こんにちは！SAFELY Botです。\n以下のコマンドが使えます：\n• 「ブリーフィング」— 今日のインテリジェンスブリーフィングを取得\n• 「テストブリーフィング」— テスト用ダミーデータでブリーフィングを表示\n• 「日報作成」— 日報ドラフトを生成（開発中）",
      );
    } else if (
      text.includes("テストブリーフィング") ||
      text.includes("テスト")
    ) {
      await say("テストブリーフィングを生成中...");
      try {
        await sendTestBriefing(app.client, SLACK_USER_ID);
      } catch (e) {
        console.error("[Test Briefing] Error:", e);
        await say(`エラーが発生しました: ${e}`);
      }
    } else if (text.includes("ブリーフィング")) {
      await say("インテリジェンスブリーフィングを生成中...");
      try {
        await sendBriefing(app.client, SLACK_USER_ID);
      } catch (e) {
        console.error("[Briefing] Error:", e);
        await say(`エラーが発生しました: ${e}`);
      }
    } else if (text.includes("日報作成")) {
      await say("日報作成機能は現在開発中です！もう少しお待ちください。");
    } else {
      await say(
        "メッセージを受け取りました！以下のコマンドが使えます：\n• 「ブリーフィング」— 今日のインテリジェンスブリーフィングを取得\n• 「テストブリーフィング」— テスト用ダミーデータでブリーフィング表示\n• 「日報作成」— 日報ドラフト生成（開発中）",
      );
    }
  }
});

// App mention handler — チャンネルでもメンションで応答
app.event("app_mention", async ({ event, say }) => {
  const text = (event.text || "").toLowerCase();

  if (text.includes("テストブリーフィング") || text.includes("テスト")) {
    await say("テストブリーフィングを生成中...");
    try {
      await sendTestBriefing(app.client, SLACK_USER_ID);
    } catch (e) {
      console.error("[Test Briefing] Error:", e);
      await say(`エラーが発生しました: ${e}`);
    }
  } else if (text.includes("ブリーフィング")) {
    await say("インテリジェンスブリーフィングを生成中...");
    try {
      await sendBriefing(app.client, SLACK_USER_ID);
    } catch (e) {
      console.error("[Briefing] Error:", e);
      await say(`エラーが発生しました: ${e}`);
    }
  } else if (text.includes("日報作成")) {
    await say("日報作成機能は現在開発中です！もう少しお待ちください。");
  } else {
    await say(
      `<@${event.user}> はい！以下のコマンドが使えます：\n• 「ブリーフィング」— 今日のインテリジェンスブリーフィングを取得\n• 「テストブリーフィング」— テスト用ダミーデータでブリーフィング表示\n• 「日報作成」— 日報ドラフト生成（開発中）`,
    );
  }
});

// Start the app
(async () => {
  // Register scheduled jobs
  scheduleIntelligenceBriefing();

  await app.start();
  console.log("⚡ SAFELY Bot is running!");
  console.log("📰 Intelligence briefing: weekdays 9:00 JST");
  console.log("💬 DM commands: ブリーフィング / テストブリーフィング / 日報作成");
})();
