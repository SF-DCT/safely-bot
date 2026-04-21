import { env } from "../config/env.js";

/**
 * Google Sheets API クライアント（OAuth2認証）
 * Gmail連携と同じパターンでリフレッシュトークンを使用
 */

async function getAccessToken(): Promise<string> {
  const clientId = env.GOOGLE_SHEETS_CLIENT_ID;
  const clientSecret = env.GOOGLE_SHEETS_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_SHEETS_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Google Sheets credentials not configured (GOOGLE_SHEETS_CLIENT_ID/SECRET/REFRESH_TOKEN)",
    );
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = await response.json();
  if (!data.access_token) {
    throw new Error(
      `Failed to get Sheets access token: ${JSON.stringify(data)}`,
    );
  }
  return data.access_token;
}

/**
 * スプレッドシートの範囲を読み取る
 */
export async function readRange(
  spreadsheetId: string,
  range: string,
): Promise<string[][]> {
  const accessToken = await getAccessToken();
  const encodedRange = encodeURIComponent(range);

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodedRange}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  const data = await response.json();
  if (data.error) {
    throw new Error(
      `Sheets API read error: ${data.error.message || JSON.stringify(data.error)}`,
    );
  }

  return data.values || [];
}

/**
 * スプレッドシートの範囲に値を書き込む
 * valueInputOption: USER_ENTERED で数式・書式を保持
 */
export async function writeRange(
  spreadsheetId: string,
  range: string,
  values: (string | number)[][],
): Promise<void> {
  const accessToken = await getAccessToken();
  const encodedRange = encodeURIComponent(range);

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodedRange}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values }),
    },
  );

  const data = await response.json();
  if (data.error) {
    throw new Error(
      `Sheets API write error: ${data.error.message || JSON.stringify(data.error)}`,
    );
  }
}

/**
 * 末尾に行を追加（spreadsheets.values.append）
 * 戻り値: 追加された行番号（1始まり）
 */
export async function appendRow(
  spreadsheetId: string,
  range: string,
  values: (string | number)[][],
): Promise<{ rowNumber: number; updatedRange: string }> {
  const accessToken = await getAccessToken();
  const encodedRange = encodeURIComponent(range);

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodedRange}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values }),
    },
  );

  const data = await response.json();
  if (data.error) {
    throw new Error(
      `Sheets API append error: ${data.error.message || JSON.stringify(data.error)}`,
    );
  }

  const updatedRange: string = data.updates?.updatedRange || "";
  const m = updatedRange.match(/!\D+(\d+):/);
  const rowNumber = m ? parseInt(m[1], 10) : 0;
  return { rowNumber, updatedRange };
}
