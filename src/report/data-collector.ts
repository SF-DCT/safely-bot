import type { WebClient } from "@slack/web-api";
import {
  SLACK_USER_ID,
  SLACK_REPORT_CHANNEL,
  SLACK_SELF_DM_CHANNEL,
  SLACK_CEO_USER_ID,
} from "../config/env.js";
import { formatDateJapanese } from "../utils/date-formatter.js";

export interface DailyReportData {
  date: string;
  previousReportTry: string | null;
  selfDmMemos: string[];
  ceoMessages: string[];
}

/**
 * 今日の0:00 JST を UNIX timestamp で返す
 */
function getTodayStartUnix(): number {
  const now = new Date();
  const jst = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }),
  );
  jst.setHours(0, 0, 0, 0);
  // JST → UTC に戻す
  return Math.floor(jst.getTime() / 1000) - 9 * 3600;
}

/**
 * #日報-高橋幹佳 から直近の日報を取得し「今後行う業務」を抽出
 */
async function getPreviousReportTry(
  client: WebClient,
): Promise<string | null> {
  try {
    const result = await client.conversations.history({
      channel: SLACK_REPORT_CHANNEL,
      limit: 10,
    });

    // 高橋の直近の日報投稿を探す
    const report = result.messages?.find(
      (m) => m.user === SLACK_USER_ID && m.text && m.text.includes("行った業務"),
    );
    if (!report?.text) return null;

    // 「今後行う業務」セクションを抽出
    const match = report.text.match(
      /今後行う業務[\s\S]*?(?=\*\*■|■|\n\n\*\*|$)/,
    );
    return match ? match[0].trim() : null;
  } catch (e) {
    console.error("[DailyReport] Failed to get previous report:", e);
    return null;
  }
}

/**
 * 自分宛DMメモ（今日分）を取得
 */
async function getSelfDmMemos(
  client: WebClient,
  todayStart: number,
): Promise<string[]> {
  try {
    const result = await client.conversations.history({
      channel: SLACK_SELF_DM_CHANNEL,
      oldest: String(todayStart),
      limit: 50,
    });

    return (result.messages || [])
      .filter((m) => m.text)
      .map((m) => m.text!)
      .reverse();
  } catch (e) {
    console.error("[DailyReport] Failed to get self DM memos:", e);
    return [];
  }
}

/**
 * 岡野社長の発信（labチャンネル等、今日分）を取得
 */
async function getCeoMessages(
  client: WebClient,
  todayStart: number,
): Promise<string[]> {
  // lab チャンネルを検索
  try {
    const channels = await client.conversations.list({
      types: "public_channel",
      limit: 200,
    });

    const labChannels = (channels.channels || []).filter(
      (ch) => ch.name?.startsWith("lab") && ch.is_member,
    );

    const messages: string[] = [];
    for (const ch of labChannels) {
      if (!ch.id) continue;
      try {
        const history = await client.conversations.history({
          channel: ch.id,
          oldest: String(todayStart),
          limit: 20,
        });
        const ceoMsgs = (history.messages || []).filter(
          (m) => m.user === SLACK_CEO_USER_ID && m.text,
        );
        for (const m of ceoMsgs) {
          messages.push(`[#${ch.name}] ${m.text}`);
        }
      } catch {
        // Bot がチャンネルにアクセスできない場合はスキップ
      }
    }
    return messages.reverse();
  } catch (e) {
    console.error("[DailyReport] Failed to get CEO messages:", e);
    return [];
  }
}

/**
 * 日報に必要なデータを並列収集
 */
export async function collectDailyReportData(
  client: WebClient,
): Promise<DailyReportData> {
  const todayStart = getTodayStartUnix();

  const [previousReportTry, selfDmMemos, ceoMessages] = await Promise.all([
    getPreviousReportTry(client),
    getSelfDmMemos(client, todayStart),
    getCeoMessages(client, todayStart),
  ]);

  return {
    date: formatDateJapanese(new Date()),
    previousReportTry,
    selfDmMemos,
    ceoMessages,
  };
}
