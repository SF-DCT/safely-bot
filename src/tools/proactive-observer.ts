import { WebClient } from "@slack/web-api";
import { getClaudeClient } from "../utils/claude-client.js";
import { tools, executeTool } from "./index.js";

// 監視対象チャンネル
const WATCHED_CHANNELS = [
  "C0AQDMAJP0S", // けんさん＋高橋＋safely-bot
];

// 会話バッファ（チャンネルごとに直近メッセージを保持）
const conversationBuffer = new Map<
  string,
  Array<{ user: string; text: string; ts: string }>
>();

const MAX_BUFFER_SIZE = 15;
const COOLDOWN_MS = 3 * 60 * 1000; // 3分間のクールダウン
const lastResponseTime = new Map<string, number>();

const OBSERVER_SYSTEM_PROMPT = `あなたはSAFELY Botです。株式会社SAFELYの業務チャットを観察しています。

## あなたの役割
チャンネルの会話を読み、本当に価値がある情報を提供できる場合にだけ発言してください。

## 発言すべき場面
- 広告運用の数値について議論している → 具体的なデータを提供できる
- 課題や問題について話している → 解決策やデータで貢献できる
- 意思決定に必要なデータが不足している → 補足データを提供できる

## 絶対に発言しない場面
- 雑談や挨拶
- 自分（Bot）の話題が出ていない限り、存在をアピールしない
- 既に結論が出ている議論
- 感情的なやり取り（励ましや慰め）
- 直近3分以内に発言した場合

## 発言のトーン
- 「失礼します、補足データがあります」のように控えめに入る
- 短く簡潔に。長文は避ける
- データや事実を中心に。意見は控えめに

## 出力形式
会話に入るべきと判断した場合: そのまま発言内容を返してください
入るべきでないと判断した場合: "STAY_SILENT" とだけ返してください

重要: 迷ったらSTAY_SILENTを選んでください。発言しすぎるより、しなさすぎる方がマシです。`;

export function isWatchedChannel(channelId: string): boolean {
  return WATCHED_CHANNELS.includes(channelId);
}

export async function observeAndMaybeRespond(
  client: WebClient,
  channelId: string,
  userId: string,
  text: string,
  ts: string,
  botUserId: string,
): Promise<void> {
  // Bot自身のメッセージは無視
  if (userId === botUserId) return;

  // バッファに追加
  if (!conversationBuffer.has(channelId)) {
    conversationBuffer.set(channelId, []);
  }
  const buffer = conversationBuffer.get(channelId)!;
  buffer.push({ user: userId, text, ts });
  if (buffer.length > MAX_BUFFER_SIZE) {
    buffer.shift();
  }

  // クールダウンチェック
  const lastTime = lastResponseTime.get(channelId) || 0;
  if (Date.now() - lastTime < COOLDOWN_MS) {
    return;
  }

  // 直近のメッセージが少なすぎる場合はスキップ（文脈が足りない）
  if (buffer.length < 2) return;

  // Claudeに会話を見せて判断させる
  const claudeClient = getClaudeClient();

  const conversationText = buffer
    .map((m) => `<@${m.user}>: ${m.text}`)
    .join("\n");

  try {
    let response = await claudeClient.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 512,
      system: OBSERVER_SYSTEM_PROMPT,
      tools,
      messages: [
        {
          role: "user",
          content: `以下はSlackチャンネルの直近の会話です。あなたが有益な情報を提供できるなら発言してください。できないならSTAY_SILENTと返してください。\n\n${conversationText}`,
        },
      ],
    });

    // ツール呼び出しの処理
    while (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(
        (block): block is {
          type: "tool_use";
          id: string;
          name: string;
          input: Record<string, unknown>;
        } => block.type === "tool_use",
      );

      const toolResults = [];
      for (const toolUse of toolUseBlocks) {
        const result = await executeTool(toolUse.name, toolUse.input);
        toolResults.push({
          type: "tool_result" as const,
          tool_use_id: toolUse.id,
          content: result,
        });
      }

      response = await claudeClient.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 512,
        system: OBSERVER_SYSTEM_PROMPT,
        tools,
        messages: [
          {
            role: "user",
            content: `以下はSlackチャンネルの直近の会話です。あなたが有益な情報を提供できるなら発言してください。できないならSTAY_SILENTと返してください。\n\n${conversationText}`,
          },
          {
            role: "assistant",
            content: JSON.stringify(response.content),
          },
          {
            role: "user",
            content: JSON.stringify(toolResults),
          },
        ],
      });
    }

    // テキスト応答を取得
    const textBlocks = response.content.filter(
      (block) => block.type === "text",
    );
    const responseText = textBlocks
      .map((b) => ("text" in b ? b.text : ""))
      .join("\n")
      .trim();

    // STAY_SILENTなら何もしない
    if (!responseText || responseText.includes("STAY_SILENT")) {
      return;
    }

    // 発言する
    await client.chat.postMessage({
      channel: channelId,
      text: responseText,
    });

    // クールダウン記録
    lastResponseTime.set(channelId, Date.now());
    console.log(`[Observer] Responded in ${channelId}`);
  } catch (error) {
    console.error("[Observer] Error:", error);
  }
}
