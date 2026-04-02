import { WebClient } from "@slack/web-api";
import { env, SLACK_REPORT_CHANNEL } from "../config/env.js";
import { collectDailyReportData } from "./data-collector.js";
import {
  generateDailyReportDraft,
  reviseDailyReportDraft,
} from "./draft-generator.js";
import { formatDateJapanese } from "../utils/date-formatter.js";

/**
 * ユーザートークンのクライアント（本人名義で投稿するため）
 * 未設定の場合は null → Bot名義でフォールバック
 */
function getUserClient(): WebClient | null {
  if (!env.SLACK_USER_TOKEN) return null;
  return new WebClient(env.SLACK_USER_TOKEN);
}

// --- State management ---

interface PendingState {
  draft: string;
  editing: boolean; // true = 次のメッセージを修正指示として扱う
}

const pendingDrafts = new Map<string, PendingState>();

export function getPendingDraft(userId: string): PendingState | undefined {
  return pendingDrafts.get(userId);
}

export function clearPendingDraft(userId: string): void {
  pendingDrafts.delete(userId);
}

export function setEditMode(userId: string, editing: boolean): void {
  const state = pendingDrafts.get(userId);
  if (state) state.editing = editing;
}

// --- Main flows ---

/**
 * 日報ドラフトを生成して DM に送信
 */
export async function sendDailyReportDraft(
  client: WebClient,
  userId: string,
): Promise<void> {
  const dm = await client.conversations.open({ users: userId });
  const channelId = dm.channel?.id;
  if (!channelId) throw new Error("Failed to open DM channel");

  await client.chat.postMessage({
    channel: channelId,
    text: ":memo: 日報データを収集中...",
  });

  // データ収集
  console.log("[DailyReport] Collecting data...");
  const data = await collectDailyReportData(client);

  // ドラフト生成
  console.log("[DailyReport] Generating draft...");
  const draft = await generateDailyReportDraft(data);

  // 保留状態に保存
  pendingDrafts.set(userId, { draft, editing: false });

  // ドラフト本文を送信
  await client.chat.postMessage({
    channel: channelId,
    text: `*:clipboard: 日報ドラフト（${data.date}）*\n\n${draft}`,
    mrkdwn: true,
  });

  // アクションボタンを別メッセージで送信
  await client.chat.postMessage({
    channel: channelId,
    text: "上記の内容でよろしいですか？",
    blocks: [
      {
        type: "actions",
        block_id: "daily_report_actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "承認して投稿" },
            style: "primary",
            action_id: "daily_report_approve",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "修正する" },
            action_id: "daily_report_edit",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "キャンセル" },
            style: "danger",
            action_id: "daily_report_cancel",
          },
        ],
      },
    ],
  });
}

/**
 * 修正指示を反映して再送信
 */
export async function handleEditFeedback(
  client: WebClient,
  userId: string,
  channelId: string,
  feedback: string,
): Promise<void> {
  const state = pendingDrafts.get(userId);
  if (!state) return;

  state.editing = false;

  await client.chat.postMessage({
    channel: channelId,
    text: ":arrows_counterclockwise: 修正を反映中...",
  });

  const revisedDraft = await reviseDailyReportDraft(state.draft, feedback);
  state.draft = revisedDraft;

  const today = formatDateJapanese(new Date());

  await client.chat.postMessage({
    channel: channelId,
    text: `*:clipboard: 日報ドラフト（修正版・${today}）*\n\n${revisedDraft}`,
    mrkdwn: true,
  });

  await client.chat.postMessage({
    channel: channelId,
    text: "修正版です。いかがでしょうか？",
    blocks: [
      {
        type: "actions",
        block_id: "daily_report_actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "承認して投稿" },
            style: "primary",
            action_id: "daily_report_approve",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "さらに修正" },
            action_id: "daily_report_edit",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "キャンセル" },
            style: "danger",
            action_id: "daily_report_cancel",
          },
        ],
      },
    ],
  });
}

/**
 * 承認された日報を #日報 チャンネルに投稿
 * ユーザートークンがあれば本人名義、なければBot名義でフォールバック
 */
export async function postApprovedReport(
  botClient: WebClient,
  userId: string,
): Promise<string | null> {
  const state = pendingDrafts.get(userId);
  if (!state) return null;

  // ユーザートークンがあれば本人名義で投稿
  const userClient = getUserClient();
  const postClient = userClient || botClient;

  const result = await postClient.chat.postMessage({
    channel: SLACK_REPORT_CHANNEL,
    text: state.draft,
    mrkdwn: true,
  });

  pendingDrafts.delete(userId);

  return result.ts || null;
}
