import type { IntelligenceBriefing } from "../types/intelligence-briefing.js";

/**
 * ブリーフィングをSlack mrkdwn形式に整形
 * Slackの太字は *text*（シングルアスタリスク）
 */
export function formatBriefingForSlack(
  briefing: IntelligenceBriefing,
): string {
  if (briefing.totalCount === 0) {
    return [
      `おはようございます。${briefing.date}のインテリジェンスブリーフィングです。`,
      "",
      "本日は該当する新着情報がありませんでした。良い一日を！",
    ].join("\n");
  }

  const lines: string[] = [
    `おはようございます。${briefing.date}のインテリジェンスブリーフィングです。`,
    "",
  ];

  let itemNo = 1;

  for (const section of briefing.sections) {
    const { topic, items } = section;
    lines.push(`━━━━━━━━━━━━━━━━━━━`);
    lines.push(`${topic.emoji} *${topic.label}*（${items.length}件）`);
    lines.push(`━━━━━━━━━━━━━━━━━━━`);
    lines.push("");

    for (const item of items) {
      const sourceIcon = item.source === "youtube" ? "🎥" : "🔗";
      const duration =
        item.metadata?.duration ? `（${item.metadata.duration}）` : "";

      lines.push(`*${itemNo}.* ${item.title}`);
      if (item.summary) {
        lines.push(`　→ ${item.summary}`);
      }
      if (item.insight) {
        lines.push(`　💡 ${item.insight}`);
      }
      lines.push(`　${sourceIcon} ${item.url}${duration}`);
      lines.push("");

      itemNo++;
    }
  }

  lines.push(`━━━━━━━━━━━━━━━━━━━`);
  lines.push(`本日は合計${briefing.totalCount}件です。良い一日を！`);

  return lines.join("\n");
}

/**
 * テスト用のダミーブリーフィングを生成
 */
export function createTestBriefing(dateStr: string): IntelligenceBriefing {
  return {
    date: dateStr,
    totalCount: 6,
    sections: [
      {
        topic: {
          id: "seo",
          label: "SEO",
          emoji: "🔍",
          priority: 1,
          keywords: [],
        },
        items: [
          {
            title: "Google、2026年4月コアアップデートを展開開始",
            summary:
              "サイト評判の悪用対策が強化。アフィリエイト系サイトへの影響大。",
            insight:
              "セーフリーは独自コンテンツ中心のため直接影響は軽微だが、競合の順位変動に注目。",
            url: "https://x.com/example/status/1234567890",
            source: "x",
            topicId: "seo",
          },
          {
            title: "AI Overview最新動向：日本での展開状況まとめ",
            summary:
              "AI Overviewの日本語クエリでの出現率が前月比30%増加。ローカル系クエリでの表示が急増中。",
            insight:
              "セーフリーの「地域名×サービス」系ページへの影響を要モニタリング。",
            url: "https://youtube.com/watch?v=example1",
            source: "youtube",
            topicId: "seo",
            metadata: { duration: "15分" },
          },
        ],
      },
      {
        topic: {
          id: "ads",
          label: "広告運用",
          emoji: "📢",
          priority: 2,
          keywords: [],
        },
        items: [
          {
            title: "P-MAXキャンペーンの新しいアセットグループ機能が全アカウントに展開",
            summary:
              "アセットグループ単位でのレポーティングが可能に。チャネル別の貢献度が見える化。",
            insight:
              "受託クライアントのP-MAXレポートが改善できる。次回の月次報告に反映を。",
            url: "https://x.com/example/status/9876543210",
            source: "x",
            topicId: "ads",
          },
        ],
      },
      {
        topic: {
          id: "ai",
          label: "Claude / AI",
          emoji: "🤖",
          priority: 5,
          keywords: [],
        },
        items: [
          {
            title: "Claude CodeにMCPサーバー連携の新機能が追加",
            summary:
              "外部ツール（Slack・Notion・Google等）との連携がより簡単に。設定ファイルベースで管理可能。",
            insight:
              "AI秘書サービスの構築効率が上がる。クライアント導入時のセットアップ工数削減に直結。",
            url: "https://x.com/example/status/1111111111",
            source: "x",
            topicId: "ai",
          },
          {
            title: "非エンジニアのためのAIエージェント活用術｜業務自動化の実践例10選",
            summary:
              "中小企業の非エンジニアがAIエージェントで業務自動化に成功した事例集。日報・レポート・データ収集が中心。",
            insight:
              "AI秘書サービスの提案資料で使える事例。特に日報自動化の効果数値が参考になる。",
            url: "https://youtube.com/watch?v=example2",
            source: "youtube",
            topicId: "ai",
            metadata: { duration: "22分" },
          },
          {
            title: "Anthropic、Claude 4.5ファミリーの最新ベンチマーク公開",
            summary:
              "コーディング・分析タスクでGPT-4oを大幅に上回るスコア。日本語性能も向上。",
            insight:
              "AI秘書の基盤モデルとしてClaude選択の妥当性を裏付けるデータ。けんさんへの説明材料にも。",
            url: "https://x.com/example/status/2222222222",
            source: "x",
            topicId: "ai",
          },
        ],
      },
    ],
  };
}
