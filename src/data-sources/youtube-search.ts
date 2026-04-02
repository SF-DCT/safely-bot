import dayjs from "dayjs";
import type { BriefingTopic } from "../types/intelligence-briefing.js";
import type { WebSearchResult } from "./web-search.js";

/**
 * YouTube Data API v3 で動画を検索
 */
export async function searchYouTubeAPI(
  topic: BriefingTopic,
  afterDate: string, // "2026-04-01" format
): Promise<WebSearchResult[]> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.log(`[YouTube API] API key not configured, skipping ${topic.id}`);
    return [];
  }

  const query = topic.keywords.slice(0, 3).join(" ");
  const publishedAfter = dayjs(afterDate).toISOString();

  const params = new URLSearchParams({
    key: apiKey,
    q: query,
    type: "video",
    maxResults: "5",
    order: "date",
    publishedAfter,
    relevanceLanguage: "ja",
    part: "snippet",
  });

  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/search?${params}`,
    );

    if (!res.ok) {
      throw new Error(`YouTube API error: ${res.status}`);
    }

    const data = await res.json();
    return (data.items || []).map(
      (item: {
        id: { videoId: string };
        snippet: { title: string; description: string; channelTitle: string };
      }) => ({
        title: item.snippet.title,
        url: `https://youtube.com/watch?v=${item.id.videoId}`,
        snippet: item.snippet.description.slice(0, 200),
        source: "youtube" as const,
        topicId: topic.id,
        author: item.snippet.channelTitle,
      }),
    );
  } catch (e) {
    console.error(`[YouTube API] ${topic.id} failed:`, e);
    return [];
  }
}
