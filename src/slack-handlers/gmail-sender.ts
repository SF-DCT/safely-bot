import type { WebClient } from "@slack/web-api";
import { getUnreadEmails } from "../data-sources/gmail.js";
import { getClaudeClient } from "../utils/claude-client.js";
import { EMAIL_CONTEXT } from "../config/email-context.js";

const ANALYSIS_SYSTEM_PROMPT = `あなたはSAFELY Botです。Gmailの未読メールを分析し、返信が必要なメールを仕分けて返信案を提案します。

${EMAIL_CONTEXT}

## 出力ルール
- 返信案はそのまま送信できるクオリティで作成
- 優先度を明確に（🔴高 / 🟡中 / 🟢低）
- Slack上で読みやすいフォーマットで出力
- 各返信案の前にメールIDを必ず記載（後で送信に使う）`;

/**
 * Gmailチェック結果をClaude分析してSlack DMに送信
 */
export async function sendGmailDigest(
  client: WebClient,
  userId: string,
): Promise<void> {
  // 1. DMチャンネルを開く
  const dm = await client.conversations.open({ users: userId });
  const channelId = dm.channel?.id;
  if (!channelId) throw new Error("Failed to open DM channel");

  // 2. 未読メール取得（一次フィルタ済み）
  console.log("[Gmail] Fetching unread emails...");
  const emailData = await getUnreadEmails();

  // 未読メールなし
  if (
    emailData.includes("未読メールはありません") ||
    emailData.includes("返信候補のメールはありません")
  ) {
    await client.chat.postMessage({
      channel: channelId,
      text: `📬 *Gmail朝チェック*\n\n${emailData}`,
      mrkdwn: true,
    });
    return;
  }

  // 3. Claude で分析
  console.log("[Gmail] Analyzing with Claude...");
  const claude = getClaudeClient();
  const response = await claude.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    system: ANALYSIS_SYSTEM_PROMPT,
    messages: [{ role: "user", content: emailData }],
  });

  const analysis = response.content
    .filter((b) => b.type === "text")
    .map((b) => ("text" in b ? b.text : ""))
    .join("\n");

  // 4. Slack DMに送信
  const message = [
    "📬 *Gmail朝チェック*",
    "",
    analysis,
    "",
    "---",
    '💡 返信を送信したい場合は「○番のメールに返信して」と伝えてください。',
    '   下書き保存のみの場合は「○番の下書き作って」でOKです。',
  ].join("\n");

  await client.chat.postMessage({
    channel: channelId,
    text: message,
    mrkdwn: true,
  });

  console.log("[Gmail] Digest sent successfully.");
}
