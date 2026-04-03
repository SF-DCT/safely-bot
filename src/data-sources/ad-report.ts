import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import { readRange } from "./google-sheets.js";
import {
  PROJECT_SHEET_CONFIG,
  getTabName,
  type PfSheetConfig,
} from "./ad-spend-sync.js";

dayjs.extend(utc);
dayjs.extend(timezone);

// メイン予算管理シート
const BUDGET_SHEET_ID =
  "18NEKSUcCLUnhN6_Ah8dyFeybqX_whduYF1Uh90MYkT4";

// 予算シートのPFカラム順（C列〜O列）
const BUDGET_PF_ORDER = [
  "SKH",
  "SKH-H",
  "SKT",
  "SKT-N",
  "ES",
  "OL",
  "ND",
  "KM",
  "ISCL",
  "ISMS",
  "ISWC",
  "BF",
  "BP",
];

// PF別の問合せ列マッピング
const INQUIRY_COLUMN: Record<string, string> = {
  SKH: "E",
  "SKH-H": "E",
  SKT: "E",
  "SKT-N": "E",
  ES: "E",
  OL: "E",
  ND: "E",
  KM: "E",
  ISMS: "J",
  ISWC: "P",
  ISCL: "M",
};

// PF別のG広告費列マッピング（ad-spend-sync.tsのconfigから取得可能だが、
// レポートでは読み取り用なのでISCL含む全PFの列が必要）
const GOOGLE_AD_COLUMN: Record<string, string> = {
  SKH: "V",
  "SKH-H": "V",
  SKT: "T",
  "SKT-N": "U",
  ES: "W",
  OL: "W",
  ND: "S",
  KM: "S",
  ISMS: "Z",
  ISWC: "AL",
  ISCL: "AF", // ISCLのGoogle合計広告費列
};

/** セル値を数値にパース（¥記号、カンマ、「件」除去） */
function parseNumber(value: string | undefined): number {
  if (!value || value === "" || value === "#DIV/0!") return 0;
  const cleaned = value.replace(/[¥,件\s]/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

/** セル値を%にパース */
function parsePercent(value: string | undefined): number {
  if (!value || value === "" || value === "#DIV/0!") return 0;
  const cleaned = value.replace(/[%\s]/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

interface PfDailyData {
  pf: string;
  googleAdSpend: number;
  prevGoogleAdSpend: number;
  inquiries: number;
  prevInquiries: number;
  hasData: boolean;
  prevHasData: boolean;
}

interface BudgetData {
  pf: string;
  budgetRate: number; // 月着地予測換算（%）
}

/**
 * 各PFの日別データを読み取る（当日 + 前日）
 */
async function readProjectData(
  date: dayjs.Dayjs,
): Promise<PfDailyData[]> {
  const day = date.date();
  const row = day + 1; // 当日行
  const prevRow = day; // 前日行（= day+1-1）

  const results: PfDailyData[] = [];

  for (const config of PROJECT_SHEET_CONFIG) {
    const tab = getTabName(date, config.tabFormat);
    const googleCol = GOOGLE_AD_COLUMN[config.pf];
    const inquiryCol = INQUIRY_COLUMN[config.pf];

    if (!googleCol || !inquiryCol) continue;

    try {
      // 当日と前日のG広告費 + 問合せ数を一括で読む
      // 前日が1日の場合（prevRow=1=ヘッダー行）、前日データはなし
      const hasPrevDay = day > 1;

      // G広告費: 当日
      const adData = await readRange(
        config.spreadsheetId,
        `'${tab}'!${googleCol}${row}`,
      );
      const googleAdSpend = parseNumber(adData[0]?.[0]);

      // G広告費: 前日
      let prevGoogleAdSpend = 0;
      if (hasPrevDay) {
        const prevAdData = await readRange(
          config.spreadsheetId,
          `'${tab}'!${googleCol}${prevRow}`,
        );
        prevGoogleAdSpend = parseNumber(prevAdData[0]?.[0]);
      }

      // 問合せ: 当日
      const inqData = await readRange(
        config.spreadsheetId,
        `'${tab}'!${inquiryCol}${row}`,
      );
      const inquiries = parseNumber(inqData[0]?.[0]);
      const hasData = inqData[0]?.[0] !== undefined && inqData[0]?.[0] !== "";

      // 問合せ: 前日
      let prevInquiries = 0;
      let prevHasData = false;
      if (hasPrevDay) {
        const prevInqData = await readRange(
          config.spreadsheetId,
          `'${tab}'!${inquiryCol}${prevRow}`,
        );
        prevInquiries = parseNumber(prevInqData[0]?.[0]);
        prevHasData =
          prevInqData[0]?.[0] !== undefined && prevInqData[0]?.[0] !== "";
      }

      results.push({
        pf: config.pf,
        googleAdSpend,
        prevGoogleAdSpend,
        inquiries,
        prevInquiries,
        hasData,
        prevHasData,
      });
    } catch (e) {
      console.error(
        `[AdReport] ${config.pf} data read failed:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  return results;
}

/**
 * メイン予算シートから月着地予測を読み取る
 */
async function readBudgetConsumption(
  date: dayjs.Dayjs,
): Promise<BudgetData[]> {
  const tab = `${date.year()}/${date.month() + 1}`;

  try {
    // 予算消化率(月着地予測換算) = row 30, C〜O列
    const data = await readRange(
      BUDGET_SHEET_ID,
      `'${tab}'!C30:O30`,
    );

    if (!data[0]) return [];

    return BUDGET_PF_ORDER.map((pf, i) => ({
      pf,
      budgetRate: parsePercent(data[0][i]),
    })).filter((d) => d.pf !== "BF" && d.pf !== "BP");
  } catch (e) {
    console.error(
      "[AdReport] Budget data read failed:",
      e instanceof Error ? e.message : e,
    );
    return [];
  }
}

/**
 * 日次広告レポートを生成
 * @param targetDate 対象日（省略時は昨日 JST）
 */
export async function generateDailyAdReport(
  targetDate?: Date,
): Promise<string> {
  const date = targetDate
    ? dayjs(targetDate).tz("Asia/Tokyo")
    : dayjs().tz("Asia/Tokyo").subtract(1, "day");

  const dateLabel = date.format("M/D(ddd)");
  const day = date.date();

  console.log(`[AdReport] Generating report for ${date.format("YYYY-MM-DD")}...`);

  // データ収集
  const [projectData, budgetData] = await Promise.all([
    readProjectData(date),
    readBudgetConsumption(date),
  ]);

  const lines: string[] = [`【広告日次レポート】${dateLabel}`];

  // --- セクション1: 広告消化金額の異常変動 ---
  const spendAlerts: string[] = [];
  for (const d of projectData) {
    if (day <= 1) continue; // 月初は前日比較不可

    if (d.googleAdSpend === 0 && d.prevGoogleAdSpend > 0) {
      spendAlerts.push(`${d.pf}:G検索広告:0円`);
    } else if (
      d.prevGoogleAdSpend > 0 &&
      d.googleAdSpend >= d.prevGoogleAdSpend * 2
    ) {
      spendAlerts.push(`${d.pf}:G検索広告:2倍以上`);
    } else if (
      d.prevGoogleAdSpend > 0 &&
      d.googleAdSpend > 0 &&
      d.googleAdSpend <= d.prevGoogleAdSpend / 2
    ) {
      spendAlerts.push(`${d.pf}:G検索広告:1/2以下`);
    }
  }

  lines.push("");
  if (spendAlerts.length > 0) {
    lines.push("▼前日から広告消化金額が2倍以上,1/2以下または0円のPF");
    for (const alert of spendAlerts) {
      lines.push(alert);
    }
  } else {
    lines.push("▼前日から広告消化金額が2倍以上,1/2以下または0円のPF");
    lines.push("なし");
  }

  // --- セクション2: お問合せ件数の前日比30%以上減少 ---
  const inquiryDrops: string[] = [];
  for (const d of projectData) {
    if (day <= 1) continue;
    if (
      d.prevInquiries > 0 &&
      d.inquiries < d.prevInquiries * 0.7
    ) {
      inquiryDrops.push(d.pf);
    }
  }

  lines.push("");
  lines.push("▼前日からお問合せ件数の前日比30%以上の減少");
  if (inquiryDrops.length > 0) {
    lines.push(inquiryDrops.join("\n"));
  } else {
    lines.push("なし");
  }

  // --- セクション3: 2日以上お問い合わせ未更新 ---
  const staleAlerts: string[] = [];
  for (const d of projectData) {
    if (day >= 3 && !d.hasData && !d.prevHasData) {
      staleAlerts.push(d.pf);
    }
  }

  lines.push("");
  lines.push("▼2日以上お問い合わせ情報が更新されていないPF");
  if (staleAlerts.length > 0) {
    lines.push(staleAlerts.join("/"));
  } else {
    lines.push("なし");
  }

  // --- セクション4: 予算進捗率80%下回り ---
  const budgetAlerts: string[] = [];
  for (const b of budgetData) {
    if (b.budgetRate > 0 && b.budgetRate < 80) {
      budgetAlerts.push(
        `${b.pf}　${b.budgetRate.toFixed(2)}%／${day}日目`,
      );
    }
  }

  lines.push("");
  lines.push("▼予算進捗率が80％を下回っているPF");
  if (budgetAlerts.length > 0) {
    for (const alert of budgetAlerts) {
      lines.push(alert);
    }
  } else {
    lines.push("なし");
  }

  // --- インシデント（自動判定不可 → 固定テキスト） ---
  lines.push("");
  lines.push("■インシデント");
  lines.push("なし");

  return lines.join("\n");
}
