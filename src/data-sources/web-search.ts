import type { BriefingTopic } from "../types/intelligence-briefing.js";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source: "x" | "youtube";
  topicId: string;
}

/**
 * Google検索でX（Twitter）の投稿を検索
 */
export async function searchXPosts(
  topic: BriefingTopic,
  dateStr: string, // "2026-04-01" format
): Promise<WebSearchResult[]> {
  const keywords = topic.keywords.slice(0, 3).join(" OR ");
  const query = `site:x.com (${keywords}) after:${dateStr}`;

  try {
    const results = await googleSearch(query, 5);
    return results.map((r) => ({
      ...r,
      source: "x" as const,
      topicId: topic.id,
    }));
  } catch (e) {
    console.error(`[X search] ${topic.id} failed:`, e);
    return [];
  }
}

/**
 * Google検索でYouTubeの動画を検索
 */
export async function searchYouTubeVideos(
  topic: BriefingTopic,
  dateStr: string,
): Promise<WebSearchResult[]> {
  const keywords = topic.keywords.slice(0, 3).join(" OR ");
  const query = `site:youtube.com (${keywords}) after:${dateStr}`;

  try {
    const results = await googleSearch(query, 3);
    return results.map((r) => ({
      ...r,
      source: "youtube" as const,
      topicId: topic.id,
    }));
  } catch (e) {
    console.error(`[YouTube search] ${topic.id} failed:`, e);
    return [];
  }
}

/**
 * Google Custom Search API (free tier: 100 queries/day)
 * 環境変数がない場合はダミーデータを返す（テスト用）
 */
async function googleSearch(
  query: string,
  maxResults: number,
): Promise<{ title: string; url: string; snippet: string }[]> {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const cx = process.env.GOOGLE_SEARCH_CX;

  if (!apiKey || !cx) {
    console.log(`[WebSearch] API key not configured. Query: ${query}`);
    return [];
  }

  const params = new URLSearchParams({
    key: apiKey,
    cx,
    q: query,
    num: String(maxResults),
    lr: "lang_ja",
  });

  const res = await fetch(
    `https://www.googleapis.com/customsearch/v1?${params}`,
  );

  if (!res.ok) {
    throw new Error(`Google Search API error: ${res.status}`);
  }

  const data = await res.json();
  return (data.items || []).map(
    (item: { title: string; link: string; snippet: string }) => ({
      title: item.title,
      url: item.link,
      snippet: item.snippet || "",
    }),
  );
}
