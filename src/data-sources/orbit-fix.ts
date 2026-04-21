/**
 * Orbit改修依頼フロー (Phase 1)
 *
 * フロー:
 *   [1] CGSメンバーが #team-cgs-顧客成長戦略 で @mamo にメンションして依頼を投げる
 *   [2] mamoがClaude分類で「Orbit改修依頼」と判定（雑談・mamoへの普通の依頼はスルー）
 *   [3] 元発言のスレッドに受付返信 + Google Sheets「Orbit改修ログ」に1行追記
 *   [4] 高橋さんDMに 1段階目承認カード送信（実装する/却下/質問）
 *   [5] 高橋さんアクション → 依頼者にスレッド返信 + シートのステータス列を更新
 *
 * Phase 2でコード自動生成、Phase 3でデプロイ＆完了通知を追加予定。
 */

import { WebClient } from "@slack/web-api";
import { getClaudeClient } from "../utils/claude-client.js";
import { appendRow, writeRange } from "./google-sheets.js";
import { getDb } from "./database.js";
import {
  ORBIT_LOG_SPREADSHEET_ID,
  ORBIT_LOG_SHEET_NAME,
  SLACK_USER_ID,
  CGS_ALLOWED_USER_IDS,
} from "../config/env.js";

// ─────────────────────────────────────────────────────────
// 型定義
// ─────────────────────────────────────────────────────────

export type OrbitRequestState =
  | "awaiting_approval_1" // 1段階目承認待ち
  | "approved_for_implementation" // 承認済み（Phase 2で実装着手）
  | "rejected" // 却下
  | "asking_back"; // 依頼者に追加質問中

export type OrbitRequestType = "bug" | "feature" | "question" | "other";

export interface OrbitRequest {
  id: string;
  channelId: string;
  threadTs: string;
  requesterUserId: string;
  rawText: string;
  classification: {
    type: OrbitRequestType;
    title: string;
    summary: string;
    affectedArea: string;
    referenceImages: string[];
  };
  state: OrbitRequestState;
  approvalDmTs?: string; // 高橋DMの承認カード ts
  sheetRowNumber?: number; // スプシでの行番号
  sourceLink?: string; // 元投稿のSlack permalink
  createdAt: string;
}

interface ClassificationResult {
  is_orbit_request: boolean;
  type: OrbitRequestType;
  title: string;
  summary: string;
  affected_area: string;
  reference_images: string[];
}

// ─────────────────────────────────────────────────────────
// 状態管理（Postgres永続化 — Sub-Phase 2.1）
// ─────────────────────────────────────────────────────────

interface OrbitRequestRow {
  id: string;
  channel_id: string;
  thread_ts: string;
  requester_user_id: string;
  raw_text: string;
  type: string;
  title: string;
  summary: string;
  affected_area: string | null;
  reference_images: string[] | null;
  state: string;
  approval_dm_ts: string | null;
  sheet_row_number: number | null;
  source_link: string | null;
  created_at: string;
}

function rowToRequest(row: OrbitRequestRow): OrbitRequest {
  return {
    id: row.id,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    requesterUserId: row.requester_user_id,
    rawText: row.raw_text,
    classification: {
      type: row.type as OrbitRequestType,
      title: row.title,
      summary: row.summary,
      affectedArea: row.affected_area || "",
      referenceImages: row.reference_images || [],
    },
    state: row.state as OrbitRequestState,
    approvalDmTs: row.approval_dm_ts || undefined,
    sheetRowNumber: row.sheet_row_number || undefined,
    sourceLink: row.source_link || undefined,
    createdAt: row.created_at,
  };
}

async function saveRequest(req: OrbitRequest): Promise<void> {
  const db = getDb();
  await db`
    INSERT INTO orbit_requests (
      id, channel_id, thread_ts, requester_user_id, raw_text,
      type, title, summary, affected_area, reference_images,
      state, approval_dm_ts, sheet_row_number, source_link
    ) VALUES (
      ${req.id}, ${req.channelId}, ${req.threadTs}, ${req.requesterUserId}, ${req.rawText},
      ${req.classification.type}, ${req.classification.title}, ${req.classification.summary},
      ${req.classification.affectedArea}, ${JSON.stringify(req.classification.referenceImages)}::jsonb,
      ${req.state}, ${req.approvalDmTs ?? null}, ${req.sheetRowNumber ?? null}, ${req.sourceLink ?? null}
    )
    ON CONFLICT (id) DO UPDATE SET
      raw_text = EXCLUDED.raw_text,
      title = EXCLUDED.title,
      summary = EXCLUDED.summary,
      affected_area = EXCLUDED.affected_area,
      reference_images = EXCLUDED.reference_images,
      state = EXCLUDED.state,
      approval_dm_ts = EXCLUDED.approval_dm_ts,
      sheet_row_number = EXCLUDED.sheet_row_number,
      source_link = EXCLUDED.source_link,
      updated_at = NOW()
  `;
}

export async function getRequest(
  id: string,
): Promise<OrbitRequest | undefined> {
  const db = getDb();
  const rows = (await db`
    SELECT * FROM orbit_requests WHERE id = ${id}
  `) as unknown as OrbitRequestRow[];
  if (rows.length === 0) return undefined;
  return rowToRequest(rows[0]);
}

async function findRequestByThread(
  channelId: string,
  threadTs: string,
): Promise<OrbitRequest | undefined> {
  const db = getDb();
  const rows = (await db`
    SELECT * FROM orbit_requests
    WHERE channel_id = ${channelId} AND thread_ts = ${threadTs}
    ORDER BY created_at DESC
    LIMIT 1
  `) as unknown as OrbitRequestRow[];
  if (rows.length === 0) return undefined;
  return rowToRequest(rows[0]);
}

// ─────────────────────────────────────────────────────────
// 入口: メンションのフィルタ＆分類
// ─────────────────────────────────────────────────────────

const SHORT_MESSAGE_THRESHOLD = 8; // 8文字未満はスキップ

export function isCgsMember(userId: string): boolean {
  return (CGS_ALLOWED_USER_IDS as readonly string[]).includes(userId);
}

/**
 * CGSメンバーから mamo への app_mention を受け取り、
 * Orbit改修依頼と判定された場合のみ受付フローを起動する。
 *
 * @returns true = 改修依頼として処理した（呼び出し元はreturnしてOK）
 *          false = 改修依頼ではないので呼び出し元の通常処理に流してよい
 */
export async function handleOrbitFixIntake(
  client: WebClient,
  params: {
    channelId: string;
    userId: string;
    text: string;
    ts: string;
    threadTs?: string;
    source: "dm" | "mention";
  },
): Promise<boolean> {
  const { channelId, userId, text, ts, threadTs, source } = params;

  if (!isCgsMember(userId)) return false;
  if (!text || text.trim().length < SHORT_MESSAGE_THRESHOLD) return false;

  // スレッド内のメンション → 既存依頼との関係をチェック
  if (threadTs) {
    const existing = await findRequestByThread(channelId, threadTs);
    if (existing) {
      if (existing.state === "asking_back") {
        // 質問への追加回答 → clarification 処理
        await handleClarificationReply(client, existing, text);
      }
      // 既存依頼スレッド内のその他のメンションは沈黙（過去スレッドへの誤反応防止）
      return true;
    }
  }

  let classification: ClassificationResult;
  try {
    classification = await classifyMessage(text);
  } catch (e) {
    console.error("[OrbitFix] Classification error:", e);
    return false;
  }

  if (!classification.is_orbit_request) return false;

  const fallbackImages = extractGyazoUrls(text);
  const referenceImages = Array.from(
    new Set([...classification.reference_images, ...fallbackImages]),
  );
  const replyThreadTs = threadTs || ts;

  // 元投稿の permalink を取得（高橋さんがクリックして文脈を見られるように）
  let sourceLink: string | undefined;
  if (
    !channelId.startsWith("D") &&
    !channelId.startsWith("M")
  ) {
    try {
      const r = await client.chat.getPermalink({
        channel: channelId,
        message_ts: replyThreadTs,
      });
      sourceLink = r.permalink || undefined;
    } catch (e) {
      console.warn("[OrbitFix] getPermalink failed:", e);
    }
  }

  const id = `orbit-${ts.replace(".", "")}`;
  const request: OrbitRequest = {
    id,
    channelId,
    threadTs: replyThreadTs,
    requesterUserId: userId,
    rawText: text,
    classification: {
      type: classification.type,
      title: classification.title.slice(0, 40),
      summary: classification.summary,
      affectedArea: classification.affected_area,
      referenceImages,
    },
    state: "awaiting_approval_1",
    sourceLink,
    createdAt: new Date().toISOString(),
  };

  await client.chat.postMessage({
    channel: channelId,
    thread_ts: replyThreadTs,
    text:
      `:eyes: 改修依頼として受け付けました。\n` +
      `《${request.classification.title}》\n` +
      (source === "mention"
        ? `高橋さんの承認後、実装フローに進みます。`
        : `高橋さんの承認後、実装フローに進みます。結果はこちらのDMに通知します。`),
  });

  // スプシ追記
  try {
    const rowNumber = await appendIntakeToSheet(request);
    request.sheetRowNumber = rowNumber;
  } catch (e) {
    console.error("[OrbitFix] Sheet append error:", e);
  }

  // 高橋DM 1段階目承認カード
  try {
    await sendApprovalDm(client, request);
  } catch (e) {
    console.error("[OrbitFix] Approval DM error:", e);
  }

  // すべてのフィールドが埋まった状態でDB保存
  try {
    await saveRequest(request);
  } catch (e) {
    console.error("[OrbitFix] DB saveRequest error:", e);
  }

  return true;
}

// ─────────────────────────────────────────────────────────
// Claude分類
// ─────────────────────────────────────────────────────────

const CLASSIFY_SYSTEM_PROMPT = `あなたはSAFELY社の自社CRM「Orbit」（旧CGS CRM）の改修依頼を仕分けるアシスタントです。

CGSメンバーが #team-cgs-顧客成長戦略 チャンネルで mamo にメンションして投げてきたメッセージを読み、Orbitに対する「バグ報告」「機能改善要望」「機能追加要望」のいずれかかどうかを判定します。

判定材料:
- 「Orbit」「CRM」「画面」「フォーム」「リード」「商談」「取引先」「責任者」「活動」「ToDo」などのOrbit関連キーワード
- 「バグ」「不具合」「エラー」「動かない」「できない」「追加してほしい」「修正してほしい」「直して」などの語
- Gyazo / スクショ URL の存在
- 改修してほしい挙動・追加してほしい機能の具体的な記述

非対象（is_orbit_request=false にする）:
- 雑談・挨拶・スタンプのみ
- 他システム（Google広告、Salesforce、Notion、Slack設定 等）の話
- mamo自体への質問（「広告レポート見せて」「Gmail確認して」「日報書いて」等）
- 既に解決した話・お礼・報告だけのメッセージ

迷ったらis_orbit_request=falseにしてください。誤検知より見逃しのほうが安全です（依頼者は再度送ればよい）。

必ず以下のJSON形式だけで返答してください。前置き・コードブロック禁止。

{
  "is_orbit_request": true | false,
  "type": "bug" | "feature" | "question" | "other",
  "title": "短いタイトル(全角20文字以内)",
  "summary": "依頼の要点を1〜2文で",
  "affected_area": "推定される画面・機能名",
  "reference_images": ["URL1", "URL2"]
}`;

async function classifyMessage(text: string): Promise<ClassificationResult> {
  const claude = getClaudeClient();
  const response = await claude.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 512,
    system: CLASSIFY_SYSTEM_PROMPT,
    messages: [{ role: "user", content: text }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Empty classification response");
  }
  const raw = textBlock.text.trim();
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(cleaned) as ClassificationResult;
}

function extractGyazoUrls(text: string): string[] {
  const urls = text.match(/https?:\/\/gyazo\.com\/[a-z0-9]+/gi) || [];
  return Array.from(new Set(urls));
}

// ─────────────────────────────────────────────────────────
// 1段階目承認DM
// ─────────────────────────────────────────────────────────

async function sendApprovalDm(
  client: WebClient,
  request: OrbitRequest,
): Promise<void> {
  const dm = await client.conversations.open({ users: SLACK_USER_ID });
  const channelId = dm.channel?.id;
  if (!channelId) {
    throw new Error("Failed to open DM with takahashi");
  }

  const typeLabel: Record<OrbitRequestType, string> = {
    bug: ":lady_beetle: バグ",
    feature: ":sparkles: 機能要望",
    question: ":question: 質問",
    other: ":memo: その他",
  };

  const imagesText =
    request.classification.referenceImages.length > 0
      ? request.classification.referenceImages
          .map((u) => `<${u}|画像>`)
          .join(" / ")
      : "（添付なし）";

  const sourceLine = request.sourceLink
    ? `\n<${request.sourceLink}|元投稿を開く>`
    : `\n_(リンク取得不可)_`;

  const sheetLine = request.sheetRowNumber
    ? `\n📊 ログ: <https://docs.google.com/spreadsheets/d/${ORBIT_LOG_SPREADSHEET_ID}/edit#gid=0|スプシ ${request.sheetRowNumber}行目>`
    : "";

  const body = await client.chat.postMessage({
    channel: channelId,
    text: `:incoming_envelope: Orbit改修依頼: ${request.classification.title}`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `📥 Orbit改修依頼 - ${request.classification.title}`,
        },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*依頼者:*\n<@${request.requesterUserId}>`,
          },
          {
            type: "mrkdwn",
            text: `*種別:*\n${typeLabel[request.classification.type]}`,
          },
          {
            type: "mrkdwn",
            text: `*影響範囲:*\n${request.classification.affectedArea || "（未特定）"}`,
          },
          {
            type: "mrkdwn",
            text: `*参考画像:*\n${imagesText}`,
          },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*要約:*\n${request.classification.summary}`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*原文:*\n>>> ${truncate(request.rawText, 600)}${sourceLine}${sheetLine}`,
        },
      },
      {
        type: "actions",
        block_id: `orbit_fix_actions_${request.id}`,
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "✅ 実装する" },
            style: "primary",
            action_id: "orbit_fix_approve",
            value: request.id,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "💬 質問する" },
            action_id: "orbit_fix_ask",
            value: request.id,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "❌ 却下" },
            style: "danger",
            action_id: "orbit_fix_reject",
            value: request.id,
          },
        ],
      },
    ],
  });

  request.approvalDmTs = body.ts;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

// ─────────────────────────────────────────────────────────
// 1段階目: 承認 / 却下 / 質問 のハンドラ
// ─────────────────────────────────────────────────────────

/** ✅ 実装する → Phase 2 待ち状態に */
export async function approveRequest(
  client: WebClient,
  requestId: string,
): Promise<void> {
  const req = await getRequest(requestId);
  if (!req) {
    console.warn(`[OrbitFix] approveRequest: unknown id ${requestId}`);
    return;
  }
  req.state = "approved_for_implementation";

  await client.chat.postMessage({
    channel: req.channelId,
    thread_ts: req.threadTs,
    text:
      `:white_check_mark: 高橋さんが実装を承認しました。\n` +
      `mamo の Phase 2 (自動コード生成) は順次対応予定です。当面は高橋さんが実装します。`,
  });

  await replaceApprovalDm(
    client,
    req,
    `:white_check_mark: 承認済み: *${req.classification.title}* → 実装キューに登録しました。`,
  );

  try {
    await updateStatusInSheet(req, "✅ 実装承認", "高橋さんが実装を承認");
  } catch (e) {
    console.error("[OrbitFix] Sheet update (approve) error:", e);
  }

  await saveRequest(req);
}

/** ❌ 却下 */
export async function rejectRequest(
  client: WebClient,
  requestId: string,
  reason: string,
): Promise<void> {
  const req = await getRequest(requestId);
  if (!req) {
    console.warn(`[OrbitFix] rejectRequest: unknown id ${requestId}`);
    return;
  }
  req.state = "rejected";

  await client.chat.postMessage({
    channel: req.channelId,
    thread_ts: req.threadTs,
    text:
      `:no_entry_sign: 高橋さんから却下のご連絡です。\n` +
      `*理由:* ${reason}`,
  });

  await replaceApprovalDm(
    client,
    req,
    `:no_entry_sign: 却下: *${req.classification.title}*\n理由: ${reason}`,
  );

  try {
    await updateStatusInSheet(req, "❌ 却下", reason);
  } catch (e) {
    console.error("[OrbitFix] Sheet update (reject) error:", e);
  }

  await saveRequest(req);
}

/** 質問に対する依頼者の追加回答を受けて、再度承認カードを送る */
async function handleClarificationReply(
  client: WebClient,
  req: OrbitRequest,
  reply: string,
): Promise<void> {
  // 元rawTextに追記（高橋さんが新カードで判断材料として読める）
  req.rawText = `${req.rawText}\n\n[依頼者からの追加情報]\n${reply}`;
  req.state = "awaiting_approval_1";

  // 元スレッドに受付返信
  await client.chat.postMessage({
    channel: req.channelId,
    thread_ts: req.threadTs,
    text:
      `:ok: 追加情報ありがとうございます。\n` +
      `内容を踏まえて高橋さんに再度確認します。`,
  });

  // スプシのステータスを更新
  try {
    await updateStatusInSheet(
      req,
      "⏳ 追加情報あり・承認待ち",
      truncate(reply, 200),
    );
  } catch (e) {
    console.error("[OrbitFix] Sheet update (clarification) error:", e);
  }

  // 既存の承認DM（質問送信済みカード）を「追加情報届きました」表示に置き換え
  if (req.approvalDmTs) {
    await replaceApprovalDm(
      client,
      req,
      `:speech_balloon: → :arrow_down: *${req.classification.title}* に依頼者から追加回答が届きました。新しい承認カードを下に送信します。`,
    );
    req.approvalDmTs = undefined;
  }

  // 新しい承認カードを送信
  try {
    await sendApprovalDm(client, req);
  } catch (e) {
    console.error("[OrbitFix] Approval DM (re-send) error:", e);
  }

  await saveRequest(req);
}

/** 💬 依頼者に追加質問 */
export async function askRequester(
  client: WebClient,
  requestId: string,
  question: string,
): Promise<void> {
  const req = await getRequest(requestId);
  if (!req) {
    console.warn(`[OrbitFix] askRequester: unknown id ${requestId}`);
    return;
  }
  req.state = "asking_back";

  await client.chat.postMessage({
    channel: req.channelId,
    thread_ts: req.threadTs,
    text:
      `:speech_balloon: 高橋さんから確認事項です。\n` +
      `> ${question}\n` +
      `お手数ですがこのスレッドにご返信ください。`,
  });

  await replaceApprovalDm(
    client,
    req,
    `:speech_balloon: 質問送信済み: *${req.classification.title}*\n質問: ${question}`,
  );

  try {
    await updateStatusInSheet(req, "💬 質問中", question);
  } catch (e) {
    console.error("[OrbitFix] Sheet update (ask) error:", e);
  }

  await saveRequest(req);
}

async function replaceApprovalDm(
  client: WebClient,
  req: OrbitRequest,
  text: string,
): Promise<void> {
  if (!req.approvalDmTs) return;
  const dm = await client.conversations.open({ users: SLACK_USER_ID });
  const channelId = dm.channel?.id;
  if (!channelId) return;
  await client.chat.update({
    channel: channelId,
    ts: req.approvalDmTs,
    text,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text },
      },
    ],
  });
}

// ─────────────────────────────────────────────────────────
// Google Sheets 追記・更新
// ─────────────────────────────────────────────────────────

const typeLabelJa: Record<OrbitRequestType, string> = {
  bug: "バグ",
  feature: "機能要望",
  question: "質問",
  other: "その他",
};

/**
 * 依頼受付時のシート追記。返り値は追記された行番号（1始まり）。
 * カラム順: 受付日時/依頼ID/依頼者/種別/タイトル/要約/影響範囲/参考画像/原文(抜粋)/ステータス/ステータス更新日時/対応者メモ/PR URL/マージ日時/元投稿リンク
 */
async function appendIntakeToSheet(req: OrbitRequest): Promise<number> {
  const dateLabel = formatJstShort(new Date());
  const requesterName = await resolveSlackUserName(req.requesterUserId);

  const { rowNumber } = await appendRow(
    ORBIT_LOG_SPREADSHEET_ID,
    `${ORBIT_LOG_SHEET_NAME}!A:O`,
    [
      [
        dateLabel,
        req.id,
        requesterName,
        typeLabelJa[req.classification.type],
        req.classification.title,
        req.classification.summary,
        req.classification.affectedArea || "",
        req.classification.referenceImages.join(" / "),
        truncate(req.rawText, 500),
        "⏳ 承認待ち",
        dateLabel,
        "",
        "",
        "",
        req.sourceLink || "",
      ],
    ],
  );

  return rowNumber;
}

/** ステータス変更時、行のJ/K/L列（ステータス/更新日時/メモ）を更新 */
async function updateStatusInSheet(
  req: OrbitRequest,
  status: string,
  memo: string,
): Promise<void> {
  if (!req.sheetRowNumber) {
    console.warn(
      `[OrbitFix] updateStatusInSheet: no row number for ${req.id}`,
    );
    return;
  }
  const dateLabel = formatJstShort(new Date());
  await writeRange(
    ORBIT_LOG_SPREADSHEET_ID,
    `${ORBIT_LOG_SHEET_NAME}!J${req.sheetRowNumber}:L${req.sheetRowNumber}`,
    [[status, dateLabel, memo]],
  );
}

function formatJstShort(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  const yyyy = jst.getUTCFullYear();
  const mm = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(jst.getUTCDate()).padStart(2, "0");
  const hh = String(jst.getUTCHours()).padStart(2, "0");
  const mi = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

const userNameCache = new Map<string, string>();

async function resolveSlackUserName(userId: string): Promise<string> {
  const cached = userNameCache.get(userId);
  if (cached) return cached;

  const known: Record<string, string> = {
    U029ZAJ3DUK: "吉井 文哉",
    U09GZ9L8CCC: "関谷 ユウキ",
    U0A1MB1KAMB: "柿沼 佑",
    U097ZQJF5FD: "小山 和気",
    U01T29EAGDB: "高橋 幹佳",
  };
  const name = known[userId] || userId;
  userNameCache.set(userId, name);
  return name;
}
