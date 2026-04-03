import { WebClient } from "@slack/web-api";
import { env, SLACK_USER_ID } from "../config/env.js";
import { app } from "../app.js";
import { getClaudeClient } from "../utils/claude-client.js";

// ============================================================
// 返信待ちスレッドチェック v2
// 1. search.messages（ユーザートークン）で全チャンネル横断メンション検索
// 2. スレッド内容を取得
// 3. Claude APIで文脈分析 → 本当に返信が必要なものだけ抽出
// ============================================================

interface ThreadCandidate {
  channelId: string;
  channelName: string;
  threadTs: string;
  messages: { user: string; text: string; ts: string }[];
  permalink?: string;
}

interface AnalyzedThread {
  channelName: string;
  summary: string;
  urgency: "high" | "medium" | "low";
  reason: string;
  permalink?: string;
}

/**
 * 返信待ちスレッドを検出し、Claude で分析して返信が必要なものだけ返す
 */
export async function checkPendingThreads(): Promise<string> {
  if (!env.SLACK_USER_TOKEN) {
    return ":warning: SLACK_USER_TOKEN が未設定のため、返信待ちスレッドのチェックができません。";
  }

  const userClient = new WebClient(env.SLACK_USER_TOKEN);
  const botClient = app.client;

  try {
    // 1. ユーザートークンで全チャンネル横断メンション検索（直近24時間）
    console.log("[PendingThreads] Searching mentions...");
    const candidates = await searchMentions(userClient, botClient);
    console.log(
      `[PendingThreads] Found ${candidates.length} thread candidates`,
    );

    if (candidates.length === 0) {
      const now = new Date().toLocaleString("ja-JP", {
        timeZone: "Asia/Tokyo",
      });
      return [
        `:white_check_mark: *返信待ちスレッド — ${now}*`,
        "",
        "直近24時間で返信が必要なスレッドはありません。",
      ].join("\n");
    }

    // 2. Claude APIで文脈分析
    console.log("[PendingThreads] Analyzing with Claude...");
    const analyzed = await analyzeWithClaude(candidates);

    return formatResults(analyzed);
  } catch (e) {
    console.error("[PendingThreads] Error:", e);
    return `:x: 返信待ちスレッドのチェックでエラーが発生しました: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * ユーザートークンで search.messages → メンションされたスレッドを収集
 */
async function searchMentions(
  userClient: WebClient,
  botClient: WebClient,
): Promise<ThreadCandidate[]> {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const afterDate = oneDayAgo.toISOString().split("T")[0]; // YYYY-MM-DD

  const result = await userClient.search.messages({
    query: `<@${SLACK_USER_ID}> after:${afterDate}`,
    sort: "timestamp",
    sort_dir: "desc",
    count: 30,
  });

  const matches = result.messages?.matches || [];
  const candidates: ThreadCandidate[] = [];
  const seen = new Set<string>(); // 重複排除用（channel+threadTs）

  for (const match of matches) {
    // search.messages の channel 構造をログ出力（デバッグ）
    const rawChannel = match.channel as Record<string, unknown> | undefined;
    const channelId = rawChannel?.id as string | undefined;
    const channelName = (rawChannel?.name as string) || "unknown";

    console.log(
      `[PendingThreads] Match: ch=${channelName}, id=${channelId}, user=${match.user}, ts=${match.ts}`,
    );

    if (!channelId) continue;

    // 自分自身のメッセージはスキップ
    if (match.user === SLACK_USER_ID) continue;

    // スレッドのルートtsを特定（スレッド内メッセージならthread_ts、そうでなければts）
    const rawMatch = match as Record<string, unknown>;
    const threadTs =
      (rawMatch.thread_ts as string) ||
      match.ts ||
      "";
    if (!threadTs) continue;

    const key = `${channelId}:${threadTs}`;
    if (seen.has(key)) continue;
    seen.add(key);

    console.log(
      `[PendingThreads] Fetching thread: ch=${channelId}, ts=${threadTs}`,
    );

    try {
      // ボットトークンでスレッド全文を取得
      const replies = await botClient.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 20,
      });

      const allMessages = (replies.messages || []).map((m) => ({
        user: m.user || "unknown",
        text: m.text || "",
        ts: m.ts || "",
      }));

      if (allMessages.length === 0) continue;

      // 自分がスレッド内で最後に返信している場合はスキップ
      const lastMsg = allMessages[allMessages.length - 1];
      if (lastMsg.user === SLACK_USER_ID) continue;

      // パーマリンク取得
      let permalink: string | undefined;
      try {
        // メンションされたメッセージのパーマリンク
        const mentionTs = match.ts || lastMsg.ts;
        const link = await botClient.chat.getPermalink({
          channel: channelId,
          message_ts: mentionTs,
        });
        permalink = link.permalink;
      } catch {
        // パーマリンク取得失敗は無視
      }

      candidates.push({
        channelId,
        channelName,
        threadTs,
        messages: allMessages,
        permalink,
      });
    } catch (e) {
      // ボットがチャンネルにいない場合など → ユーザートークンで再試行
      try {
        const replies = await userClient.conversations.replies({
          channel: channelId,
          ts: threadTs,
          limit: 20,
        });

        const allMessages = (replies.messages || []).map((m) => ({
          user: m.user || "unknown",
          text: m.text || "",
          ts: m.ts || "",
        }));

        if (allMessages.length === 0) continue;
        const lastMsg = allMessages[allMessages.length - 1];
        if (lastMsg.user === SLACK_USER_ID) continue;

        let permalink: string | undefined;
        try {
          const link = await userClient.chat.getPermalink({
            channel: channelId,
            message_ts: match.ts || lastMsg.ts,
          });
          permalink = link.permalink;
        } catch {
          // ignore
        }

        candidates.push({
          channelId,
          channelName,
          threadTs,
          messages: allMessages,
          permalink,
        });
      } catch {
        console.log(
          `[PendingThreads] Skipped thread in ${channelName}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    await sleep(300);
  }

  return candidates;
}

/**
 * Claude APIでスレッドの文脈を分析し、返信が必要なものを判定
 */
async function analyzeWithClaude(
  candidates: ThreadCandidate[],
): Promise<AnalyzedThread[]> {
  const claude = getClaudeClient();

  // スレッド内容をテキスト化
  const threadsText = candidates
    .map((c, i) => {
      const msgs = c.messages
        .map((m) => {
          const isMe = m.user === SLACK_USER_ID ? "【自分】" : `<@${m.user}>`;
          return `  ${isMe}: ${m.text}`;
        })
        .join("\n");
      return `--- スレッド${i + 1}（#${c.channelName}）---\n${msgs}`;
    })
    .join("\n\n");

  const response = await claude.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    system: `あなたはSlackメッセージの分析アシスタントです。
ユーザー（【自分】と表記）がメンションされているスレッドを分析し、返信が本当に必要なものだけを抽出してください。

## 返信が必要なケース
- 質問されている（回答を求められている）
- 承認・確認を求められている
- アクションや対応を依頼されている
- 報告に対してフィードバックが期待されている

## 返信が不要なケース
- FYI（情報共有のみ）で、対応不要
- 全体メンション（@channel, @here）で自分個人への依頼ではない
- 既に別の人が回答/対応済み
- 単なる挨拶やお礼

## 出力フォーマット
JSON配列で返してください。返信が必要なスレッドのみ含めてください。
返信が必要なスレッドが0件の場合は空配列 [] を返してください。

[
  {
    "thread_index": 1,
    "summary": "スレッドの要約（1行）",
    "urgency": "high/medium/low",
    "reason": "返信が必要な理由（1行）"
  }
]

urgency判定基準:
- high: 即対応が必要（承認待ち、ブロッカー、緊急依頼）
- medium: 今日中に返信したい（質問、フィードバック依頼）
- low: 時間があるときに返信（軽い確認、情報共有への反応）`,
    messages: [
      {
        role: "user",
        content: `以下の${candidates.length}件のスレッドを分析してください。【自分】にメンションが来ていますが、本当に返信が必要なものだけを教えてください。\n\n${threadsText}`,
      },
    ],
  });

  // レスポンスからJSONを抽出
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => ("text" in b ? b.text : ""))
    .join("");

  try {
    // JSONブロックを抽出（```json ... ``` またはそのまま）
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as {
      thread_index: number;
      summary: string;
      urgency: "high" | "medium" | "low";
      reason: string;
    }[];

    return parsed
      .filter((p) => p.thread_index >= 1 && p.thread_index <= candidates.length)
      .map((p) => {
        const candidate = candidates[p.thread_index - 1];
        return {
          channelName: candidate.channelName,
          summary: p.summary,
          urgency: p.urgency,
          reason: p.reason,
          permalink: candidate.permalink,
        };
      });
  } catch (e) {
    console.error("[PendingThreads] Claude response parse error:", e);
    console.error("[PendingThreads] Raw response:", text);
    return [];
  }
}

function formatResults(threads: AnalyzedThread[]): string {
  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

  if (threads.length === 0) {
    return [
      `:white_check_mark: *返信待ちスレッド — ${now}*`,
      "",
      "メンションはありましたが、分析の結果、返信が必要なものはありませんでした。",
    ].join("\n");
  }

  // urgency順にソート（high → medium → low）
  const order = { high: 0, medium: 1, low: 2 };
  threads.sort((a, b) => order[a.urgency] - order[b.urgency]);

  const urgencyEmoji = {
    high: ":rotating_light:",
    medium: ":arrow_right:",
    low: ":thought_balloon:",
  };
  const urgencyLabel = {
    high: "要即対応",
    medium: "今日中",
    low: "余裕あれば",
  };

  const lines = [
    `:speech_balloon: *返信待ちスレッド — ${now}*`,
    `${threads.length}件のスレッドで返信が必要です。`,
    "",
  ];

  for (let i = 0; i < threads.length; i++) {
    const t = threads[i];
    const emoji = urgencyEmoji[t.urgency];
    const label = urgencyLabel[t.urgency];
    const link = t.permalink ? ` <${t.permalink}|:link:>` : "";

    lines.push(`*${i + 1}.* ${emoji} *[${label}]* #${t.channelName}${link}`);
    lines.push(`　${t.summary}`);
    lines.push(`　_${t.reason}_`);
    lines.push("");
  }

  return lines.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
