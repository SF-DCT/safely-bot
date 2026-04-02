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

## 注意事項
- Slack上での会話なので、返答は簡潔に
- 長文は箇条書きやセクション分けで読みやすく
- 絵文字は控えめに使ってOK`;

export interface IntentResult {
  text: string;
  specialAction?: "briefing" | "test_briefing";
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

      // ブリーフィング系は特別処理
      if (result === "BRIEFING_REQUESTED") {
        return {
          text: "インテリジェンスブリーフィングを生成中...",
          specialAction: "briefing",
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
