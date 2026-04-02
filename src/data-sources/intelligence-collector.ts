import dayjs from "dayjs";
import { BRIEFING_TOPICS } from "../config/topics.js";
import { fetchAllRSSFeeds } from "./rss-feeds.js";
import type { WebSearchResult } from "./web-search.js";
import { searchYouTubeAPI } from "./youtube-search.js";

/**
 * 全ソース（YouTube API + RSS）から情報を並列収集する
 */
export async function collectAllSources(): Promise<WebSearchResult[]> {
  const yesterday = dayjs().subtract(1, "day").format("YYYY-MM-DD");

  // YouTube API: トピックごとに検索
  const youtubePromises = BRIEFING_TOPICS.map((topic) =>
    searchYouTubeAPI(topic, yesterday),
  );

  // RSS: 全フィードを取得
  const rssPromise = fetchAllRSSFeeds();

  const results = await Promise.allSettled([...youtubePromises, rssPromise]);

  const allItems: WebSearchResult[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      allItems.push(...result.value);
    }
  }

  // URLで重複除去
  const seen = new Set<string>();
  return allItems.filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}
