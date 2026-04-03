import { env } from "../config/env.js";
import { createHash } from "crypto";

// ============================================================
// 拡張CV（Enhanced Conversions for Leads）
// 電話番号ハッシュ方式で Salesforce 成約データを Google Ads にアップロード
// ============================================================

const GOOGLE_ADS_CONFIG = {
  developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN || "",
  clientId: env.GOOGLE_ADS_CLIENT_ID || "",
  clientSecret: env.GOOGLE_ADS_CLIENT_SECRET || "",
  refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN || "",
  loginCustomerId: "6331113053",
};

// Salesforce接続: sfdx CLIの代わりにJSORP REST APIを使う場合はここを差し替え
// 現在はsfdx CLI経由（Railway上ではSalesforce REST APIに切り替え予定）
const SF_ORG = "tenpo-org";

interface BrandConfig {
  name: string;
  chargeStore: string;
  customerId: string;
  conversionActionId: number;
  conversionActionName: string;
}

const BRANDS: Record<string, BrandConfig> = {
  SKH: {
    name: "粗大ゴミ回収本舗",
    chargeStore: "粗大ゴミ回収本舗",
    customerId: "6859397119",
    conversionActionId: 7558331234,
    conversionActionName: "SKH_成約_拡張CV",
  },
  SKT: {
    name: "粗大ゴミ回収隊",
    chargeStore: "粗大ゴミ回収隊",
    customerId: "5309755245",
    conversionActionId: 7558532344,
    conversionActionName: "SKT_成約_拡張CV",
  },
  ES: {
    name: "粗大ゴミ回収サービス",
    chargeStore: "粗大ゴミ回収サービス",
    customerId: "7549098205",
    conversionActionId: 7558683534,
    conversionActionName: "ES_成約_拡張CV",
  },
};

interface SfRecord {
  Id: string;
  PLA_Phone__c: string;
  StageName: string;
  Amount: number;
  CloseDate: string;
}

interface BrandResult {
  brand: string;
  brandName: string;
  records: number;
  totalValue: number;
  success: number;
  errors: number;
  errMsg: string;
}

// 電話番号正規化 → SHA256ハッシュ
function normalizePhone(phone: string): string {
  const digits = phone.replace(/[^\d]/g, "");
  if (digits.startsWith("0") && digits.length >= 10) {
    return "+81" + digits.slice(1);
  }
  if (!digits.startsWith("81")) {
    return "+81" + digits;
  }
  return "+" + digits;
}

function hashPhone(phone: string): string {
  const normalized = normalizePhone(phone);
  return createHash("sha256").update(normalized).digest("hex");
}

// Google Ads OAuth2 access token取得
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

// Salesforce OAuth2 refresh tokenでアクセストークン取得
async function getSalesforceAccessToken(): Promise<{
  accessToken: string;
  instanceUrl: string;
}> {
  const clientId = env.SALESFORCE_CLIENT_ID;
  const clientSecret = env.SALESFORCE_CLIENT_SECRET;
  const refreshToken = env.SALESFORCE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("SF_NOT_CONFIGURED");
  }

  const response = await fetch(
    `${env.SALESFORCE_INSTANCE_URL}/services/oauth2/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    },
  );

  const data = await response.json();
  if (!data.access_token) {
    throw new Error(
      `Salesforce token refresh failed: ${JSON.stringify(data)}`,
    );
  }

  return {
    accessToken: data.access_token,
    instanceUrl: data.instance_url || env.SALESFORCE_INSTANCE_URL,
  };
}

// Salesforce REST API でデータ取得
async function fetchSalesforceData(
  brandCode: string,
  daysBack: number,
): Promise<SfRecord[]> {
  const brand = BRANDS[brandCode];
  if (!brand) throw new Error(`Unknown brand: ${brandCode}`);

  // Salesforce REST API（OAuth refresh token方式）
  let accessToken: string;
  let instanceUrl: string;
  try {
    const sf = await getSalesforceAccessToken();
    accessToken = sf.accessToken;
    instanceUrl = sf.instanceUrl;
  } catch (e) {
    if (e instanceof Error && e.message === "SF_NOT_CONFIGURED") {
      // sfdx CLI fallback（ローカル開発用）
      return fetchSalesforceViaSfdx(brandCode, daysBack);
    }
    throw e;
  }

  const query =
    `SELECT Id, PLA_Phone__c, StageName, Amount, CloseDate ` +
    `FROM Opportunity ` +
    `WHERE PLA_Phone__c != null ` +
    `AND Account.ChargeStore__c = '${brand.chargeStore}' ` +
    `AND StageName = '成立' ` +
    `AND Amount != null ` +
    `AND CloseDate >= LAST_N_DAYS:${daysBack} ` +
    `ORDER BY CloseDate DESC`;

  const response = await fetch(
    `${instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(query)}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  const data = await response.json();
  if (data.errorCode) {
    throw new Error(
      `Salesforce error: ${data.message || JSON.stringify(data)}`,
    );
  }

  return (data.records || []) as SfRecord[];
}

// sfdx CLI fallback（ローカル開発用）
async function fetchSalesforceViaSfdx(
  brandCode: string,
  daysBack: number,
): Promise<SfRecord[]> {
  const { execSync } = await import("child_process");
  const brand = BRANDS[brandCode];

  const query =
    `SELECT Id, PLA_Phone__c, StageName, Amount, CloseDate ` +
    `FROM Opportunity ` +
    `WHERE PLA_Phone__c != null ` +
    `AND Account.ChargeStore__c = '${brand.chargeStore}' ` +
    `AND StageName = '成立' ` +
    `AND Amount != null ` +
    `AND CloseDate >= LAST_N_DAYS:${daysBack} ` +
    `ORDER BY CloseDate DESC`;

  const result = execSync(
    `sfdx force:data:soql:query -q "${query.replace(/"/g, '\\"')}" -o ${SF_ORG} --result-format json`,
    { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
  );

  const data = JSON.parse(result);
  return (data.result?.records || []) as SfRecord[];
}

// Google Ads Enhanced Conversions アップロード（REST API直接呼び出し）
async function uploadToGoogleAds(
  brandCode: string,
  records: SfRecord[],
): Promise<{ success: number; errors: number; errMsg: string }> {
  const brand = BRANDS[brandCode];
  const accessToken = await getAccessToken();

  // ClickConversion オブジェクト配列を構築
  const conversions = records.map((r) => ({
    conversionAction: `customers/${brand.customerId}/conversionActions/${brand.conversionActionId}`,
    conversionDateTime: `${r.CloseDate} 12:00:00+09:00`,
    conversionValue: r.Amount,
    currencyCode: "JPY",
    userIdentifiers: [
      {
        hashedPhoneNumber: hashPhone(r.PLA_Phone__c),
      },
    ],
  }));

  const response = await fetch(
    `https://googleads.googleapis.com/v23/customers/${brand.customerId}:uploadClickConversions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "developer-token": GOOGLE_ADS_CONFIG.developerToken,
        "login-customer-id": GOOGLE_ADS_CONFIG.loginCustomerId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        conversions,
        partialFailure: true,
      }),
    },
  );

  const data = await response.json();

  if (data.error) {
    return {
      success: 0,
      errors: records.length,
      errMsg: data.error.message || JSON.stringify(data.error),
    };
  }

  const results = data.results || [];
  let success = 0;
  let errors = 0;
  for (const result of results) {
    if (result.conversionAction) {
      success++;
    } else {
      errors++;
    }
  }

  const errMsg = data.partialFailureError?.message || "";

  return { success, errors, errMsg };
}

// ============================================================
// 公開API
// ============================================================

/**
 * 全ブランド（SKH/SKT/ES）の拡張CVアップロードを実行
 * @param daysBack 取得日数（デフォルト: 2日）
 * @returns Slack向けサマリー文字列
 */
export async function runEnhancedCvUpload(
  daysBack: number = 2,
): Promise<string> {
  const brandCodes = Object.keys(BRANDS);
  const results: BrandResult[] = [];

  for (const code of brandCodes) {
    const brand = BRANDS[code];
    try {
      console.log(`[拡張CV] ${code}（${brand.name}）データ取得中...`);
      const records = await fetchSalesforceData(code, daysBack);

      if (records.length === 0) {
        results.push({
          brand: code,
          brandName: brand.name,
          records: 0,
          totalValue: 0,
          success: 0,
          errors: 0,
          errMsg: "",
        });
        continue;
      }

      const totalValue = records.reduce((sum, r) => sum + (r.Amount || 0), 0);
      console.log(
        `[拡張CV] ${code}: ${records.length}件 / ${totalValue.toLocaleString()}円 → アップロード中...`,
      );

      const uploadResult = await uploadToGoogleAds(code, records);

      results.push({
        brand: code,
        brandName: brand.name,
        records: records.length,
        totalValue,
        ...uploadResult,
      });

      console.log(
        `[拡張CV] ${code}: 成功=${uploadResult.success}, エラー=${uploadResult.errors}`,
      );
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error(`[拡張CV] ${code} エラー:`, errMsg);
      results.push({
        brand: code,
        brandName: brand.name,
        records: 0,
        totalValue: 0,
        success: 0,
        errors: 0,
        errMsg,
      });
    }
  }

  return formatResults(results, daysBack);
}

/**
 * 特定ブランドの拡張CVアップロードを実行
 */
export async function runEnhancedCvUploadForBrand(
  brandCode: string,
  daysBack: number = 2,
): Promise<string> {
  const code = brandCode.toUpperCase();
  const brand = BRANDS[code];
  if (!brand) {
    return `ブランド「${brandCode}」が見つかりません。利用可能: ${Object.keys(BRANDS).join(", ")}`;
  }

  try {
    const records = await fetchSalesforceData(code, daysBack);
    if (records.length === 0) {
      return `${brand.name}（${code}）: 直近${daysBack}日間にアップロード対象のデータがありません。`;
    }

    const totalValue = records.reduce((sum, r) => sum + (r.Amount || 0), 0);
    const uploadResult = await uploadToGoogleAds(code, records);

    const lines = [
      `【${brand.name}（${code}）拡張CVアップロード結果】`,
      `期間: 直近${daysBack}日間`,
      `対象件数: ${records.length}件`,
      `成約金額合計: ${totalValue.toLocaleString()}円`,
      `アップロード: 成功=${uploadResult.success}, エラー=${uploadResult.errors}`,
    ];

    if (uploadResult.errMsg) {
      lines.push(`エラー詳細: ${uploadResult.errMsg.slice(0, 200)}`);
    }

    return lines.join("\n");
  } catch (e) {
    return `${code} エラー: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function formatResults(results: BrandResult[], daysBack: number): string {
  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  const totalRecords = results.reduce((s, r) => s + r.records, 0);
  const totalValue = results.reduce((s, r) => s + r.totalValue, 0);
  const totalSuccess = results.reduce((s, r) => s + r.success, 0);
  const totalErrors = results.reduce((s, r) => s + r.errors, 0);

  const lines = [
    `:arrows_counterclockwise: *拡張CV自動アップロード結果*`,
    `実行: ${now} / 対象: 直近${daysBack}日間`,
    "",
  ];

  for (const r of results) {
    const status =
      r.records === 0
        ? "対象なし"
        : r.errors === 0
          ? `:white_check_mark: 全${r.success}件成功`
          : `:warning: 成功=${r.success}, エラー=${r.errors}`;
    lines.push(
      `*${r.brand}*（${r.brandName}）: ${r.records}件 / ${r.totalValue.toLocaleString()}円 — ${status}`,
    );
    if (r.errMsg) {
      lines.push(`  _${r.errMsg.slice(0, 150)}_`);
    }
  }

  lines.push("");
  lines.push(
    `*合計*: ${totalRecords}件 / ${totalValue.toLocaleString()}円 / 成功=${totalSuccess}, エラー=${totalErrors}`,
  );

  return lines.join("\n");
}
