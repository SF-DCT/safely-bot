import type { WebClient } from "@slack/web-api";
import { SLACK_USER_ID } from "../config/env.js";
import { app } from "../app.js";

// ============================================================
// 返信待ちスレッドチェック
// 自分が参加しているスレッドで、最新メッセージが自分以外 → 返信待ち
// ============================================================

interface PendingThread {
  channelId: string;
  channelName: string;
  threadTs: string;
  threadStarter: string;
  latestMessage: string;
  latestUser: string;
  latestTs: string;
  replyCount: number;
  permalink?: string;
}

/**
 * ボットトークンを使って返信待ちスレッドを検出する
 * ボットが参加しているチャンネルをスキャンし、ユーザーが返信していないスレッドを検出
 */
export async function checkPendingThreads(): Promise<string> {
  const client = app.client;

  try {
    // 1. ボットが参加しているチャンネルを取得
    const channels = await getActiveChannels(client);
    console.log(
      `[PendingThreads] Scanning ${channels.length} channels...`,
    );

    // 2. 各チャンネルでスレッドをスキャン
    const pendingThreads: PendingThread[] = [];
    const oneDayAgo = String(
      Math.floor(Date.now() / 1000) - 24 * 60 * 60,
    );

    for (const channel of channels) {
      try {
        const threads = await findPendingThreadsInChannel(
          client,
          channel.id,
          channel.name,
          oneDayAgo,
        );
        pendingThreads.push(...threads);
      } catch (e) {
        // 権限不足等でスキャンできないチャンネルはスキップ
        console.log(
          `[PendingThreads] Skipped ${channel.name}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      // APIレート制限対策
      await sleep(300);
    }

    return formatPendingThreads(pendingThreads);
  } catch (e) {
    console.error("[PendingThreads] Error:", e);
    return `:x: 返信待ちスレッドのチェックでエラーが発生しました: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function getActiveChannels(
  client: WebClient,
): Promise<{ id: string; name: string }[]> {
  const channels: { id: string; name: string }[] = [];
  let cursor: string | undefined;

  // ボットが参加しているチャンネルを取得（最大3ページ）
  for (let page = 0; page < 3; page++) {
    const result = await client.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 100,
      cursor,
    });

    for (const ch of result.channels || []) {
      // is_member: ボットが参加しているチャンネルのみ
      if (ch.id && ch.name && ch.is_member) {
        channels.push({ id: ch.id, name: ch.name });
      }
    }

    cursor = result.response_metadata?.next_cursor;
    if (!cursor) break;
    await sleep(300);
  }

  return channels;
}

async function findPendingThreadsInChannel(
  client: WebClient,
  channelId: string,
  channelName: string,
  oldest: string,
): Promise<PendingThread[]> {
  const pending: PendingThread[] = [];

  // チャンネル内の最近のメッセージを取得
  const history = await client.conversations.history({
    channel: channelId,
    oldest,
    limit: 50,
  });

  const threaded = (history.messages || []).filter(
    (m) => m.reply_count && m.reply_count > 0 && m.ts,
  );

  for (const msg of threaded) {
    try {
      const replies = await client.conversations.replies({
        channel: channelId,
        ts: msg.ts!,
        limit: 30,
      });

      const allReplies = replies.messages || [];
      if (allReplies.length < 2) continue;

      // ユーザーがスレッドに参加しているか確認
      const userParticipated = allReplies.some(
        (r) => r.user === SLACK_USER_ID,
      );
      // ユーザーがスレッド内で@メンションされているか確認
      const userMentioned = allReplies.some(
        (r) =>
          r.user !== SLACK_USER_ID &&
          r.text?.includes(`<@${SLACK_USER_ID}>`),
      );

      if (!userParticipated && !userMentioned) continue;

      // 最新のメッセージが自分以外 → 返信待ち
      const latest = allReplies[allReplies.length - 1];
      if (latest.user === SLACK_USER_ID) continue;

      // パーマリンク取得
      let permalink: string | undefined;
      try {
        const link = await client.chat.getPermalink({
          channel: channelId,
          message_ts: latest.ts!,
        });
        permalink = link.permalink;
      } catch {
        // パーマリンク取得失敗は無視
      }

      pending.push({
        channelId,
        channelName,
        threadTs: msg.ts!,
        threadStarter: truncate(msg.text || "(no text)", 60),
        latestMessage: truncate(latest.text || "(no text)", 80),
        latestUser: latest.user || "unknown",
        latestTs: latest.ts!,
        replyCount: allReplies.length - 1,
        permalink,
      });
    } catch {
      // スレッド取得失敗はスキップ
    }

    await sleep(200);
  }

  return pending;
}

function formatPendingThreads(threads: PendingThread[]): string {
  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

  if (threads.length === 0) {
    return [
      `:white_check_mark: *返信待ちスレッド — ${now}*`,
      "",
      "直近24時間で返信待ちのスレッドはありません。",
    ].join("\n");
  }

  // 新しい順にソート
  threads.sort(
    (a, b) => parseFloat(b.latestTs) - parseFloat(a.latestTs),
  );

  const lines = [
    `:speech_balloon: *返信待ちスレッド — ${now}*`,
    `${threads.length}件のスレッドで返信が待たれています。`,
    "",
  ];

  for (let i = 0; i < threads.length; i++) {
    const t = threads[i];
    const time = formatTimestamp(t.latestTs);
    const link = t.permalink
      ? ` <${t.permalink}|:link:>`
      : "";

    lines.push(
      `*${i + 1}.* #${t.channelName}（${t.replyCount}件の返信）${link}`,
    );
    lines.push(`　スレッド: ${t.threadStarter}`);
    lines.push(
      `　最新（<@${t.latestUser}> ${time}）: ${t.latestMessage}`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

function formatTimestamp(ts: string): string {
  const date = new Date(parseFloat(ts) * 1000);
  return date.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function truncate(text: string, max: number): string {
  // Slack特殊文字をクリーンアップ
  const clean = text
    .replace(/<@[^>]+>/g, "@ユーザー")
    .replace(/<#[^>|]+\|([^>]+)>/g, "#$1")
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/\n/g, " ");
  return clean.length > max ? clean.slice(0, max) + "..." : clean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
