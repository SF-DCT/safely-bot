import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import { ACCOUNTS, executeGaql } from "./google-ads.js";
import { readRange, writeRange } from "./google-sheets.js";

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
  /**
   * false = 広告運用停止中。書き込み・日次レポートの対象外にする。
   * 再開時は true に戻すだけでよい（設定自体は残す）。
   */
  active: boolean;
  /**
   * skipWrite=true のPFで、実際に入力された金額を照合するための列。
   * mamo は書き込まないが、別経路（Google Ads Script等）の入力漏れを検知する。
   */
  verifyColumn?: string;
}

const PROJECT_SHEET_CONFIG: PfSheetConfig[] = [
  {
    pf: "SKH",
    spreadsheetId: "17KvIMMazAuHoJhW_nmVLNXWtbm7cKiLOcEeY-DpDoo4",
    tabFormat: "YYYY/M",
    googleAdColumn: "V",
    skipWrite: false,
    headerRows: 1,
    active: true,
  },
  {
    pf: "SKH-H",
    spreadsheetId: "1xkvX1yzyDbf0DlG8gDeh6gL-ie_o6aPWi0O87peqro8",
    tabFormat: "YYYY/M",
    googleAdColumn: "V",
    skipWrite: false,
    headerRows: 1,
    active: false, // 2026-07 広告運用停止
  },
  {
    pf: "SKT",
    spreadsheetId: "1VSLRYNL2PiVc5-MW4pQ3kZow9_bKGDk7REV3pA-MWyM",
    tabFormat: "YYYY/M",
    googleAdColumn: "U",
    skipWrite: false,
    headerRows: 1,
    active: true,
  },
  {
    pf: "SKT-N",
    spreadsheetId: "11s70R2WW81_FAlyyK7AmC6RJMUtiaxmsHm92VWBZJ_k",
    tabFormat: "YYYY/M",
    googleAdColumn: "U",
    skipWrite: false,
    headerRows: 1,
    active: false, // 2026-07 広告運用停止
  },
  {
    pf: "ES",
    spreadsheetId: "1r_6Sy5w_x8G8eUt73ctnM6k43OAWlSEtirGNw0G9f9s",
    tabFormat: "YYYY/M",
    googleAdColumn: "W",
    skipWrite: false,
    headerRows: 1,
    active: false, // 2026-07 広告運用停止
  },
  {
    pf: "OL",
    spreadsheetId: "1N_LIU0taTjhOuIGingKcayXNMIwj0L8PKW6cM47U8lo",
    tabFormat: "YYYY/M",
    googleAdColumn: "X",
    skipWrite: false,
    headerRows: 1,
    active: true,
  },
  {
    pf: "ND",
    spreadsheetId: "1v_wUW-gfm-lzpi_hPctfUAgPajF582ZBX1n0PYLdmPQ",
    tabFormat: "YYYY/M",
    googleAdColumn: "S",
    skipWrite: false,
    headerRows: 2, // カテゴリ行 + カラム名行
    active: false, // 2026-07 広告運用停止
  },
  {
    pf: "KM",
    spreadsheetId: "1WWWXt03_eoucLeFcQa9g0h9I-37PZTENmdX_ficTxTw",
    tabFormat: "YYYY/M",
    googleAdColumn: "S",
    skipWrite: false,
    headerRows: 2, // カテゴリ行 + カラム名行
    active: true,
  },
  {
    pf: "ISMS",
    spreadsheetId: "1a528BjpjpnckYluBTUH53Q1_S2HkOjcMxPWAgYJegA4",
    tabFormat: "YYYY年M月",
    googleAdColumn: "Z",
    skipWrite: false,
    headerRows: 1,
    active: true,
  },
  {
    pf: "ISWC",
    spreadsheetId: "1kfWz0n6z0iMR_X32sBwtp4jkfc5eIl782F3En0gGQxQ",
    tabFormat: "YYYYMM",
    googleAdColumn: "W",
    skipWrite: false,
    headerRows: 1,
    active: true,
  },
  {
    pf: "ISCB",
    spreadsheetId: "1uEQ-Y_VU8Lyro2O3YI3UPuP_RsdvaYOEIwZ-CzXnpcs",
    tabFormat: "YYYY/MM",
    googleAdColumn: "Q",
    skipWrite: false,
    headerRows: 1,
    active: true,
  },
  {
    pf: "ISCL",
    spreadsheetId: "1Vtp78whqV26U8pIIU0nsK4BerNwZF2FHVcroCLCLQKs",
    tabFormat: "YYYY年M月",
    googleAdColumn: "",
    skipWrite: true, // Google Ads Script で入力済み
    headerRows: 1,
    active: true,
    verifyColumn: "AF", // 合計Google広告費（Ads Scriptが入力）
  },
];

// 設定をエクスポート（ad-report.ts から参照）
export { PROJECT_SHEET_CONFIG };
export type { PfSheetConfig, TabFormat };

/** 広告運用中のPFのみ返す */
export const ACTIVE_PF_CONFIG = PROJECT_SHEET_CONFIG.filter((c) => c.active);

/** 停止中PFのコード一覧（レポートの注記用） */
export const PAUSED_PF_CODES = PROJECT_SHEET_CONFIG.filter(
  (c) => !c.active,
).map((c) => c.pf);

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

/** セル値を数値にパース（¥記号・カンマ除去） */
function parseYen(value: string | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  const cleaned = String(value).replace(/[¥,\s]/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

interface SyncResult {
  pf: string;
  cost: number;
  /**
   * ok       = mamoが書き込み済み
   * readonly = 別経路で入力済み（mamoは金額の参照のみ）
   * error    = 取得または書き込みに失敗
   */
  status: "ok" | "readonly" | "error";
  error?: string;
  /** readonly PFで検知した入力漏れ・乖離の注記 */
  warning?: string;
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

  // PF指定時は停止中PFも対象にする（手動での再入力を許可）
  const targets = filterPf
    ? PROJECT_SHEET_CONFIG.filter(
        (c) => c.pf.toUpperCase() === filterPf.toUpperCase(),
      )
    : ACTIVE_PF_CONFIG;

  if (filterPf && targets.length === 0) {
    return `⚠️ 不明なPFコード: ${filterPf}`;
  }

  for (const config of targets) {
    const tab = getTabName(date, config.tabFormat);
    const row = getRowForDay(day, config.headerRows);

    try {
      // 1. Google Ads API から広告費取得（書き込み有無に関わらず取得する）
      const cost = await getGoogleAdsCost(config.pf, dateStr);

      // 2a. 別経路で入力されるPF（ISCL等）は書き込まず、入力状況だけ照合する
      if (config.skipWrite) {
        let warning: string | undefined;

        if (config.verifyColumn) {
          const cell = `'${tab}'!${config.verifyColumn}${row}`;
          const sheetValue = parseYen(
            (await readRange(config.spreadsheetId, cell))[0]?.[0],
          );

          if (sheetValue === null || (sheetValue === 0 && cost > 0)) {
            warning = `シート未入力の可能性（${config.verifyColumn}${row}が空/0）`;
          } else if (
            cost > 0 &&
            Math.abs(sheetValue - cost) > Math.max(1000, cost * 0.1)
          ) {
            warning = `シート値と乖離（シート ¥${sheetValue.toLocaleString()} / API ¥${cost.toLocaleString()}）`;
          }
        }

        results.push({ pf: config.pf, cost, status: "readonly", warning });
        console.log(
          `[AdSpendSync] ${config.pf}: ¥${cost.toLocaleString()} (readonly)${warning ? ` ⚠️ ${warning}` : ""}`,
        );
        continue;
      }

      // 2b. スプレッドシートに書き込み
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

  // ok / readonly は設定順のまま金額を出す（ISCL等も数値を必ず表示する）
  const valueResults = results.filter(
    (r) => r.status === "ok" || r.status === "readonly",
  );
  const errorResults = results.filter((r) => r.status === "error");

  if (valueResults.length > 0) {
    for (const r of valueResults) {
      const note =
        r.status === "readonly" ? "（Ads Script入力・mamoは参照のみ）" : "";
      lines.push(`  ${r.pf}: ¥${r.cost.toLocaleString()}${note}`);
    }
    const total = valueResults.reduce((sum, r) => sum + r.cost, 0);
    lines.push(`  合計: ¥${total.toLocaleString()}`);
  }

  if (PAUSED_PF_CODES.length > 0) {
    lines.push("", `停止中（対象外）: ${PAUSED_PF_CODES.join(", ")}`);
  }

  const warnResults = valueResults.filter((r) => r.warning);
  if (warnResults.length > 0) {
    lines.push("", "--- 要確認 ---");
    for (const r of warnResults) {
      lines.push(`  ${r.pf}: ${r.warning}`);
    }
  }

  if (errorResults.length > 0) {
    lines.push("", "--- エラー ---");
    for (const r of errorResults) {
      lines.push(`  ${r.pf}: ${r.error}`);
    }
  }

  return lines.join("\n");
}
