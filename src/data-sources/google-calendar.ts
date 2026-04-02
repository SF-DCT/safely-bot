import { google } from "googleapis";
import { env } from "../config/env.js";

/**
 * サービスアカウントで認証した Calendar クライアントを返す
 */
function getCalendarClient() {
  if (!env.GOOGLE_CLIENT_EMAIL || !env.GOOGLE_PRIVATE_KEY) {
    throw new Error("Google Calendar credentials not configured");
  }

  const auth = new google.auth.JWT(
    env.GOOGLE_CLIENT_EMAIL,
    undefined,
    env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    ["https://www.googleapis.com/auth/calendar.readonly"],
  );

  return google.calendar({ version: "v3", auth });
}

interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
}

/**
 * 指定日の予定一覧を取得
 */
async function getEventsForDate(date: Date): Promise<CalendarEvent[]> {
  const calendar = getCalendarClient();

  // JST での日の開始・終了を UTC に変換
  const jstDate = new Date(
    date.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }),
  );
  jstDate.setHours(0, 0, 0, 0);
  const timeMin = new Date(jstDate.getTime() - 9 * 3600 * 1000);
  const timeMax = new Date(timeMin.getTime() + 24 * 3600 * 1000);

  const res = await calendar.events.list({
    calendarId: env.GOOGLE_CALENDAR_ID,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  return (res.data.items || []).map((event) => ({
    summary: event.summary || "(タイトルなし)",
    start:
      event.start?.dateTime?.slice(11, 16) ||
      event.start?.date ||
      "",
    end:
      event.end?.dateTime?.slice(11, 16) ||
      event.end?.date ||
      "",
  }));
}

/**
 * 今日の予定を取得
 */
export async function getTodayEvents(): Promise<CalendarEvent[]> {
  try {
    return await getEventsForDate(new Date());
  } catch (e) {
    console.error("[GoogleCalendar] Failed to get today's events:", e);
    return [];
  }
}

/**
 * 明日の予定を取得
 */
export async function getTomorrowEvents(): Promise<CalendarEvent[]> {
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return await getEventsForDate(tomorrow);
  } catch (e) {
    console.error("[GoogleCalendar] Failed to get tomorrow's events:", e);
    return [];
  }
}

/**
 * 予定一覧をテキストにフォーマット
 */
export function formatEvents(events: CalendarEvent[]): string {
  if (events.length === 0) return "予定なし";
  return events
    .map((e) => `- ${e.start}〜${e.end} ${e.summary}`)
    .join("\n");
}
