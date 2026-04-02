import type { BriefingTopic } from "../types/intelligence-briefing.js";

export const BRIEFING_TOPICS: BriefingTopic[] = [
  {
    id: "seo",
    label: "SEO",
    emoji: "🔍",
    priority: 1,
    keywords: [
      "SEO", "コアアップデート", "検索順位", "Google検索",
      "E-E-A-T", "SGE", "AI Overview", "内部リンク",
      "被リンク", "インデックス", "Search Console",
      "core update", "search algorithm",
    ],
  },
  {
    id: "ads",
    label: "広告運用",
    emoji: "📢",
    priority: 2,
    keywords: [
      "Google広告", "Google Ads", "Meta広告", "Facebook広告",
      "リスティング広告", "P-MAX", "ROAS", "CPA",
      "入札戦略", "広告運用", "コンバージョン",
      "PPC", "ディスプレイ広告",
    ],
  },
  {
    id: "webmarketing",
    label: "WEBマーケティング",
    emoji: "📊",
    priority: 3,
    keywords: [
      "Webマーケティング", "CVR", "LP最適化", "GA4",
      "ヒートマップ", "CRO", "ABテスト", "UX改善",
      "コンテンツマーケティング", "オウンドメディア",
      "マーケティング戦略", "デジタルマーケティング",
    ],
  },
  {
    id: "management",
    label: "マネジメント",
    emoji: "👥",
    priority: 4,
    keywords: [
      "マネジメント", "1on1", "OKR", "KPI",
      "チームビルディング", "ピープルマネジメント",
      "組織開発", "リーダーシップ", "人材育成",
      "評価制度", "エンゲージメント",
    ],
  },
  {
    id: "ai",
    label: "Claude / AI",
    emoji: "🤖",
    priority: 5,
    keywords: [
      "Claude", "Anthropic", "Claude Code", "AI活用",
      "プロンプトエンジニアリング", "ChatGPT", "Gemini",
      "生成AI", "LLM", "AI自動化", "AIエージェント",
      "MCP", "AI秘書", "業務自動化",
    ],
  },
  {
    id: "sales",
    label: "営業",
    emoji: "💼",
    priority: 6,
    keywords: [
      "BtoB営業", "インサイドセールス", "商談",
      "SaaS営業", "営業戦略", "テレアポ",
      "リード獲得", "ナーチャリング", "CRM",
    ],
  },
];
