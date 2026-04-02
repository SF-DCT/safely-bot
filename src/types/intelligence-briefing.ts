export interface BriefingTopic {
  id: string;
  label: string;
  emoji: string;
  keywords: string[];
  priority: number; // lower = higher priority
}

export interface BriefingItem {
  title: string;
  summary: string;        // 1-2行の概要
  insight: string;        // 高橋さんの業務への示唆
  url: string;
  source: "x" | "youtube";
  topicId: string;
  publishedAt?: string;
  metadata?: {
    author?: string;
    duration?: string;     // YouTube動画の長さ
    engagement?: string;   // いいね数・RT数など
  };
}

export interface TopicSection {
  topic: BriefingTopic;
  items: BriefingItem[];
}

export interface IntelligenceBriefing {
  date: string;            // "4月2日(水)" format
  sections: TopicSection[];
  totalCount: number;
}
