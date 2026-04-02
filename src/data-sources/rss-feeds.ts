import type { WebSearchResult } from "./web-search.js";

/**
 * RSSフィードの定義
 */
interface RSSFeedConfig {
  url: string;
  topicId: string;
  source: "x" | "youtube";
}

/**
 * トピック別のRSSフィード一覧
 * nitter.netの代替としてRSSブリッジやRSSフィードを利用
 */
const RSS_FEEDS: RSSFeedConfig[] = [
  // SEO系
  { url: "https://webtan.impress.co.jp/rss", topicId: "seo", source: "x" },
  { url: "https://www.suzukikenichi.com/blog/feed/", topicId: "seo", source: "x" },
  // 広告運用系
  { url: "https://markezine.jp/rss/new/20/index.xml", topicId: "ads", source: "x" },
  // WEBマーケティング系
  { url: "https://ferret-plus.com/feed", topicId: "webmarketing", source: "x" },
  // AI系
  { url: "https://www.anthropic.com/rss.xml", topicId: "ai", source: "x" },
];

/**
 * 単一のRSSフィードを取得・パース（簡易XML解析）
 */
async function fetchRSSFeed(feed: RSSFeedConfig): Promise<WebSearchResult[]> {
  try {
    const res = await fetch(feed.url, {
      headers: { "User-Agent": "SAFELY-Bot/1.0" },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      throw new Error(`RSS fetch error: ${res.status}`);
    }

    const xml = await res.text();
    return parseRSSItems(xml, feed);
  } catch (e) {
    console.error(`[RSS] ${feed.url} failed:`, e);
    return [];
  }
}

/**
 * 簡易XMLパーサー（RSSの<item>を抽出）
 */
function parseRSSItems(
  xml: string,
  feed: RSSFeedConfig,
): WebSearchResult[] {
  const items: WebSearchResult[] = [];
  // <item>...</item> または <entry>...</entry> を抽出
  const itemRegex = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
  let match: RegExpExecArray | null;

  let count = 0;
  while ((match = itemRegex.exec(xml)) !== null && count < 5) {
    const content = match[1];

    const title = extractTag(content, "title");
    const link =
      extractTag(content, "link") ||
      extractAttr(content, "link", "href");
    const description =
      extractTag(content, "description") ||
      extractTag(content, "summary") ||
      extractTag(content, "content");

    if (title && link) {
      items.push({
        title: stripHTML(title),
        url: link.trim(),
        snippet: stripHTML(description || "").slice(0, 200),
        source: feed.source,
        topicId: feed.topicId,
      });
      count++;
    }
  }

  return items;
}

function extractTag(xml: string, tag: string): string | null {
  // Handle CDATA
  const cdataRegex = new RegExp(
    `<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`,
    "i",
  );
  const cdataMatch = cdataRegex.exec(xml);
  if (cdataMatch) return cdataMatch[1];

  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const match = regex.exec(xml);
  return match ? match[1] : null;
}

function extractAttr(
  xml: string,
  tag: string,
  attr: string,
): string | null {
  const regex = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, "i");
  const match = regex.exec(xml);
  return match ? match[1] : null;
}

function stripHTML(str: string): string {
  return str
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 全RSSフィードを並列取得
 */
export async function fetchAllRSSFeeds(): Promise<WebSearchResult[]> {
  const results = await Promise.allSettled(
    RSS_FEEDS.map((feed) => fetchRSSFeed(feed)),
  );

  const allItems: WebSearchResult[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      allItems.push(...result.value);
    }
  }

  return allItems;
}
