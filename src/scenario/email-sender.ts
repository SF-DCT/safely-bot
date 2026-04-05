import { env } from "../config/env.js";

/**
 * シナリオ用メール送信（新規メール — 返信ではない）
 * 既存 gmail.ts の OAuth + RFC 2822 構築パターンを流用
 */

const GMAIL_CONFIG = {
  clientId: env.GMAIL_CLIENT_ID || "",
  clientSecret: env.GMAIL_CLIENT_SECRET || "",
  refreshToken: env.GMAIL_REFRESH_TOKEN || "",
};

async function getAccessToken(): Promise<string> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GMAIL_CONFIG.clientId,
      client_secret: GMAIL_CONFIG.clientSecret,
      refresh_token: GMAIL_CONFIG.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = await response.json();
  if (!data.access_token) {
    throw new Error(`Gmail token error: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

function buildRawEmail(
  to: string,
  subject: string,
  body: string,
  fromName?: string,
): string {
  const fromHeader = fromName
    ? `From: =?UTF-8?B?${Buffer.from(fromName).toString("base64")}?= <takahashi@safely.co.jp>`
    : `From: takahashi@safely.co.jp`;

  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`;

  const lines = [
    fromHeader,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    `Content-Type: text/plain; charset=UTF-8`,
    "",
    body,
  ];
  return lines.join("\r\n");
}

function encodeRawEmail(raw: string): string {
  return Buffer.from(raw)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Gmail API で新規メールを送信する
 */
export async function sendScenarioEmail(
  to: string,
  subject: string,
  body: string,
  fromName?: string,
): Promise<SendEmailResult> {
  if (!GMAIL_CONFIG.refreshToken) {
    return { success: false, error: "Gmail API未設定 (GMAIL_REFRESH_TOKEN)" };
  }

  try {
    const accessToken = await getAccessToken();
    const rawEmail = buildRawEmail(to, subject, body, fromName);
    const encodedMessage = encodeRawEmail(rawEmail);

    const sendUrl = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
    const sendRes = await fetch(sendUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: encodedMessage }),
    });

    const sendData = (await sendRes.json()) as {
      id?: string;
      error?: unknown;
    };

    if (sendData.error) {
      return { success: false, error: JSON.stringify(sendData.error) };
    }

    return { success: true, messageId: sendData.id };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}
