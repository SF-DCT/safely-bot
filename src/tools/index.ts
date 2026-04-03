import Anthropic from "@anthropic-ai/sdk";
import {
  getAdsPerformance,
  getCampaignPerformance,
  getAdsAccountList,
} from "../data-sources/google-ads.js";
import {
  getUnreadEmails,
  createGmailDraft,
  sendGmailReply,
} from "../data-sources/gmail.js";
import {
  runEnhancedCvUpload,
  runEnhancedCvUploadForBrand,
} from "../data-sources/enhanced-cv.js";
import { syncAdSpendToSheets } from "../data-sources/ad-spend-sync.js";
import { generateDailyAdReport } from "../data-sources/ad-report.js";

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
    name: "generate_daily_report",
    description:
      "日報ドラフトを生成する。「日報書いて」「日報お願い」「日報作って」などのリクエストで使う。",
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
    name: "get_campaign_performance",
    description:
      "Google Adsのキャンペーン別パフォーマンスデータを取得する。キャンペーンごとの広告費、クリック数、CV数、CPAが分かる。P-MAXや検索キャンペーンごとの内訳を見たいときに使う。",
    input_schema: {
      type: "object" as const,
      properties: {
        account: {
          type: "string",
          description:
            "アカウントコードまたはブランド名。例: SKH, SKT, ES, 粗大ゴミ回収本舗, 回収隊, クリーンライフ",
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
  {
    name: "check_gmail",
    description:
      "Gmailの未読メールを確認し、返信が必要なメールを仕分けて返信案を提案する。「メールチェックして」「未読メール確認して」「返信必要なメールある？」などのリクエストで使う。",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "create_gmail_draft",
    description:
      "Gmailに返信の下書きを作成する。メールIDと返信本文を指定する。check_gmailで提案された返信案をもとに下書きを作成するときに使う。",
    input_schema: {
      type: "object" as const,
      properties: {
        message_id: {
          type: "string",
          description: "返信対象のメールID（check_gmailの結果に含まれるID）",
        },
        reply_body: {
          type: "string",
          description: "返信本文（日本語）",
        },
      },
      required: ["message_id", "reply_body"],
    },
  },
  {
    name: "send_gmail_reply",
    description:
      "Gmailで返信メールを直接送信する。メールIDと返信本文を指定する。ユーザーが「送って」「返信して」と指示したときに使う。",
    input_schema: {
      type: "object" as const,
      properties: {
        message_id: {
          type: "string",
          description: "返信対象のメールID",
        },
        reply_body: {
          type: "string",
          description: "返信本文（日本語）",
        },
      },
      required: ["message_id", "reply_body"],
    },
  },
  {
    name: "sync_ad_spend",
    description:
      "Google Adsの広告費を各PFのスプレッドシートに自動入力する。「広告費入力して」「広告費同期して」などのリクエストで使う。指定日の広告費をGoogle Ads APIから取得し、各プロジェクトシートに書き込む。",
    input_schema: {
      type: "object" as const,
      properties: {
        date: {
          type: "string",
          description:
            "対象日（YYYY-MM-DD形式）。省略時は昨日。例: 2026-04-02",
        },
      },
      required: [],
    },
  },
  {
    name: "get_ad_report",
    description:
      "日次広告レポートを生成する。スプレッドシートから広告費・問合せ数・予算進捗を読み取り、異常検知（消化金額の急変動、問合せ減少、予算進捗率低下等）を含むレポートを生成する。「広告レポート見せて」「広告の状況は？」などのリクエストで使う。",
    input_schema: {
      type: "object" as const,
      properties: {
        date: {
          type: "string",
          description:
            "対象日（YYYY-MM-DD形式）。省略時は昨日。例: 2026-04-02",
        },
      },
      required: [],
    },
  },
  {
    name: "run_enhanced_cv_upload",
    description:
      "拡張コンバージョン（電話番号ハッシュ方式）をGoogle Adsにアップロードする。SKH/SKT/ESの成約データをSalesforceから取得し、一括アップロードする。「拡張CV」「コンバージョンアップロード」「成約データ送って」などのリクエストで使う。",
    input_schema: {
      type: "object" as const,
      properties: {
        brand: {
          type: "string",
          description:
            "ブランドコード。ALL=全ブランド一括, SKH, SKT, ES のいずれか。省略時はALL。",
        },
        days: {
          type: "number",
          description: "取得期間（日数）。デフォルト: 2",
        },
      },
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

    case "generate_daily_report": {
      return "DAILY_REPORT_REQUESTED";
    }

    case "get_ads_performance": {
      const account = (input.account as string) || "";
      const period = (input.period as string) || "today";
      return await getAdsPerformance(account, period);
    }

    case "get_campaign_performance": {
      const account = (input.account as string) || "";
      const period = (input.period as string) || "today";
      return await getCampaignPerformance(account, period);
    }

    case "get_ads_account_list": {
      return await getAdsAccountList();
    }

    case "check_gmail": {
      return await getUnreadEmails();
    }

    case "create_gmail_draft": {
      const messageId = input.message_id as string;
      const replyBody = input.reply_body as string;
      return await createGmailDraft(messageId, replyBody);
    }

    case "send_gmail_reply": {
      const messageId = input.message_id as string;
      const replyBody = input.reply_body as string;
      return await sendGmailReply(messageId, replyBody);
    }

    case "sync_ad_spend": {
      const dateStr = input.date as string | undefined;
      const targetDate = dateStr ? new Date(dateStr) : undefined;
      return await syncAdSpendToSheets(targetDate);
    }

    case "get_ad_report": {
      const dateStr = input.date as string | undefined;
      const targetDate = dateStr ? new Date(dateStr) : undefined;
      return await generateDailyAdReport(targetDate);
    }

    case "run_enhanced_cv_upload": {
      const brand = (input.brand as string) || "ALL";
      const days = (input.days as number) || 2;
      if (brand.toUpperCase() === "ALL") {
        return await runEnhancedCvUpload(days);
      }
      return await runEnhancedCvUploadForBrand(brand, days);
    }

    default:
      return `未知のツール: ${name}`;
  }
}
