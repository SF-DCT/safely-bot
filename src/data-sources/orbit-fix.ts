/**
 * Orbit改修依頼フロー (Phase 1)
 *
 * フロー:
 *   [1] CGSメンバーが #team-cgs-顧客成長戦略 で @mamo にメンションして依頼を投げる
 *   [2] mamoがClaude分類で「Orbit改修依頼」と判定（雑談・mamoへの普通の依頼はスルー）
 *   [3] 元発言のスレッドに受付返信 + Notionに「承認待ち」エントリ追記
 *   [4] 高橋さんDMに 1段階目承認カード送信（実装する/却下/質問）
 *   [5] 高橋さんアクション → 依頼者にスレッド返信 + Notion追記
 *
 * Phase 2でコード自動生成、Phase 3でデプロイ＆完了通知を追加予定。
 */

import { WebClient } from "@slack/web-api";
import { getClaudeClient } from "../utils/claude-client.js";
import { getNotionClientOrThrow } from "./notion.js";
import {
  ORBIT_NOTION_PAGE_ID,
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
  notionAppendedBlockIds: string[]; // 追記したブロック追跡用（将来更新で使う）
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
// 状態管理（in-memory; mamo再起動で失われるが、Notionに痕跡は残る）
// ─────────────────────────────────────────────────────────

const requests = new Map<string, OrbitRequest>();

export function getRequest(id: string): OrbitRequest | undefined {
  return requests.get(id);
}

// ─────────────────────────────────────────────────────────
// 入口: チャンネルメッセージのフィルタ＆分類
// ─────────────────────────────────────────────────────────

const SHORT_MESSAGE_THRESHOLD = 8; // 8文字未満はスキップ

export function isCgsMember(userId: string): boolean {
  return (CGS_ALLOWED_USER_IDS as readonly string[]).includes(userId);
}

/**
 * CGSメンバーから mamo への DM / app_mention を受け取り、
 * Orbit改修依頼と判定された場合のみ受付フローを起動する。
 *
 * @returns true = 改修依頼として処理した（呼び出し元はreturnしてOK）
 *          false = 改修依頼ではないので呼び出し元の通常処理に流してよい
 */
export async function handleOrbitFixIntake(
  client: WebClient,
  params: {
    channelId: string; // DMの場合はIM channelId、メンションの場合は投稿先channel
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

  let classification: ClassificationResult;
  try {
    classification = await classifyMessage(text);
  } catch (e) {
    console.error("[OrbitFix] Classification error:", e);
    return false;
  }

  if (!classification.is_orbit_request) return false;

  // Gyazo/imageURL を本文からも抽出（Claudeが拾えなかったケースの保険）
  const fallbackImages = extractGyazoUrls(text);
  const referenceImages = Array.from(
    new Set([...classification.reference_images, ...fallbackImages]),
  );

  // メンションの場合、既にスレッド内ならそのスレッドに継続。親投稿ならts自体をスレッド根に。
  // DMの場合、tsをスレッド根として扱う（DMでもthread_tsで別スレッド可能）
  const replyThreadTs = threadTs || ts;

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
    notionAppendedBlockIds: [],
    createdAt: new Date().toISOString(),
  };
  requests.set(id, request);

  // 受付返信（DM=同じDMチャンネル、メンション=投稿スレッド）
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

  // Notion追記 (承認待ち)
  try {
    const blockIds = await appendIntakeToNotion(request);
    request.notionAppendedBlockIds.push(...blockIds);
  } catch (e) {
    console.error("[OrbitFix] Notion append error:", e);
  }

  // 高橋DM 1段階目承認カード
  try {
    await sendApprovalDm(client, request);
  } catch (e) {
    console.error("[OrbitFix] Approval DM error:", e);
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
  // ```json 等のコードフェンスを剥がす
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

  // 元投稿リンク: チャンネル/グループのみ取得。DM (D...) は本人しか見られないので省略。
  let sourceLine = "";
  if (
    !request.channelId.startsWith("D") &&
    !request.channelId.startsWith("M")
  ) {
    try {
      const permalink = await client.chat.getPermalink({
        channel: request.channelId,
        message_ts: request.threadTs,
      });
      if (permalink.permalink) {
        sourceLine = `\n<${permalink.permalink}|元投稿を開く>`;
      }
    } catch (e) {
      console.warn("[OrbitFix] getPermalink failed:", e);
    }
  } else {
    sourceLine = `\n_(依頼者からのDMで受付)_`;
  }

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
          text: `*原文:*\n>>> ${truncate(request.rawText, 600)}${sourceLine}`,
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
  const req = requests.get(requestId);
  if (!req) {
    console.warn(`[OrbitFix] approveRequest: unknown id ${requestId}`);
    return;
  }
  req.state = "approved_for_implementation";

  // 依頼者にスレッド返信
  await client.chat.postMessage({
    channel: req.channelId,
    thread_ts: req.threadTs,
    text:
      `:white_check_mark: 高橋さんが実装を承認しました。\n` +
      `mamo の Phase 2 (自動コード生成) は順次対応予定です。当面は高橋さんが実装します。`,
  });

  // 高橋DMに完了マーク
  await replaceApprovalDm(
    client,
    req,
    `:white_check_mark: 承認済み: *${req.classification.title}* → 実装キューに登録しました。`,
  );

  // Notion追記
  try {
    await appendStatusToNotion(req, {
      label: ":white_check_mark: 実装承認",
      detail: "高橋さんが実装を承認しました。",
    });
  } catch (e) {
    console.error("[OrbitFix] Notion append (approve) error:", e);
  }
}

/** ❌ 却下 */
export async function rejectRequest(
  client: WebClient,
  requestId: string,
  reason: string,
): Promise<void> {
  const req = requests.get(requestId);
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
    await appendStatusToNotion(req, {
      label: ":no_entry_sign: 却下",
      detail: reason,
    });
  } catch (e) {
    console.error("[OrbitFix] Notion append (reject) error:", e);
  }
}

/** 💬 依頼者に追加質問 */
export async function askRequester(
  client: WebClient,
  requestId: string,
  question: string,
): Promise<void> {
  const req = requests.get(requestId);
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
    await appendStatusToNotion(req, {
      label: ":speech_balloon: 追加質問",
      detail: question,
    });
  } catch (e) {
    console.error("[OrbitFix] Notion append (ask) error:", e);
  }
}

/** 高橋DMの承認カードをステータスメッセージで置き換え */
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
// Notion 追記
// ─────────────────────────────────────────────────────────

const NOTION_SECTION_HEADER = "🤖 mamo自動受付ログ";

const typeLabelJa: Record<OrbitRequestType, string> = {
  bug: "バグ",
  feature: "機能要望",
  question: "質問",
  other: "その他",
};

/**
 * 依頼受付時のNotion追記。
 * ページ末尾に「依頼ブロック」を追加。返り値は追記したblock IDの配列。
 */
async function appendIntakeToNotion(req: OrbitRequest): Promise<string[]> {
  const notion = getNotionClientOrThrow();
  const dateLabel = formatJstShort(new Date());

  const requesterName = await resolveSlackUserName(req.requesterUserId);

  const headingText = `📥 [${dateLabel}] ${req.classification.title}`;

  const children = [
    { type: "divider" as const, divider: {} },
    {
      type: "heading_3" as const,
      heading_3: {
        rich_text: [
          { type: "text" as const, text: { content: headingText } },
        ],
      },
    },
    bulletedItem(`報告者: ${requesterName}`),
    bulletedItem(`種別: ${typeLabelJa[req.classification.type]}`),
    bulletedItem(`影響範囲: ${req.classification.affectedArea || "（未特定）"}`),
    bulletedItem(`要約: ${req.classification.summary}`),
    bulletedItem(`原文抜粋: ${truncate(req.rawText, 200)}`),
    bulletedItem(
      req.classification.referenceImages.length > 0
        ? `参考画像: ${req.classification.referenceImages.join(" / ")}`
        : "参考画像: なし",
    ),
    bulletedItem(`ステータス: ⏳ 高橋さん承認待ち`),
  ];

  const result = await notion.blocks.children.append({
    block_id: ORBIT_NOTION_PAGE_ID,
    children,
  });

  return (result.results || [])
    .map((r) => ("id" in r ? (r.id as string) : ""))
    .filter(Boolean);
}

/** ステータス変更時の追記（承認/却下/質問） */
async function appendStatusToNotion(
  req: OrbitRequest,
  params: { label: string; detail: string },
): Promise<void> {
  const notion = getNotionClientOrThrow();
  const dateLabel = formatJstShort(new Date());
  await notion.blocks.children.append({
    block_id: ORBIT_NOTION_PAGE_ID,
    children: [
      bulletedItem(`[${dateLabel}] ${params.label}: ${params.detail} (依頼: ${req.classification.title})`),
    ],
  });
}

function bulletedItem(text: string) {
  return {
    type: "bulleted_list_item" as const,
    bulleted_list_item: {
      rich_text: [{ type: "text" as const, text: { content: text } }],
    },
  };
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

  // 既知のCGSメンバーは直接マッピング
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
