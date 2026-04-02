import type { WebClient } from "@slack/web-api";
import { curateBriefing, curateBriefingFallback } from "../data-sources/briefing-curator.js";
import { collectAllSources } from "../data-sources/intelligence-collector.js";
import { env } from "../config/env.js";
import {
  createTestBriefing,
  formatBriefingForSlack,
} from "../templates/intelligence-briefing.js";
import { formatDateJapanese } from "../utils/date-formatter.js";

/**
 * ブリーフィングを生成してSlack DMに送信
 */
export async function sendBriefing(
  client: WebClient,
  userId: string,
): Promise<void> {
  // 1. ユーザーとのDMチャンネルを取得
  const dm = await client.conversations.open({ users: userId });
  const channelId = dm.channel?.id;
  if (!channelId) throw new Error("Failed to open DM channel");

  // 2. データ収集
  console.log("[Briefing] Collecting sources...");
  const rawItems = await collectAllSources();
  console.log(`[Briefing] Collected ${rawItems.length} items`);

  // 3. キュレーション（Claude APIがあれば使う、なければフォールバック）
  let briefing;
  if (rawItems.length > 0 && env.ANTHROPIC_API_KEY) {
    console.log("[Briefing] Curating with Claude API...");
    briefing = await curateBriefing(rawItems);
  } else if (rawItems.length > 0) {
    console.log("[Briefing] Using fallback curation (no Claude API key)...");
    briefing = curateBriefingFallback(rawItems);
  } else {
    // 収集結果0件 → 日付だけ入れた空ブリーフィング
    briefing = {
      date: formatDateJapanese(new Date()),
      sections: [],
      totalCount: 0,
    };
  }

  // 4. Slack送信
  const message = formatBriefingForSlack(briefing);
  await client.chat.postMessage({
    channel: channelId,
    text: message,
    mrkdwn: true,
  });
}

/**
 * テスト用：ダミーデータでブリーフィングを送信
 */
export async function sendTestBriefing(
  client: WebClient,
  userId: string,
): Promise<void> {
  const dm = await client.conversations.open({ users: userId });
  const channelId = dm.channel?.id;
  if (!channelId) throw new Error("Failed to open DM channel");

  const today = formatDateJapanese(new Date());
  const briefing = createTestBriefing(today);
  const message = formatBriefingForSlack(briefing);

  await client.chat.postMessage({
    channel: channelId,
    text: message,
    mrkdwn: true,
  });
}
