import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  // Slack
  SLACK_BOT_TOKEN: z.string().startsWith("xoxb-"),
  SLACK_APP_TOKEN: z.string().startsWith("xapp-"),
  SLACK_USER_TOKEN: z.string().startsWith("xoxp-").optional(), // 本人名義で投稿するために必要

  // Anthropic (optional until Step 3)
  ANTHROPIC_API_KEY: z.string().startsWith("sk-ant-").optional(),

  // Google Calendar (optional for Step 1)
  GOOGLE_CLIENT_EMAIL: z.string().optional(),
  GOOGLE_PRIVATE_KEY: z.string().optional(),
  GOOGLE_CALENDAR_ID: z.string().default("takahashi@safely.co.jp"),

  // Notion (optional for Step 1)
  NOTION_API_KEY: z.string().optional(),

  // YouTube Data API (optional — falls back to WebSearch)
  YOUTUBE_API_KEY: z.string().optional(),

  // Google Ads API (optional)
  GOOGLE_ADS_DEVELOPER_TOKEN: z.string().optional(),
  GOOGLE_ADS_CLIENT_ID: z.string().optional(),
  GOOGLE_ADS_CLIENT_SECRET: z.string().optional(),
  GOOGLE_ADS_REFRESH_TOKEN: z.string().optional(),

  // Gmail API (独自のOAuthクライアント)
  GMAIL_CLIENT_ID: z.string().optional(),
  GMAIL_CLIENT_SECRET: z.string().optional(),
  GMAIL_REFRESH_TOKEN: z.string().optional(),

  // Google Sheets API (広告費自動入力・レポート用)
  GOOGLE_SHEETS_CLIENT_ID: z.string().optional(),
  GOOGLE_SHEETS_CLIENT_SECRET: z.string().optional(),
  GOOGLE_SHEETS_REFRESH_TOKEN: z.string().optional(),

  // Salesforce REST API (拡張CV用 — Railway上ではsfdx不要)
  SALESFORCE_CLIENT_ID: z.string().optional(),
  SALESFORCE_CLIENT_SECRET: z.string().optional(),
  SALESFORCE_REFRESH_TOKEN: z.string().optional(),
  SALESFORCE_INSTANCE_URL: z.string().default("https://junk-collection.my.salesforce.com"),

  // WordPress REST API (TC — toiretumari-center.com)
  WP_SITE_URL: z.string().default("https://toiretumari-center.com"),
  WP_USERNAME: z.string().optional(),
  WP_APP_PASSWORD: z.string().optional(),

  // Neon PostgreSQL (シナリオエンジン用)
  DATABASE_URL: z.string().optional(),

  // Orbit改修依頼フロー (Phase 1〜)
  GITHUB_TOKEN: z.string().optional(), // SF-DCT/cgs-crm への push & PR 用
});

export const env = envSchema.parse(process.env);

// Slack constants
export const SLACK_USER_ID = "U01T29EAGDB"; // 高橋幹佳
export const SLACK_REPORT_CHANNEL = "C02A8KVSQD8"; // #日報-高橋幹佳
export const SLACK_SELF_DM_CHANNEL = "D01TV5WS4EL"; // 自分宛DM
export const SLACK_CEO_USER_ID = "U01SQJC6487"; // 岡野健二

// Orbit改修依頼フロー
export const CGS_CHANNEL_ID = "C07PCQ53VPS"; // #team-cgs-顧客成長戦略 (private)
export const CGS_ALLOWED_USER_IDS = [
  "U029ZAJ3DUK", // 吉井 文哉 (Manager)
  "U09GZ9L8CCC", // 関谷 ユウキ
  "U0A1MB1KAMB", // 柿沼 佑
  "U097ZQJF5FD", // 小山 和気
] as const;
export const ORBIT_REPO_OWNER = "SF-DCT";
export const ORBIT_REPO_NAME = "cgs-crm";
export const ORBIT_REPO_DEFAULT_BRANCH = "master";
// Notion: Orbit-PJT > mamo統合（mamo自動受付ログ追記先）
export const ORBIT_NOTION_PAGE_ID = "3490bcb6bd108013a865d396f954d5b9";
