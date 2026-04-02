import { Client } from "@notionhq/client";
import { env } from "../config/env.js";

function getNotionClient(): Client | null {
  if (!env.NOTION_API_KEY) return null;
  return new Client({ auth: env.NOTION_API_KEY });
}

export interface NotionPageSummary {
  title: string;
  url: string;
  type: "created" | "edited";
  lastEdited: string; // HH:mm
}

/**
 * 今日作成・編集された Notion ページを取得
 */
export async function getTodayNotionActivity(): Promise<NotionPageSummary[]> {
  const notion = getNotionClient();
  if (!notion) return [];

  // JST 今日の 0:00 を ISO 文字列で
  const now = new Date();
  const jst = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }),
  );
  jst.setHours(0, 0, 0, 0);
  const todayStartUtc = new Date(jst.getTime() - 9 * 3600 * 1000);
  const todayIso = todayStartUtc.toISOString();

  try {
    // 最近編集されたページを検索
    const response = await notion.search({
      filter: { property: "object", value: "page" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: 30,
    });

    const pages: NotionPageSummary[] = [];

    for (const page of response.results) {
      if (page.object !== "page" || !("last_edited_time" in page)) continue;

      const lastEdited = page.last_edited_time;
      if (!lastEdited || lastEdited < todayIso) continue;

      // タイトルを抽出
      let title = "(無題)";
      if ("properties" in page) {
        for (const prop of Object.values(page.properties)) {
          if (prop.type === "title" && "title" in prop) {
            const titleArr = prop.title as Array<{ plain_text: string }>;
            if (titleArr.length > 0) {
              title = titleArr.map((t) => t.plain_text).join("");
            }
            break;
          }
        }
      }

      // 作成 or 編集の判定
      const createdTime = "created_time" in page ? page.created_time : "";
      const isCreatedToday = createdTime >= todayIso;

      // 編集時刻を JST HH:mm に変換
      const editDate = new Date(lastEdited);
      const editJst = new Date(editDate.getTime() + 9 * 3600 * 1000);
      const hh = String(editJst.getUTCHours()).padStart(2, "0");
      const mm = String(editJst.getUTCMinutes()).padStart(2, "0");

      const url = "url" in page ? (page.url as string) : "";

      pages.push({
        title,
        url,
        type: isCreatedToday ? "created" : "edited",
        lastEdited: `${hh}:${mm}`,
      });
    }

    return pages;
  } catch (e) {
    console.error("[Notion] Failed to get today's activity:", e);
    return [];
  }
}

/**
 * Notion活動をテキストにフォーマット
 */
export function formatNotionActivity(pages: NotionPageSummary[]): string {
  if (pages.length === 0) return "";

  const created = pages.filter((p) => p.type === "created");
  const edited = pages.filter((p) => p.type === "edited");

  const lines: string[] = [];

  if (created.length > 0) {
    lines.push("【新規作成】");
    for (const p of created) {
      lines.push(`- ${p.title}（${p.lastEdited}）`);
    }
  }

  if (edited.length > 0) {
    lines.push("【更新】");
    for (const p of edited) {
      lines.push(`- ${p.title}（${p.lastEdited}）`);
    }
  }

  return lines.join("\n");
}
