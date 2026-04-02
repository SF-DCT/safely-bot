import dayjs from "dayjs";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/**
 * 日本語の日付フォーマット: "4月2日(水)"
 */
export function formatDateJapanese(date: Date): string {
  const d = dayjs(date);
  const weekday = WEEKDAYS[d.day()];
  return `${d.month() + 1}月${d.date()}日(${weekday})`;
}
