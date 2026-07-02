import cron from "node-cron";
import { app } from "../app.js";
import { env, SLACK_USER_ID } from "../config/env.js";
import { getDb } from "../data-sources/database.js";
import {
  fetchRecentReviews,
  getMemberPageLink,
  type TCReviewRaw,
} from "../data-sources/wordpress.js";

const LOOKBACK_DAYS = 7; // モデレーション承認ラグを考慮した遡り窓
const MAX_DETAIL = 5; // 1通のDMに全文掲載する最大件数
const BODY_MAX_CHARS = 300; // 本文の掲載上限（「ある一定まで」の範囲）

// プロセス内既読。DBが使えれば tc_review_alerts で再デプロイを跨いで永続化
const seenIds = new Set<number>();
let dbInitTried = false;
let dbAvailable = false;
let dbSeedChecked = false;
let memoryBaselineDone = false;

async function ensureDb(): Promise<boolean> {
  if (dbInitTried) return dbAvailable;
  dbInitTried = true;
  if (!env.DATABASE_URL) return false;
  try {
    const db = getDb();
    await db`
      CREATE TABLE IF NOT EXISTS tc_review_alerts (
        review_id   BIGINT PRIMARY KEY,
        notified_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    dbAvailable = true;
  } catch (e) {
    console.error("[ReviewWatch] DB init failed. Falling back to memory:", e);
    dbAvailable = false;
  }
  return dbAvailable;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) =>
      String.fromCodePoint(parseInt(n, 16)),
    )
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** WPのdateはJSTローカルなのでJST基準のISO文字列を作る */
function jstIsoDaysAgo(days: number): string {
  const t = new Date(Date.now() + 9 * 3600_000 - days * 86_400_000);
  return t.toISOString().slice(0, 19);
}

function formatJstDate(isoLocal: string): string {
  const m = isoLocal.match(/^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2})/);
  if (!m) return isoLocal;
  return `${Number(m[1])}/${Number(m[2])} ${m[3]}`;
}

function formatReview(r: TCReviewRaw, memberLink: string | null): string {
  const vendor = r.vendor?.title
    ? decodeEntities(r.vendor.title)
    : "事業者不明";
  const md = r.meta_data ?? {};
  const acf = r.acf ?? {};

  const rating = Number(md.wpcr3_review_rating);
  const stars =
    Number.isInteger(rating) && rating >= 1 && rating <= 5
      ? "★".repeat(rating) + "☆".repeat(5 - rating)
      : "評価不明";
  const reviewTitle = md.wpcr3_review_title
    ? `「${decodeEntities(md.wpcr3_review_title)}」`
    : "";
  const name =
    md.wpcr3_review_name || decodeEntities(r.title?.rendered || "") || "匿名";
  const pref =
    typeof acf.wpcr3_review_prefecture === "string"
      ? acf.wpcr3_review_prefecture
      : "";

  const metaLine = [
    `投稿者: ${name}${pref ? `（${pref}）` : ""}`,
    md.wpcr3_f1 ? `修理内容: ${md.wpcr3_f1}` : "",
    md.wpcr3_f2 ? `料金: ${md.wpcr3_f2}` : "",
  ]
    .filter(Boolean)
    .join(" / ");

  const imgCount = [acf.wpcr3_file1, acf.wpcr3_file2, acf.wpcr3_file3].filter(
    (v) => typeof v === "string" && v,
  ).length;
  const hasInvoice = typeof acf.wpcr3_invoice1 === "string" && acf.wpcr3_invoice1;
  const coupon =
    typeof acf.wpcr3_review_code === "string" ? acf.wpcr3_review_code.trim() : "";
  const attachLine = [
    imgCount > 0 ? `画像${imgCount}枚` : "",
    hasInvoice ? "請求書あり" : "",
    coupon ? `クーポンコード: ${coupon}（SMS施策経由の可能性）` : "",
  ]
    .filter(Boolean)
    .join(" / ");

  let body = stripHtml(r.content?.rendered || "");
  if (body.length > BODY_MAX_CHARS) {
    body = body.slice(0, BODY_MAX_CHARS) + "…（続きあり）";
  }

  const url = memberLink ? `${memberLink}#reviewArea` : r.link;

  return [
    `*${vendor}* ${stars} ${reviewTitle}（${formatJstDate(r.date)} 投稿）`,
    metaLine,
    attachLine,
    body ? `>${body}` : "",
    url ? `<${url}|口コミページを開く>` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function runCheck(): Promise<void> {
  const reviews = await fetchRecentReviews(jstIsoDaysAgo(LOOKBACK_DAYS));
  const candidates = reviews.filter(
    (r) => r.status === "publish" && !seenIds.has(r.id),
  );
  if (candidates.length === 0) return;

  const useDb = await ensureDb();
  let fresh: TCReviewRaw[] = [];

  if (useDb) {
    const db = getDb();
    if (!dbSeedChecked) {
      // 初回導入時: テーブルが空なら既存分を通知せず既読化して終わる
      const rows = await db`SELECT COUNT(*)::int AS c FROM tc_review_alerts`;
      dbSeedChecked = true;
      if ((rows[0]?.c ?? 0) === 0) {
        for (const r of candidates) {
          await db`INSERT INTO tc_review_alerts (review_id) VALUES (${r.id}) ON CONFLICT (review_id) DO NOTHING`;
          seenIds.add(r.id);
        }
        console.log(
          `[ReviewWatch] Seeded ${candidates.length} existing review(s) silently.`,
        );
        return;
      }
    }
    for (const r of candidates) {
      const hit = await db`SELECT 1 FROM tc_review_alerts WHERE review_id = ${r.id}`;
      if (hit.length === 0) fresh.push(r);
      else seenIds.add(r.id);
    }
  } else {
    if (!memoryBaselineDone) {
      candidates.forEach((r) => seenIds.add(r.id));
      memoryBaselineDone = true;
      console.log(
        `[ReviewWatch] (no DB) Baseline seeded ${candidates.length} review(s).`,
      );
      return;
    }
    fresh = candidates;
  }

  if (fresh.length === 0) return;
  fresh.sort((a, b) => a.date.localeCompare(b.date)); // 古い順に並べて通知

  const details: string[] = [];
  for (const r of fresh.slice(0, MAX_DETAIL)) {
    const memberLink = r.vendor?.id
      ? await getMemberPageLink(r.vendor.id)
      : null;
    details.push(formatReview(r, memberLink));
  }
  const omitted = fresh.length - MAX_DETAIL;

  const message = [
    `:speech_balloon: *TCに新しい口コミが投稿されました（${fresh.length}件）*`,
    "",
    details.join("\n\n"),
    omitted > 0 ? `\nほか ${omitted} 件（サイト上でご確認ください）` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const dm = await app.client.conversations.open({ users: SLACK_USER_ID });
  const channelId = dm.channel?.id;
  if (!channelId) {
    console.error("[ReviewWatch] Failed to open DM channel.");
    return;
  }
  await app.client.chat.postMessage({
    channel: channelId,
    text: message,
    mrkdwn: true,
    unfurl_links: false,
  });

  for (const r of fresh) {
    seenIds.add(r.id);
    if (useDb) {
      const db = getDb();
      await db`INSERT INTO tc_review_alerts (review_id) VALUES (${r.id}) ON CONFLICT (review_id) DO NOTHING`;
    }
  }
  console.log(`[ReviewWatch] Notified ${fresh.length} new review(s).`);
}

/**
 * TC（水道修理のセーフリー）の新着口コミを監視する（15分ごと・24/7）。
 *
 * WP REST /reviews を巡回し、新規公開分を高橋さんのDMへ要約通知する。
 * 口コミ獲得SMS施策（2026-07-02 LIVE開始）の投稿を即座に把握するのが主目的。
 * クーポンコード付き投稿はSMS経由の可能性が高い旨を明記する。
 * 通知済みIDは tc_review_alerts (Neon) に永続化し、再デプロイ後の重複通知を防ぐ。
 */
export function scheduleReviewWatch(): void {
  cron.schedule(
    "*/15 * * * *",
    async () => {
      try {
        await runCheck();
      } catch (e) {
        console.error("[ReviewWatch] check failed:", e);
      }
    },
    { timezone: "Asia/Tokyo" },
  );

  // 起動直後に1回実行（初回シード/デプロイ後の即時キャッチアップ用）
  setTimeout(() => {
    runCheck().catch((e) =>
      console.error("[ReviewWatch] initial check failed:", e),
    );
  }, 60_000);

  console.log("[Scheduler] TC review watch scheduled: every 15 min (24/7)");
}
