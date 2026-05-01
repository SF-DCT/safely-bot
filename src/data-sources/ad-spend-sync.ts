import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import { ACCOUNTS, executeGaql } from "./google-ads.js";
import { writeRange } from "./google-sheets.js";

dayjs.extend(utc);
dayjs.extend(timezone);

// タブ名フォーマット
type TabFormat = "YYYY/M" | "YYYY/MM" | "YYYY年M月" | "YYYYMM";

// PF別スプレッドシート設定
interface PfSheetConfig {
  pf: string;
  spreadsheetId: string;
  tabFormat: TabFormat;
  googleAdColumn: string; // G検索広告費の列
  skipWrite: boolean; // true = 書き込みスキップ（ISCL等）
  headerRows: number; // ヘッダー行数（通常1、ND/KMは2）
}

const PROJECT_SHEET_CONFIG: PfSheetConfig[] = [
  {
    pf: "SKH",
    spreadsheetId: "17KvIMMazAuHoJhW_nmVLNXWtbm7cKiLOcEeY-DpDoo4",
    tabFormat: "YYYY/M",
    googleAdColumn: "V",
    skipWrite: false,
    headerRows: 1,
  },
  {
    pf: "SKH-H",
    spreadsheetId: "1xkvX1yzyDbf0DlG8gDeh6gL-ie_o6aPWi0O87peqro8",
    tabFormat: "YYYY/M",
    googleAdColumn: "V",
    skipWrite: false,
    headerRows: 1,
  },
  {
    pf: "SKT",
    spreadsheetId: "1VSLRYNL2PiVc5-MW4pQ3kZow9_bKGDk7REV3pA-MWyM",
    tabFormat: "YYYY/M",
    googleAdColumn: "U",
    skipWrite: false,
    headerRows: 1,
  },
  {
    pf: "SKT-N",
    spreadsheetId: "11s70R2WW81_FAlyyK7AmC6RJMUtiaxmsHm92VWBZJ_k",
    tabFormat: "YYYY/M",
    googleAdColumn: "U",
    skipWrite: false,
    headerRows: 1,
  },
  {
    pf: "ES",
    spreadsheetId: "1r_6Sy5w_x8G8eUt73ctnM6k43OAWlSEtirGNw0G9f9s",
    tabFormat: "YYYY/M",
    googleAdColumn: "W",
    skipWrite: false,
    headerRows: 1,
  },
  {
    pf: "OL",
    spreadsheetId: "1N_LIU0taTjhOuIGingKcayXNMIwj0L8PKW6cM47U8lo",
    tabFormat: "YYYY/M",
    googleAdColumn: "X",
    skipWrite: false,
    headerRows: 1,
  },
  {
    pf: "ND",
    spreadsheetId: "1v_wUW-gfm-lzpi_hPctfUAgPajF582ZBX1n0PYLdmPQ",
    tabFormat: "YYYY/M",
    googleAdColumn: "S",
    skipWrite: false,
    headerRows: 2, // カテゴリ行 + カラム名行
  },
  {
    pf: "KM",
    spreadsheetId: "1WWWXt03_eoucLeFcQa9g0h9I-37PZTENmdX_ficTxTw",
    tabFormat: "YYYY/M",
    googleAdColumn: "S",
    skipWrite: false,
    headerRows: 2, // カテゴリ行 + カラム名行
  },
  {
    pf: "ISMS",
    spreadsheetId: "1a528BjpjpnckYluBTUH53Q1_S2HkOjcMxPWAgYJegA4",
    tabFormat: "YYYY年M月",
    googleAdColumn: "Z",
    skipWrite: false,
    headerRows: 1,
  },
  {
    pf: "ISWC",
    spreadsheetId: "1kfWz0n6z0iMR_X32sBwtp4jkfc5eIl782F3En0gGQxQ",
    tabFormat: "YYYYMM",
    googleAdColumn: "W",
    skipWrite: false,
    headerRows: 1,
  },
  {
    pf: "ISCB",
    spreadsheetId: "1uEQ-Y_VU8Lyro2O3YI3UPuP_RsdvaYOEIwZ-CzXnpcs",
    tabFormat: "YYYY/MM",
    googleAdColumn: "Q",
    skipWrite: false,
    headerRows: 1,
  },
  {
    pf: "ISCL",
    spreadsheetId: "1Vtp78whqV26U8pIIU0nsK4BerNwZF2FHVcroCLCLQKs",
    tabFormat: "YYYY年M月",
    googleAdColumn: "",
    skipWrite: true, // Google Ads Script で入力済み
    headerRows: 1,
  },
];

// 設定をエクスポート（ad-report.ts から参照）
export { PROJECT_SHEET_CONFIG };
export type { PfSheetConfig, TabFormat };

/** タブ名を生成 */
export function getTabName(date: dayjs.Dayjs, format: TabFormat): string {
  switch (format) {
    case "YYYY/M":
      return `${date.year()}/${date.month() + 1}`;
    case "YYYY/MM":
      return date.format("YYYY/MM");
    case "YYYY年M月":
      return `${date.year()}年${date.month() + 1}月`;
    case "YYYYMM":
      return date.format("YYYYMM");
  }
}

/** 日付から行番号を算出（headerRows=1: row2=1日, headerRows=2: row3=1日） */
export function getRowForDay(day: number, headerRows: number): number {
  return day + headerRows;
}

/** Google Ads API から指定日の広告費（円）を取得 */
async function getGoogleAdsCost(
  pf: string,
  dateStr: string,
): Promise<number> {
  const account = ACCOUNTS[pf];
  if (!account) {
    throw new Error(`Google Adsアカウント未登録: ${pf}`);
  }

  const query = `
    SELECT metrics.cost_micros
    FROM customer
    WHERE segments.date = '${dateStr}'
  `;

  const results = await executeGaql(account.customerId, query);

  let totalCostMicros = 0;
  for (const row of results as Array<{
    metrics?: { costMicros?: string };
  }>) {
    totalCostMicros += parseInt(row.metrics?.costMicros || "0");
  }

  return Math.round(totalCostMicros / 1_000_000);
}

interface SyncResult {
  pf: string;
  cost: number;
  status: "ok" | "skip" | "error";
  error?: string;
}

/**
 * Google Ads の広告費を各PFのスプレッドシートに書き込む
 * @param targetDate 対象日（省略時は昨日 JST）
 */
export async function syncAdSpendToSheets(
  targetDate?: Date,
  filterPf?: string,
): Promise<string> {
  const date = targetDate
    ? dayjs(targetDate).tz("Asia/Tokyo")
    : dayjs().tz("Asia/Tokyo").subtract(1, "day");

  const dateStr = date.format("YYYY-MM-DD");
  const day = date.date();

  console.log(`[AdSpendSync] Syncing for ${dateStr}...`);

  const results: SyncResult[] = [];

  const targets = filterPf
    ? PROJECT_SHEET_CONFIG.filter(
        (c) => c.pf.toUpperCase() === filterPf.toUpperCase(),
      )
    : PROJECT_SHEET_CONFIG;

  if (filterPf && targets.length === 0) {
    return `⚠️ 不明なPFコード: ${filterPf}`;
  }

  for (const config of targets) {
    if (config.skipWrite) {
      results.push({ pf: config.pf, cost: 0, status: "skip" });
      continue;
    }

    try {
      // 1. Google Ads API から広告費取得
      const cost = await getGoogleAdsCost(config.pf, dateStr);

      // 2. スプレッドシートに書き込み
      const tab = getTabName(date, config.tabFormat);
      const row = getRowForDay(day, config.headerRows);
      const cell = `'${tab}'!${config.googleAdColumn}${row}`;
      await writeRange(config.spreadsheetId, cell, [[cost]]);

      results.push({ pf: config.pf, cost, status: "ok" });
      console.log(
        `[AdSpendSync] ${config.pf}: ¥${cost.toLocaleString()} → ${cell}`,
      );
    } catch (e) {
      const errorMsg =
        e instanceof Error ? e.message : String(e);
      results.push({
        pf: config.pf,
        cost: 0,
        status: "error",
        error: errorMsg,
      });
      console.error(`[AdSpendSync] ${config.pf} failed:`, errorMsg);
    }
  }

  return formatSyncReport(results, date);
}

/** Slack通知用のレポートテキストを生成 */
function formatSyncReport(
  results: SyncResult[],
  date: dayjs.Dayjs,
): string {
  const dateLabel = date.format("M/D(ddd)");
  const lines: string[] = [
    `【広告費自動入力完了】${dateLabel}`,
    "",
  ];

  const okResults = results.filter((r) => r.status === "ok");
  const skipResults = results.filter((r) => r.status === "skip");
  const errorResults = results.filter((r) => r.status === "error");

  if (okResults.length > 0) {
    for (const r of okResults) {
      lines.push(`  ${r.pf}: ¥${r.cost.toLocaleString()}`);
    }
    const total = okResults.reduce((sum, r) => sum + r.cost, 0);
    lines.push(`  合計: ¥${total.toLocaleString()}`);
  }

  if (skipResults.length > 0) {
    lines.push(
      "",
      `Skip: ${skipResults.map((r) => r.pf).join(", ")}（自動入力済み）`,
    );
  }

  if (errorResults.length > 0) {
    lines.push("", "--- エラー ---");
    for (const r of errorResults) {
      lines.push(`  ${r.pf}: ${r.error}`);
    }
  }

  return lines.join("\n");
}
