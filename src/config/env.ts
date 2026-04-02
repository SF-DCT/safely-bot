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
});

export const env = envSchema.parse(process.env);

// Slack constants
export const SLACK_USER_ID = "U01T29EAGDB"; // 高橋幹佳
export const SLACK_REPORT_CHANNEL = "C02A8KVSQD8"; // #日報-高橋幹佳
export const SLACK_SELF_DM_CHANNEL = "D01TV5WS4EL"; // 自分宛DM
export const SLACK_CEO_USER_ID = "U01SQJC6487"; // 岡野健二
