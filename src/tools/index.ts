import Anthropic from "@anthropic-ai/sdk";

// ツール定義 — ここに新しいツールを追加するだけで機能が増える
export const tools: Anthropic.Tool[] = [
  {
    name: "get_current_time",
    description: "現在の日本時間を取得する",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_briefing",
    description:
      "今日のインテリジェンスブリーフィング（ニュース・トレンド情報）を取得する",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_daily_report_status",
    description: "日報作成機能の状態を確認する",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// ツール実行 — 各ツールの実際の処理
export async function executeTool(
  name: string,
  _input: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "get_current_time": {
      const now = new Date().toLocaleString("ja-JP", {
        timeZone: "Asia/Tokyo",
      });
      return `現在の日本時間: ${now}`;
    }

    case "get_briefing": {
      return "BRIEFING_REQUESTED";
    }

    case "get_daily_report_status": {
      return "日報作成機能は現在開発中です。Phase 2 Step 2〜5の実装が必要です。";
    }

    default:
      return `未知のツール: ${name}`;
  }
}
