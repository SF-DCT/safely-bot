import { env } from "../config/env.js";

const GOOGLE_ADS_CONFIG = {
  developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN || "",
  clientId: env.GOOGLE_ADS_CLIENT_ID || "",
  clientSecret: env.GOOGLE_ADS_CLIENT_SECRET || "",
  refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN || "",
  loginCustomerId: "6331113053",
};

// アカウント情報
const ACCOUNTS: Record<string, { customerId: string; name: string }> = {
  SKH: { customerId: "6859397119", name: "粗大ゴミ回収本舗" },
  SKT: { customerId: "5309755245", name: "粗大ゴミ回収隊" },
  ES: { customerId: "7549098205", name: "粗大ゴミ回収サービス" },
  "SKH-H": { customerId: "9385710005", name: "回収本舗-福岡" },
  "SKT-N": { customerId: "7083718970", name: "回収隊-名古屋" },
  ISCL: { customerId: "9049601494", name: "クリーンライフ" },
  ISWC: { customerId: "2622557846", name: "水廻り修理サポートセンター" },
  ISCB: { customerId: "7208749580", name: "クリーンライフハチ駆除" },
  TC: { customerId: "5834042025", name: "水道修理のセーフリー" },
};

async function getAccessToken(): Promise<string> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_ADS_CONFIG.clientId,
      client_secret: GOOGLE_ADS_CONFIG.clientSecret,
      refresh_token: GOOGLE_ADS_CONFIG.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = await response.json();
  if (!data.access_token) {
    throw new Error(`Failed to get access token: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function executeGaql(
  customerId: string,
  query: string,
): Promise<unknown[]> {
  const accessToken = await getAccessToken();

  const response = await fetch(
    `https://googleads.googleapis.com/v23/customers/${customerId}/googleAds:searchStream`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "developer-token": GOOGLE_ADS_CONFIG.developerToken,
        "login-customer-id": GOOGLE_ADS_CONFIG.loginCustomerId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );

  const data = await response.json();
  if (data.error) {
    throw new Error(
      `Google Ads API error: ${data.error.message || JSON.stringify(data.error)}`,
    );
  }

  // searchStream returns array of batches
  const results: unknown[] = [];
  if (Array.isArray(data)) {
    for (const batch of data) {
      if (batch.results) {
        results.push(...batch.results);
      }
    }
  }
  return results;
}

// アカウントコードを解決
function resolveAccount(input: string): {
  code: string;
  customerId: string;
  name: string;
} | null {
  const upper = input.toUpperCase().trim();

  // 直接コードで指定
  if (ACCOUNTS[upper]) {
    return { code: upper, ...ACCOUNTS[upper] };
  }

  // 日本語名で検索
  for (const [code, info] of Object.entries(ACCOUNTS)) {
    if (
      info.name.includes(input) ||
      input.includes(info.name) ||
      input.includes(code.toLowerCase())
    ) {
      return { code, ...info };
    }
  }

  return null;
}

// 日付範囲ヘルパー
function getDateRange(period: string): { start: string; end: string } {
  const now = new Date();
  const today = now.toISOString().split("T")[0];

  switch (period) {
    case "today": {
      return { start: today, end: today };
    }
    case "yesterday": {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      return {
        start: yesterday.toISOString().split("T")[0],
        end: yesterday.toISOString().split("T")[0],
      };
    }
    case "this_week": {
      const monday = new Date(now);
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
      return { start: monday.toISOString().split("T")[0], end: today };
    }
    case "last_week": {
      const lastMonday = new Date(now);
      lastMonday.setDate(
        lastMonday.getDate() - ((lastMonday.getDay() + 6) % 7) - 7,
      );
      const lastSunday = new Date(lastMonday);
      lastSunday.setDate(lastSunday.getDate() + 6);
      return {
        start: lastMonday.toISOString().split("T")[0],
        end: lastSunday.toISOString().split("T")[0],
      };
    }
    case "this_month": {
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start: firstDay.toISOString().split("T")[0], end: today };
    }
    case "last_month": {
      const firstDay = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastDay = new Date(now.getFullYear(), now.getMonth(), 0);
      return {
        start: firstDay.toISOString().split("T")[0],
        end: lastDay.toISOString().split("T")[0],
      };
    }
    default:
      return { start: today, end: today };
  }
}

// 公開API: 広告パフォーマンスデータ取得
export async function getAdsPerformance(
  accountCode: string,
  period: string,
): Promise<string> {
  const account = resolveAccount(accountCode);
  if (!account) {
    const available = Object.entries(ACCOUNTS)
      .map(([code, info]) => `${code}（${info.name}）`)
      .join("、");
    return `アカウント「${accountCode}」が見つかりません。利用可能なアカウント: ${available}`;
  }

  const { start, end } = getDateRange(period);

  const query = `
    SELECT
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions,
      metrics.conversions_value,
      metrics.ctr,
      metrics.average_cpc
    FROM customer
    WHERE segments.date BETWEEN '${start}' AND '${end}'
  `;

  try {
    const results = await executeGaql(account.customerId, query);

    if (results.length === 0) {
      return `${account.name}（${account.code}）の${start}〜${end}のデータはありません。`;
    }

    // 集計
    let totalCost = 0;
    let totalImpressions = 0;
    let totalClicks = 0;
    let totalConversions = 0;
    let totalConversionsValue = 0;

    for (const row of results as Array<{
      metrics?: {
        costMicros?: string;
        impressions?: string;
        clicks?: string;
        conversions?: number;
        conversionsValue?: number;
      };
    }>) {
      const m = row.metrics;
      if (m) {
        totalCost += parseInt(m.costMicros || "0") / 1_000_000;
        totalImpressions += parseInt(m.impressions || "0");
        totalClicks += parseInt(m.clicks || "0");
        totalConversions += m.conversions || 0;
        totalConversionsValue += m.conversionsValue || 0;
      }
    }

    const ctr =
      totalImpressions > 0
        ? ((totalClicks / totalImpressions) * 100).toFixed(2)
        : "0";
    const cpc = totalClicks > 0 ? Math.round(totalCost / totalClicks) : 0;
    const cpa =
      totalConversions > 0 ? Math.round(totalCost / totalConversions) : 0;

    return [
      `【${account.name}（${account.code}）広告パフォーマンス】`,
      `期間: ${start} 〜 ${end}`,
      `広告費: ¥${Math.round(totalCost).toLocaleString()}`,
      `表示回数: ${totalImpressions.toLocaleString()}`,
      `クリック数: ${totalClicks.toLocaleString()}`,
      `CTR: ${ctr}%`,
      `平均CPC: ¥${cpc.toLocaleString()}`,
      `CV数: ${totalConversions.toFixed(1)}`,
      `CV値: ¥${Math.round(totalConversionsValue).toLocaleString()}`,
      totalConversions > 0 ? `CPA: ¥${cpa.toLocaleString()}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  } catch (error) {
    return `データ取得エラー: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// 公開API: 全アカウントサマリー
export async function getAdsAccountList(): Promise<string> {
  const lines = ["【管理アカウント一覧】"];
  for (const [code, info] of Object.entries(ACCOUNTS)) {
    lines.push(`• ${code} — ${info.name}（${info.customerId}）`);
  }
  return lines.join("\n");
}
