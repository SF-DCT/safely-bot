/**
 * WordPress REST API — TC (toiretumari-center.com) 読み取りツール
 *
 * メンバー（業者）情報の照会に使用。
 * 認証: Basic Auth (Application Passwords)
 */

import { env } from "../config/env.js";

const WP_BASE_URL = env.WP_SITE_URL || "https://toiretumari-center.com";
const WP_API = `${WP_BASE_URL}/wp-json/wp/v2`;

function getAuthHeader(): Record<string, string> {
  if (env.WP_USERNAME && env.WP_APP_PASSWORD) {
    const token = Buffer.from(
      `${env.WP_USERNAME}:${env.WP_APP_PASSWORD}`,
    ).toString("base64");
    return { Authorization: `Basic ${token}` };
  }
  return {};
}

async function wpFetch<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${WP_API}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  const res = await fetch(url.toString(), {
    headers: {
      ...getAuthHeader(),
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`WP API error: ${res.status} ${res.statusText}`);
  }
  const json = await res.json() as Record<string, unknown>;
  // TCのWP REST APIはレスポンスが { data: { result: [...] } } でラップされている
  if (json.data && typeof json.data === "object" && "result" in (json.data as Record<string, unknown>)) {
    return (json.data as Record<string, unknown>).result as T;
  }
  return json as T;
}

// ---------- 型定義 ----------

interface WPMember {
  id: number;
  slug: string;
  status: string;
  link: string;
  title: { rendered: string };
  acf: {
    trader_name?: string;
    corresponding_area?: unknown;
    member_rating_review_count?: number;
    member_rating_score?: number;
    member_rating_5score_ave?: number;
    tel_number?: string;
    fee_wage?: unknown;
    fee_wage_basic?: unknown;
    basic_fee?: unknown;
    business_hours?: unknown;
    performance?: unknown;
    slogan?: string;
    short_intro?: string;
    [key: string]: unknown;
  };
  review_data?: unknown;
}

// ---------- 公開関数 ----------

/**
 * メンバー（業者）を名前で検索して情報を返す
 */
export async function searchMember(query: string): Promise<string> {
  try {
    const members = await wpFetch<WPMember[]>("/member", {
      search: query,
      per_page: "5",
      _fields: "id,slug,title,link,acf,review_data",
    });

    if (members.length === 0) {
      return `「${query}」に一致するメンバーは見つかりませんでした。`;
    }

    const results = members.map((m) => ({
      id: m.id,
      name: m.title.rendered || m.acf.trader_name || m.slug,
      trader_name: m.acf.trader_name,
      slug: m.slug,
      url: m.link,
      review_count: m.acf.member_rating_review_count ?? "不明",
      rating_score: m.acf.member_rating_score ?? "不明",
      rating_5score_ave: m.acf.member_rating_5score_ave ?? "不明",
      tel: m.acf.tel_number ?? "不明",
      slogan: m.acf.slogan ?? "",
      short_intro: m.acf.short_intro ?? "",
    }));

    return JSON.stringify(results, null, 2);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return `WP API エラー: ${msg}`;
  }
}

/**
 * メンバーの対応エリア情報を取得
 */
export async function getMemberArea(query: string): Promise<string> {
  try {
    const members = await wpFetch<WPMember[]>("/member", {
      search: query,
      per_page: "1",
      _fields: "id,slug,title,acf",
    });

    if (members.length === 0) {
      return `「${query}」に一致するメンバーは見つかりませんでした。`;
    }

    const m = members[0];
    return JSON.stringify(
      {
        id: m.id,
        name: m.title.rendered || m.acf.trader_name || m.slug,
        trader_name: m.acf.trader_name,
        corresponding_area: m.acf.corresponding_area,
      },
      null,
      2,
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return `WP API エラー: ${msg}`;
  }
}

/**
 * メンバーの料金情報を取得
 */
export async function getMemberFee(query: string): Promise<string> {
  try {
    const members = await wpFetch<WPMember[]>("/member", {
      search: query,
      per_page: "1",
      _fields: "id,slug,title,acf",
    });

    if (members.length === 0) {
      return `「${query}」に一致するメンバーは見つかりませんでした。`;
    }

    const m = members[0];
    return JSON.stringify(
      {
        id: m.id,
        name: m.title.rendered || m.acf.trader_name || m.slug,
        trader_name: m.acf.trader_name,
        fee_wage: m.acf.fee_wage,
        fee_wage_basic: m.acf.fee_wage_basic,
        basic_fee: m.acf.basic_fee,
      },
      null,
      2,
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return `WP API エラー: ${msg}`;
  }
}

/**
 * メンバーの口コミ・評価サマリーを取得
 */
export async function getMemberReviews(query: string): Promise<string> {
  try {
    const members = await wpFetch<WPMember[]>("/member", {
      search: query,
      per_page: "1",
      _fields: "id,slug,title,acf,review_data",
    });

    if (members.length === 0) {
      return `「${query}」に一致するメンバーは見つかりませんでした。`;
    }

    const m = members[0];
    return JSON.stringify(
      {
        id: m.id,
        name: m.title.rendered || m.acf.trader_name || m.slug,
        trader_name: m.acf.trader_name,
        review_count: m.acf.member_rating_review_count,
        rating_score: m.acf.member_rating_score,
        rating_5score_ave: m.acf.member_rating_5score_ave,
        review_data: m.review_data,
      },
      null,
      2,
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return `WP API エラー: ${msg}`;
  }
}

/**
 * メンバーの詳細情報を取得（全ACFフィールド）
 */
export async function getMemberDetail(query: string): Promise<string> {
  try {
    const members = await wpFetch<WPMember[]>("/member", {
      search: query,
      per_page: "1",
    });

    if (members.length === 0) {
      return `「${query}」に一致するメンバーは見つかりませんでした。`;
    }

    const m = members[0];
    return JSON.stringify(
      {
        id: m.id,
        name: m.title.rendered,
        slug: m.slug,
        url: m.link,
        status: m.status,
        acf: m.acf,
        review_data: m.review_data,
      },
      null,
      2,
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return `WP API エラー: ${msg}`;
  }
}
