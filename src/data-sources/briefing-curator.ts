import { BRIEFING_TOPICS } from "../config/topics.js";
import type {
  BriefingItem,
  IntelligenceBriefing,
  TopicSection,
} from "../types/intelligence-briefing.js";
import { getClaudeClient } from "../utils/claude-client.js";
import { formatDateJapanese } from "../utils/date-formatter.js";
import type { WebSearchResult } from "./web-search.js";

const CURATE_SYSTEM_PROMPT = `あなたはSAFELY社の事業成長戦略チームGM（高橋幹佳）のAI秘書です。
収集された記事・投稿のリストを分析し、高橋さんが今日読むべき重要な情報を選別・要約してください。

## 高橋さんのコンテキスト
- 株式会社SAFELY 事業成長戦略チーム ジェネラルマネージャー
- セーフリー（safely.co.jp）: 暮らし系11カテゴリの口コミ比較プラットフォーム運営
- 受託クライアントのWebマーケティング支援（SEO・広告運用）
- AI秘書サービスの新規事業開発中（Claude Code活用）

## 出力ルール
- 各記事について「summary」（概要1-2行）と「insight」（高橋さんの業務への示唆1行）を生成
- 関連度の低い記事は除外してOK（relevantをfalseに）
- 合計10-15件を目安に選別
- 日本語で出力`;

interface CurateInput {
  title: string;
  url: string;
  snippet: string;
  source: string;
  topicId: string;
}

interface CuratedItem {
  url: string;
  summary: string;
  insight: string;
  relevant: boolean;
}

/**
 * Claude APIで収集データをキュレーション・要約
 */
export async function curateBriefing(
  rawItems: WebSearchResult[],
): Promise<IntelligenceBriefing> {
  const today = formatDateJapanese(new Date());

  if (rawItems.length === 0) {
    return { date: today, sections: [], totalCount: 0 };
  }

  const claude = getClaudeClient();

  const input: CurateInput[] = rawItems.map((item) => ({
    title: item.title,
    url: item.url,
    snippet: item.snippet,
    source: item.source,
    topicId: item.topicId,
  }));

  const response = await claude.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: CURATE_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `以下の収集データからブリーフィングを作成してください。

収集データ:
${JSON.stringify(input, null, 2)}

以下のJSON形式で出力してください（JSONのみ、余計なテキスト不要）:
{
  "items": [
    {
      "url": "元のURL",
      "summary": "概要（1-2行）",
      "insight": "高橋さんの業務への示唆（1行）",
      "relevant": true
    }
  ]
}`,
      },
    ],
  });

  // レスポンスからJSONを抽出
  const textBlock = response.content.find((b) => b.type === "text");
  const text = textBlock?.type === "text" ? textBlock.text : "";

  let curatedItems: CuratedItem[] = [];
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      curatedItems = parsed.items || [];
    }
  } catch (e) {
    console.error("[Curator] Failed to parse Claude response:", e);
  }

  // rawItemsとマージしてBriefingItemに変換
  const urlMap = new Map(rawItems.map((r) => [r.url, r]));
  const briefingItems: BriefingItem[] = curatedItems
    .filter((c) => c.relevant !== false)
    .map((c) => {
      const raw = urlMap.get(c.url);
      return {
        title: raw?.title || "",
        summary: c.summary,
        insight: c.insight,
        url: c.url,
        source: (raw?.source || "x") as "x" | "youtube",
        topicId: raw?.topicId || "webmarketing",
      };
    });

  // トピックごとにグループ化（優先度順）
  const sections: TopicSection[] = BRIEFING_TOPICS.map((topic) => ({
    topic,
    items: briefingItems.filter((item) => item.topicId === topic.id),
  })).filter((section) => section.items.length > 0);

  return {
    date: today,
    sections,
    totalCount: briefingItems.length,
  };
}

/**
 * Claude APIが使えない場合のフォールバック（テスト用）
 * 収集データをそのまま整形して返す
 */
export function curateBriefingFallback(
  rawItems: WebSearchResult[],
): IntelligenceBriefing {
  const today = formatDateJapanese(new Date());

  const briefingItems: BriefingItem[] = rawItems.map((item) => ({
    title: item.title,
    summary: item.snippet,
    insight: "",
    url: item.url,
    source: item.source,
    topicId: item.topicId,
  }));

  const sections: TopicSection[] = BRIEFING_TOPICS.map((topic) => ({
    topic,
    items: briefingItems.filter((i) => i.topicId === topic.id),
  })).filter((s) => s.items.length > 0);

  return { date: today, sections, totalCount: briefingItems.length };
}
