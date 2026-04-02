import { app } from "./app.js";
import { SLACK_USER_ID } from "./config/env.js";
import { scheduleIntelligenceBriefing } from "./scheduler/intelligence-briefing.js";
import {
  sendBriefing,
  sendTestBriefing,
} from "./slack-handlers/briefing-sender.js";
import { routeIntent } from "./tools/intent-router.js";
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

  // DMメッセージ → Intent Routerで応答
  try {
    const result = await routeIntent(message.text);

    if (result.specialAction === "briefing") {
      await say(result.text);
      await sendBriefing(app.client, SLACK_USER_ID);
      return;
    }
    if (result.specialAction === "test_briefing") {
      await say(result.text);
      await sendTestBriefing(app.client, SLACK_USER_ID);
      return;
    }

    await say(result.text);
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
      await say(result.text);
      await sendBriefing(app.client, SLACK_USER_ID);
      return;
    }
    if (result.specialAction === "test_briefing") {
      await say(result.text);
      await sendTestBriefing(app.client, SLACK_USER_ID);
      return;
    }

    await say(result.text);
  } catch (e) {
    console.error("[Intent Router] Error:", e);
    await say("すみません、エラーが発生しました。もう一度お試しください。");
  }
});

// Start the app
(async () => {
  // Bot自身のUser IDを取得
  const authResult = await app.client.auth.test();
  botUserId = authResult.user_id || "";
  console.log(`🤖 Bot User ID: ${botUserId}`);

  scheduleIntelligenceBriefing();

  await app.start();
  console.log("⚡ SAFELY Bot is running!");
  console.log("🧠 Claude tool use: enabled");
  console.log("👀 Proactive observer: watching channels");
  console.log("📰 Intelligence briefing: weekdays 9:00 JST");
})();
