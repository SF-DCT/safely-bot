/**
 * Markdown → Slack mrkdwn 変換
 * Claude APIのレスポンスをSlackで正しく表示するための変換ユーティリティ
 */
export function toSlackMrkdwn(text: string): string {
  let result = text;

  // **bold** → *bold* (Markdown → Slack mrkdwn)
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // ~~strikethrough~~ → ~strikethrough~ (Markdown → Slack mrkdwn)
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  // ### heading → *heading* (Markdown heading → Slack bold)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // [text](url) → <url|text> (Markdown link → Slack link)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  return result;
}
