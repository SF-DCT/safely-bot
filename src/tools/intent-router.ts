import { getClaudeClient } from "../utils/claude-client.js";
import { tools, executeTool } from "./index.js";

const SYSTEM_PROMPT = `あなたはSAFELY Botです。株式会社SAFELYの業務をサポートするAI秘書として振る舞います。

## あなたの役割
- 株式会社SAFELYのBGS事業部をサポートする
- 質問には簡潔かつ丁寧に日本語で回答する
- 利用可能なツールがあれば積極的に使って正確な情報を提供する
- ツールが不要な一般的な会話にも自然に対応する

## 会社情報
- 株式会社SAFELY（セーフリー）
- ミッション: Create a New Values
- 事業: デジタルマーケティング支援 + Webメディア（不用品回収系サービスなど）

## Gmail機能
- 「メールチェック」「未読メール」「返信必要なメール」等のリクエストにはcheck_gmailツールを使う
- メールの分析結果には、返信が必要/不要の仕分けと、返信が必要なメールへの返信案を含める
- 返信案はSAFELYの高橋幹佳（BGS事業部 General Manager）として適切なビジネストーンで作成する
- 「送って」「返信して」と言われたら send_gmail_reply ツールで直接送信する
- 「下書き作って」と言われたら create_gmail_draft ツールで下書きを作成する
- 複数メールへの一括送信にも対応する（「全部送って」「1番と3番に返信して」等）
- メールIDは check_gmail の結果に含まれるIDをそのまま使う

## 注意事項
- Slack上での会話なので、返答は簡潔に
- 長文は箇条書きやセクション分けで読みやすく
- 絵文字は控えめに使ってOK`;

export interface IntentResult {
  text: string;
  specialAction?: "briefing" | "test_briefing" | "daily_report";
}

export async function routeIntent(userMessage: string): Promise<IntentResult> {
  const client = getClaudeClient();

  const messages: { role: "user" | "assistant"; content: string }[] = [
    { role: "user", content: userMessage },
  ];

  // Claude APIにtool useで問い合わせ
  let response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools,
    messages,
  });

  // ツール呼び出しのループ（複数ツールを連続で使う場合に対応）
  while (response.stop_reason === "tool_use") {
    const toolUseBlocks = response.content.filter(
      (block): block is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
        block.type === "tool_use",
    );

    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      const result = await executeTool(toolUse.name, toolUse.input);

      // 特別処理が必要なツール
      if (result === "BRIEFING_REQUESTED") {
        return {
          text: "インテリジェンスブリーフィングを生成中...",
          specialAction: "briefing",
        };
      }
      if (result === "DAILY_REPORT_REQUESTED") {
        return {
          text: "日報ドラフトを作成中です...",
          specialAction: "daily_report",
        };
      }

      toolResults.push({
        type: "tool_result" as const,
        tool_use_id: toolUse.id,
        content: result,
      });
    }

    // ツール結果をClaudeに返して最終回答を得る
    messages.push({ role: "assistant", content: JSON.stringify(response.content) });
    response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      messages: [
        ...messages,
        { role: "user", content: JSON.stringify(toolResults) },
      ],
    });
  }

  // テキスト応答を抽出
  const textBlocks = response.content.filter(
    (block) => block.type === "text",
  );
  const text = textBlocks
    .map((b) => ("text" in b ? b.text : ""))
    .join("\n") || "応答を生成できませんでした。";

  return { text };
}
