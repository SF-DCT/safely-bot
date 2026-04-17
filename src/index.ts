import { app } from "./app.js";
import { env, SLACK_USER_ID, SLACK_REPORT_CHANNEL } from "./config/env.js";
import { scheduleIntelligenceBriefing } from "./scheduler/intelligence-briefing.js";
import { scheduleGmailCheck } from "./scheduler/gmail-check.js";
import { scheduleDailyReport } from "./scheduler/daily-report.js";
import { scheduleEnhancedCvUpload } from "./scheduler/enhanced-cv.js";
import { scheduleAdSpendSync } from "./scheduler/ad-spend-sync.js";
import { scheduleAdReport } from "./scheduler/ad-report.js";
import { schedulePendingThreadsCheck } from "./scheduler/pending-threads.js";
import { initDatabase } from "./data-sources/database.js";
import { seedScenarios } from "./scenario/seed.js";
import { scheduleScenarioEngine } from "./scheduler/scenario-engine.js";
import {
  sendBriefing,
  sendTestBriefing,
} from "./slack-handlers/briefing-sender.js";
import {
  sendDailyReportDraft,
  postApprovedReport,
  getPendingDraft,
  clearPendingDraft,
  setEditMode,
  handleEditFeedback,
} from "./report/report-sender.js";
import { routeIntent } from "./tools/intent-router.js";
import { toSlackMrkdwn } from "./utils/slack-format.js";
import {
  isWatchedChannel,
  observeAndMaybeRespond,
} from "./tools/proactive-observer.js";

let botUserId = "";

// DM message handler — Claude tool useで自然な会話
app.message(async ({ message, say }) => {
  if (message.subtype) return;
  if (!("text" in message) || !message.text) return;
  if (!("user" in message)) return;

  // 監視対象チャンネルのメッセージ → オブザーバーに渡す
  if ("channel" in message && isWatchedChannel(message.channel)) {
    await observeAndMaybeRespond(
      app.client,
      message.channel,
      message.user,
      message.text,
      message.ts,
      botUserId,
    );
    return;
  }

  // 日報修正モード中なら、メッセージを修正指示として扱う
  const pendingState = getPendingDraft(message.user);
  if (pendingState?.editing && "channel" in message) {
    try {
      await handleEditFeedback(
        app.client,
        message.user,
        message.channel,
        message.text,
      );
    } catch (e) {
      console.error("[DailyReport] Edit error:", e);
      await say("修正の反映中にエラーが発生しました。もう一度お試しください。");
    }
    return;
  }

  // DMメッセージ → Intent Routerで応答
  try {
    const result = await routeIntent(message.text);

    if (result.specialAction === "briefing") {
      await say(toSlackMrkdwn(result.text));
      await sendBriefing(app.client, SLACK_USER_ID);
      return;
    }
    if (result.specialAction === "test_briefing") {
      await say(toSlackMrkdwn(result.text));
      await sendTestBriefing(app.client, SLACK_USER_ID);
      return;
    }
    if (result.specialAction === "daily_report") {
      await say(toSlackMrkdwn(result.text));
      await sendDailyReportDraft(app.client, SLACK_USER_ID);
      return;
    }

    await say(toSlackMrkdwn(result.text));
  } catch (e) {
    console.error("[Intent Router] Error:", e);
    await say("すみません、エラーが発生しました。もう一度お試しください。");
  }
});

// App mention handler — チャンネルでもClaude tool useで応答
app.event("app_mention", async ({ event, say }) => {
  const text = (event.text || "").replace(/<@[^>]+>/g, "").trim();
  if (!text) {
    await say(`<@${event.user}> 何かお手伝いできることはありますか？`);
    return;
  }

  try {
    const result = await routeIntent(text);

    if (result.specialAction === "briefing") {
      await say(toSlackMrkdwn(result.text));
      await sendBriefing(app.client, SLACK_USER_ID);
      return;
    }
    if (result.specialAction === "test_briefing") {
      await say(toSlackMrkdwn(result.text));
      await sendTestBriefing(app.client, SLACK_USER_ID);
      return;
    }
    if (result.specialAction === "daily_report") {
      await say(toSlackMrkdwn(result.text));
      await sendDailyReportDraft(app.client, event.user || SLACK_USER_ID);
      return;
    }

    await say(toSlackMrkdwn(result.text));
  } catch (e) {
    console.error("[Intent Router] Error:", e);
    await say("すみません、エラーが発生しました。もう一度お試しください。");
  }
});

// --- 日報 Block Kit ボタンハンドラー ---

app.action("daily_report_approve", async ({ ack, body }) => {
  await ack();
  const userId = body.user.id;
  try {
    const ts = await postApprovedReport(app.client, userId);
    const dm = await app.client.conversations.open({ users: userId });
    const channelId = dm.channel?.id;
    if (channelId) {
      await app.client.chat.postMessage({
        channel: channelId,
        text: ts
          ? ":white_check_mark: 日報を <#" + SLACK_REPORT_CHANNEL + "> に投稿しました！"
          : ":warning: 保留中のドラフトが見つかりませんでした。",
      });
    }
  } catch (e) {
    console.error("[DailyReport] Approve error:", e);
  }
});

app.action("daily_report_edit", async ({ ack, body }) => {
  await ack();
  const userId = body.user.id;
  setEditMode(userId, true);
  try {
    const dm = await app.client.conversations.open({ users: userId });
    const channelId = dm.channel?.id;
    if (channelId) {
      await app.client.chat.postMessage({
        channel: channelId,
        text: ":pencil2: 修正内容をメッセージで送ってください。（例: 「MTGにXX会議を追加」「不足欄を○○に変更」）",
      });
    }
  } catch (e) {
    console.error("[DailyReport] Edit mode error:", e);
  }
});

app.action("daily_report_cancel", async ({ ack, body }) => {
  await ack();
  const userId = body.user.id;
  clearPendingDraft(userId);
  try {
    const dm = await app.client.conversations.open({ users: userId });
    const channelId = dm.channel?.id;
    if (channelId) {
      await app.client.chat.postMessage({
        channel: channelId,
        text: ":x: 日報の作成をキャンセルしました。",
      });
    }
  } catch (e) {
    console.error("[DailyReport] Cancel error:", e);
  }
});

// Start the app
(async () => {
  // Bot自身のUser IDを取得
  const authResult = await app.client.auth.test();
  botUserId = authResult.user_id || "";
  console.log(`🤖 Bot User ID: ${botUserId}`);

  // シナリオエンジン初期化（DB接続 + シード）
  if (env.DATABASE_URL) {
    try {
      await initDatabase();
      await seedScenarios();
      scheduleScenarioEngine();
    } catch (e) {
      console.error("[Startup] Scenario engine init failed:", e);
    }
  }

  scheduleIntelligenceBriefing();
  // scheduleGmailCheck(); // 一時停止 2026-04-17 精度改善のため回収
  // scheduleDailyReport(); // 一時停止 2026-04-17 精度改善のため回収
  scheduleEnhancedCvUpload();
  scheduleAdSpendSync();
  scheduleAdReport();
  // schedulePendingThreadsCheck(); // 一時停止 2026-04-17 精度改善のため回収

  await app.start();
  console.log("⚡ SAFELY Bot is running!");
  console.log("🧠 Claude tool use: enabled");
  console.log("👀 Proactive observer: watching channels");
  console.log("📰 Intelligence briefing: weekdays 9:00 JST");
  //   console.log("📬 Gmail check: weekdays 8:30 JST"); // 一時停止
  //   console.log("💬 Pending threads check: weekdays 9:30 JST"); // 一時停止
  //   console.log("📝 Daily report: weekdays 19:00 JST"); // 一時停止
  console.log("📊 Enhanced CV upload: weekdays 9:00 JST");
  console.log("📈 Ad spend sync: weekdays 8:00 JST");
  console.log("📊 Ad report: weekdays 9:05 JST");
  if (env.DATABASE_URL) {
    console.log("🔄 Scenario engine: every 5 minutes");
  }
})();
