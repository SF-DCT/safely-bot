import { WebClient } from "@slack/web-api";
import {
  env,
  SLACK_USER_ID,
  SLACK_REPORT_CHANNEL,
  SLACK_SELF_DM_CHANNEL,
  SLACK_CEO_USER_ID,
} from "../config/env.js";
import { formatDateJapanese } from "../utils/date-formatter.js";
import {
  getTodayEvents,
  getTomorrowEvents,
  formatEvents,
} from "../data-sources/google-calendar.js";
import {
  getTodayNotionActivity,
  formatNotionActivity,
} from "../data-sources/notion.js";

export interface DailyReportData {
  date: string;
  previousReportTry: string | null;
  selfDmMemos: string[];
  ceoMessages: string[];
  slackActivity: string[];
  todayCalendar: string;
  tomorrowCalendar: string;
  notionActivity: string;
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
 * データ収集の開始時刻を返す（UNIX timestamp）
 * 月曜日は金曜0:00 JST、土日も金曜0:00 JSTに遡る
 * → DMメモ・社長発信で週末分のデータも拾えるようにする
 */
function getDataWindowStartUnix(): number {
  const now = new Date();
  const jst = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }),
  );
  const dow = jst.getDay(); // 0=Sun, 1=Mon, ...

  let daysBack = 0;
  if (dow === 1) daysBack = 3; // Mon → Fri
  else if (dow === 0) daysBack = 2; // Sun → Fri
  else if (dow === 6) daysBack = 1; // Sat → Fri

  jst.setDate(jst.getDate() - daysBack);
  jst.setHours(0, 0, 0, 0);
  return Math.floor(jst.getTime() / 1000) - 9 * 3600;
}

/**
 * 今日の日付を YYYY-MM-DD 形式（JST）で返す
 */
function getTodayDateStr(): string {
  const now = new Date();
  const jst = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }),
  );
  const y = jst.getFullYear();
  const m = String(jst.getMonth() + 1).padStart(2, "0");
  const d = String(jst.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
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
 * Slack活動ログ（今日のチャンネル横断メッセージ）を取得
 * ユーザートークンの search:read スコープが必要
 */
async function getUserSlackActivity(): Promise<string[]> {
  if (!env.SLACK_USER_TOKEN) {
    console.log(
      "[DailyReport] SLACK_USER_TOKEN not set — skipping Slack activity search",
    );
    return [];
  }

  const userClient = new WebClient(env.SLACK_USER_TOKEN);
  const dateStr = getTodayDateStr();

  try {
    const result = await userClient.search.messages({
      query: `from:me on:${dateStr}`,
      sort: "timestamp",
      sort_dir: "asc",
      count: 50,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = result as any;
    const matches: Array<{ text?: string; channel?: { name?: string } }> =
      raw?.messages?.matches ?? [];

    return matches
      .filter((m) => m.text && m.channel?.name)
      .map((m) => {
        const text =
          m.text!.length > 200
            ? m.text!.substring(0, 200) + "..."
            : m.text!;
        return `[#${m.channel!.name}] ${text}`;
      });
  } catch (e) {
    console.error(
      "[DailyReport] Failed to get Slack activity (search:read scope may be required):",
      e,
    );
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
  // DMメモ・社長発信は月曜なら金曜0:00から検索（週末分も拾う）
  const dataWindowStart = getDataWindowStartUnix();

  const [
    previousReportTry,
    selfDmMemos,
    ceoMessages,
    slackActivity,
    todayEvents,
    tomorrowEvents,
    notionPages,
  ] = await Promise.all([
    getPreviousReportTry(client),
    getSelfDmMemos(client, dataWindowStart),
    getCeoMessages(client, dataWindowStart),
    getUserSlackActivity(),
    getTodayEvents(),
    getTomorrowEvents(),
    getTodayNotionActivity(),
  ]);

  return {
    date: formatDateJapanese(new Date()),
    previousReportTry,
    selfDmMemos,
    ceoMessages,
    slackActivity,
    todayCalendar: formatEvents(todayEvents),
    tomorrowCalendar: formatEvents(tomorrowEvents),
    notionActivity: formatNotionActivity(notionPages),
  };
}
