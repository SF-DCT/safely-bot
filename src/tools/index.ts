import Anthropic from "@anthropic-ai/sdk";
import {
  getAdsPerformance,
  getAdsAccountList,
} from "../data-sources/google-ads.js";

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
  {
    name: "get_ads_performance",
    description:
      "Google Adsの広告パフォーマンスデータ（広告費、クリック数、CV数、CPA等）を取得する。アカウントコード（SKH、SKT、ES、ISCL、ISWC、ISCB、TC等）と期間を指定する。",
    input_schema: {
      type: "object" as const,
      properties: {
        account: {
          type: "string",
          description:
            "アカウントコードまたはブランド名。例: SKH, SKT, ES, 粗大ゴミ回収本舗, 回収隊, クリーンライフ, ISCL, ISWC, ISCB, TC",
        },
        period: {
          type: "string",
          enum: [
            "today",
            "yesterday",
            "this_week",
            "last_week",
            "this_month",
            "last_month",
          ],
          description:
            "期間。today=今日, yesterday=昨日, this_week=今週, last_week=先週, this_month=今月, last_month=先月",
        },
      },
      required: ["account", "period"],
    },
  },
  {
    name: "get_ads_account_list",
    description:
      "管理しているGoogle Adsアカウントの一覧を取得する。どのアカウントがあるか確認したいときに使う。",
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
  input: Record<string, unknown>,
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

    case "get_ads_performance": {
      const account = (input.account as string) || "";
      const period = (input.period as string) || "today";
      return await getAdsPerformance(account, period);
    }

    case "get_ads_account_list": {
      return await getAdsAccountList();
    }

    default:
      return `未知のツール: ${name}`;
  }
}
