import type Anthropic from "@anthropic-ai/sdk";
import type { types as SlackTypes } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { env, SLACK_USER_ID, SLACK_CEO_USER_ID } from "../config/env.js";
import { getClaudeClient } from "../utils/claude-client.js";
import { getDb } from "./database.js";

// ============================================================
// 業務の受付箱（Work Inbox） Phase 1
// 1. 高橋さん宛ての依頼（メンション＋DM）を Slack から拾う
// 2. Claude で「依頼か／完了済みか／mamo が代行できるか」を仕分ける
// 3. DM に1件ずつカードで提案（ボタンはスマホからも押せる）
// 4. 🔍 → work_items.status=queued → 高橋さんのPCの worker（Claude Code）が分析
// 5. 📝 → 返信の下書き → ✅ を押したときだけ高橋さん名義で送信
// 設計: docs/autonomy-inbox-design.md
// ============================================================

type KnownBlock = SlackTypes.KnownBlock;

const WORK_MODEL = "claude-opus-5-5";
const BACKFILL_DAYS = 14; // 初回だけ遡る日数
const MAX_GROUPS_PER_SCAN = 80; // 1回の仕分けに回すスレッド数の上限
const MAX_CARDS_PER_DIGEST = 8; // 1回に送るカードの上限（残りは次回）
const MAMO_BOT_USER_ID = "U0AQ66JDRC6";

export type WorkKind = "analysis" | "organize" | "reply" | "decision" | "human";
export type WorkStatus =
  | "backlog" // 仕分け済み・まだ提案していない
  | "proposed" // カードを送った
  | "snoozed"
  | "queued" // worker 待ち
  | "running"
  | "done" // 分析完了
  | "failed"
  | "drafted" // 返信下書きあり
  | "scheduled" // 予約送信済み
  | "sent"
  | "closed" // 対応済み
  | "ignored"; // 対象外

export interface WorkItem {
  id: string;
  channel_id: string;
  channel_name: string | null;
  is_dm: boolean;
  thread_ts: string;
  request_ts: string;
  permalink: string | null;
  requester_id: string | null;
  summary: string;
  kind: WorkKind;
  can_mamo_do: boolean;
  proposed_work: string | null;
  priority: "high" | "medium" | "low";
  stall_reason: string | null;
  context_text: string | null;
  status: WorkStatus;
  instruction: string | null;
  card_channel: string | null;
  card_ts: string | null;
  result_json: WorkResult | null;
  report_path: string | null;
  draft_text: string | null;
}

export interface WorkResult {
  title: string;
  facts: string;
  assessment: string;
  next_actions: string;
  decisions: string;
  limitations?: string;
}

interface ThreadGroup {
  id: string;
  channelId: string;
  channelName: string;
  isDm: boolean;
  threadTs: string;
  requestTs: string; // グループ内で最新の「高橋さん宛て」メッセージ
  requesterId: string;
  permalink?: string;
  messages: { user: string; text: string; ts: string }[];
}

interface Classified {
  index: number;
  is_request: boolean;
  status: "open" | "done" | "unclear";
  summary: string;
  kind: WorkKind;
  can_mamo_do: boolean;
  proposed_work: string;
  priority: "high" | "medium" | "low";
  stall_reason: string;
}

// ------------------------------------------------------------
// 1. 拾う
// ------------------------------------------------------------

/**
 * 依頼を拾って仕分け、DM に提案カードを送る（定時実行・手動実行の入口）
 */
export async function runWorkScan(
  botClient: WebClient,
  opts: { manual?: boolean } = {},
): Promise<string> {
  if (!env.SLACK_USER_TOKEN) {
    return ":warning: SLACK_USER_TOKEN が未設定のため、依頼を拾えません。";
  }
  const userClient = new WebClient(env.SLACK_USER_TOKEN);
  const db = getDb();

  const lastScan = await getKv("work_inbox_last_scan");
  const since = lastScan
    ? new Date(new Date(lastScan).getTime() - 24 * 60 * 60 * 1000) // 取りこぼし防止に1日重ねる
    : new Date(Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000);
  const scanStartedAt = new Date().toISOString();

  const groups = await collectGroups(userClient, since);
  console.log(`[WorkInbox] ${groups.length} thread groups collected`);

  // 既に扱った依頼は、より新しい依頼メッセージが来ていない限り仕分け直さない
  const fresh: ThreadGroup[] = [];
  for (const g of groups) {
    const rows = (await db`
      SELECT status, request_ts FROM work_items WHERE id = ${g.id}
    `) as { status: WorkStatus; request_ts: string }[];
    const existing = rows[0];
    if (!existing) {
      fresh.push(g);
      continue;
    }
    if (existing.status === "ignored") continue;
    if (Number(g.requestTs) > Number(existing.request_ts)) fresh.push(g);
  }
  const targets = fresh.slice(0, MAX_GROUPS_PER_SCAN);
  console.log(`[WorkInbox] ${targets.length} groups to classify`);

  const names = await buildNameMap(botClient, targets);
  let openCount = 0;
  for (let i = 0; i < targets.length; i += 20) {
    const batch = targets.slice(i, i + 20);
    const results = await classify(batch, names);
    for (const r of results) {
      const g = batch[r.index - 1];
      if (!g) continue;
      const isOpen = r.is_request && r.status !== "done";
      if (isOpen) openCount++;
      await upsertItem(g, r, isOpen ? "backlog" : "closed", names);
    }
  }

  // スヌーズ明けを提案に戻す
  await db`
    UPDATE work_items SET status = 'backlog', updated_at = NOW()
    WHERE status = 'snoozed' AND snooze_until <= NOW()
  `;
  await setKv("work_inbox_last_scan", scanStartedAt);

  const posted = await postDigest(botClient, opts.manual === true);
  return `依頼の仕分けが完了しました（新規・更新 ${targets.length}件中、未対応の依頼 ${openCount}件）。提案カードを ${posted}件送りました。`;
}

async function collectGroups(
  userClient: WebClient,
  since: Date,
): Promise<ThreadGroup[]> {
  const after = new Date(since.getTime() - 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];
  // after: は指定日を含まないため1日前を渡す
  const queries = [`<@${SLACK_USER_ID}> after:${after}`, `to:me after:${after}`];

  const groups = new Map<string, ThreadGroup>();
  for (const query of queries) {
    for (let page = 1; page <= 3; page++) {
      const result = await userClient.search.messages({
        query,
        sort: "timestamp",
        sort_dir: "desc",
        count: 100,
        page,
      });
      const matches = result.messages?.matches || [];
      for (const match of matches) {
        const raw = match as Record<string, unknown>;
        const ch = raw.channel as Record<string, unknown> | undefined;
        const channelId = ch?.id as string | undefined;
        const user = match.user;
        const ts = match.ts || "";
        if (!channelId || !user || !ts) continue; // Bot 投稿は user がない
        if (user === SLACK_USER_ID || user === MAMO_BOT_USER_ID) continue;
        if (Number(ts) * 1000 < since.getTime()) continue;

        // DM は「相手×日付」、チャンネルは「スレッドの親」を1件の依頼として扱う
        const isDm = ch?.is_im === true;
        const threadTs =
          (raw.thread_ts as string) || threadTsFromPermalink(match.permalink) || ts;
        const id = isDm
          ? `${channelId}-d${jstDateKey(ts)}`
          : `${channelId}-${threadTs}`;
        mergeGroup(groups, {
          id,
          channelId,
          channelName: isDm ? "DM" : (ch?.name as string) || "unknown",
          isDm,
          threadTs: isDm ? ts : threadTs,
          requestTs: ts,
          requesterId: user,
          permalink: match.permalink,
          messages: [],
        });
      }
      const pages = result.messages?.paging?.pages || 1;
      if (page >= pages) break;
      await sleep(1500); // search.messages は Tier 2
    }
  }

  // 新しい順に上限まで本文を取得。スレッドの親が判明したら同じ依頼をまとめ直す
  const sorted = [...groups.values()].sort(
    (a, b) => Number(b.requestTs) - Number(a.requestTs),
  );
  const resolved = new Map<string, ThreadGroup>();
  for (const g of sorted.slice(0, MAX_GROUPS_PER_SCAN + 20)) {
    try {
      const { messages, rootTs } = await fetchContext(userClient, g);
      if (messages.length === 0) continue;
      if (!g.isDm && rootTs && rootTs !== g.threadTs) {
        g.threadTs = rootTs;
        g.id = `${g.channelId}-${rootTs}`;
      }
      g.messages = messages;
      mergeGroup(resolved, g);
    } catch (e) {
      console.log(
        `[WorkInbox] context fetch skipped ${g.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    await sleep(1200); // conversations.replies / history は Tier 3（50回/分）
  }
  return [...resolved.values()].sort(
    (a, b) => Number(b.requestTs) - Number(a.requestTs),
  );
}

function mergeGroup(groups: Map<string, ThreadGroup>, g: ThreadGroup): void {
  const existing = groups.get(g.id);
  if (!existing) {
    groups.set(g.id, g);
    return;
  }
  if (Number(g.requestTs) > Number(existing.requestTs)) {
    existing.requestTs = g.requestTs;
    existing.requesterId = g.requesterId;
    existing.permalink = g.permalink || existing.permalink;
  }
  if (g.isDm && Number(g.threadTs) < Number(existing.threadTs)) {
    existing.threadTs = g.threadTs;
  }
  if (g.messages.length > existing.messages.length) existing.messages = g.messages;
}

/**
 * チャンネルはスレッド全体、DM はその日のやり取り（＋翌日昼まで）を取る
 * （高橋さんが既に返したか・完了したかの判定材料）
 */
async function fetchContext(
  userClient: WebClient,
  g: ThreadGroup,
): Promise<{ messages: { user: string; text: string; ts: string }[]; rootTs?: string }> {
  const toMsg = (m: { user?: string; bot_id?: string; text?: string; ts?: string }) => ({
    user: m.user || (m.bot_id ? "bot" : "unknown"),
    text: (m.text || "").slice(0, 800),
    ts: m.ts || "",
  });

  if (g.isDm) {
    const dayStart = jstDayStartTs(g.requestTs);
    const history = await userClient.conversations.history({
      channel: g.channelId,
      oldest: String(dayStart),
      latest: String(dayStart + 36 * 3600),
      limit: 40,
    });
    const messages = (history.messages || [])
      .map(toMsg)
      .sort((a, b) => Number(a.ts) - Number(b.ts));
    return { messages: messages.slice(-20) };
  }

  const replies = await userClient.conversations.replies({
    channel: g.channelId,
    ts: g.threadTs,
    limit: 30,
  });
  const raw = replies.messages || [];
  const rootTs = raw[0]?.thread_ts || raw[0]?.ts;
  return { messages: raw.map(toMsg).slice(-15), rootTs };
}

function threadTsFromPermalink(permalink?: string): string | undefined {
  if (!permalink) return undefined;
  const m = permalink.match(/[?&]thread_ts=([0-9.]+)/);
  return m?.[1];
}

/** Slack ts の日本時間での日付（YYYYMMDD） */
function jstDateKey(ts: string): string {
  const d = new Date(Number(ts) * 1000 + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/** Slack ts が属する日本時間の日の 0:00（epoch 秒） */
function jstDayStartTs(ts: string): number {
  const jstMs = Number(ts) * 1000 + 9 * 3600 * 1000;
  const dayStartJst = Math.floor(jstMs / 86400000) * 86400000;
  return (dayStartJst - 9 * 3600 * 1000) / 1000;
}

async function buildNameMap(
  botClient: WebClient,
  groups: ThreadGroup[],
): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const g of groups) for (const m of g.messages) ids.add(m.user);
  const names = new Map<string, string>();
  for (const id of ids) {
    if (id === SLACK_USER_ID) {
      names.set(id, "高橋（本人）");
      continue;
    }
    if (!id.startsWith("U") && !id.startsWith("W")) {
      names.set(id, id);
      continue;
    }
    try {
      const info = await botClient.users.info({ user: id });
      const p = info.user?.profile;
      names.set(id, p?.real_name || p?.display_name || info.user?.name || id);
    } catch {
      names.set(id, id);
    }
  }
  return names;
}

// ------------------------------------------------------------
// 2. 仕分ける
// ------------------------------------------------------------

const CLASSIFY_SYSTEM = `あなたは株式会社SAFELYの執行役員・BSG（事業成長戦略チーム）General Manager である高橋幹佳の業務秘書です。
Slack で高橋さん宛てに来たスレッドを読み、「まだ終わっていない依頼」を見つけて、代わりに進められるかを判断します。

高橋さんは依頼に追いつけていないか、手間のかかる作業で時間を取れずにいることが多いです。
代わりに作業するのは、高橋さんのPCで動く Claude Code です。GA4・Search Console・Salesforce・Google スプレッドシート・Google 広告・TC の WordPress・社内の資料とメモリを読んで、データ分析や情報の整理ができます。
送信・投稿・書き込み・電話・会議・交渉はできません。高橋さんの判断が必要なものは、判断材料をそろえるところまでできます。

各スレッドについて次を判断してください。
- is_request: 高橋さん個人に、回答・作業・確認・判断を求めているか。FYI、全体向けの告知、お礼や挨拶だけのものは false
- status: done = 高橋さんが既に対応した、または他の人が対応済み／open = まだ終わっていない／unclear = 判断できない
- summary: 依頼の中身を1行で。誰が何を求めているかが分かるように
- kind: analysis = データを集めて分析する／organize = 情報を整理して資料や論点にまとめる／reply = 返事をすれば済む／decision = 高橋さんの判断が要る／human = 対面・電話・交渉など人にしかできない
- can_mamo_do: analysis と organize は、上のデータで進められるなら true。decision は判断材料の整理が役に立つなら true。reply と human は false
- proposed_work: can_mamo_do が true のとき、代わりにやる作業を具体的に1〜2文で（どのデータで何を比べ、何を出すか）。false のときは空文字
- priority: high = 代表（岡野さん）からの依頼、期日が近い、他の人の作業を止めている／medium = 通常の依頼／low = 急がない
- stall_reason: 止まっていそうな理由の見立てを短く（例: 集計に手間がかかる、判断材料が足りない、見落とされている）

index は入力のスレッド番号をそのまま返してください。すべてのスレッドについて1件ずつ返してください。`;

const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          is_request: { type: "boolean" },
          status: { type: "string", enum: ["open", "done", "unclear"] },
          summary: { type: "string" },
          kind: {
            type: "string",
            enum: ["analysis", "organize", "reply", "decision", "human"],
          },
          can_mamo_do: { type: "boolean" },
          proposed_work: { type: "string" },
          priority: { type: "string", enum: ["high", "medium", "low"] },
          stall_reason: { type: "string" },
        },
        required: [
          "index",
          "is_request",
          "status",
          "summary",
          "kind",
          "can_mamo_do",
          "proposed_work",
          "priority",
          "stall_reason",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

async function classify(
  batch: ThreadGroup[],
  names: Map<string, string>,
): Promise<Classified[]> {
  const threadsText = batch
    .map((g, i) => {
      const where = g.isDm ? "DM" : `#${g.channelName}`;
      const date = formatJst(g.requestTs);
      return `--- スレッド${i + 1}（${where}・最新の依頼 ${date}）---\n${renderMessages(g.messages, names)}`;
    })
    .join("\n\n");

  const text = await callClaudeJson(
    CLASSIFY_SYSTEM,
    `今日は ${formatJst(String(Date.now() / 1000))} です。代表（岡野さん）のSlack IDは ${SLACK_CEO_USER_ID} です。\n以下の${batch.length}件のスレッドを仕分けてください。\n\n${threadsText}`,
    CLASSIFY_SCHEMA,
  );
  try {
    const parsed = JSON.parse(text) as { items: Classified[] };
    return parsed.items.filter((r) => r.index >= 1 && r.index <= batch.length);
  } catch (e) {
    console.error("[WorkInbox] classify parse error:", e, text.slice(0, 500));
    return [];
  }
}

/**
 * Claude Opus 5.5 に構造化出力（JSON Schema）で問い合わせる。
 * SDK 0.39 には output_config / fallbacks の型がないため、キャストして本文に載せる。
 */
async function callClaudeJson(
  system: string,
  user: string,
  schema: object,
): Promise<string> {
  const claude = getClaudeClient();
  const params = {
    model: WORK_MODEL,
    max_tokens: 16000,
    system,
    messages: [{ role: "user", content: user }],
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema },
    },
    fallbacks: "default",
  } as unknown as Anthropic.MessageCreateParamsNonStreaming;

  const response = await claude.messages.create(params, {
    headers: { "anthropic-beta": "server-side-fallback-2026-07-01" },
  });
  if ((response.stop_reason as string) === "refusal") {
    throw new Error("Claude が応答を辞退しました（refusal）");
  }
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => ("text" in b ? b.text : ""))
    .join("");
}

async function callClaudeText(system: string, user: string): Promise<string> {
  const claude = getClaudeClient();
  const params = {
    model: WORK_MODEL,
    max_tokens: 16000,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { effort: "medium" },
    fallbacks: "default",
  } as unknown as Anthropic.MessageCreateParamsNonStreaming;

  const response = await claude.messages.create(params, {
    headers: { "anthropic-beta": "server-side-fallback-2026-07-01" },
  });
  if ((response.stop_reason as string) === "refusal") {
    throw new Error("Claude が応答を辞退しました（refusal）");
  }
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => ("text" in b ? b.text : ""))
    .join("")
    .trim();
}

async function upsertItem(
  g: ThreadGroup,
  r: Classified,
  status: WorkStatus,
  names: Map<string, string>,
): Promise<void> {
  const db = getDb();
  const context = renderMessages(g.messages, names);
  await db`
    INSERT INTO work_items (
      id, channel_id, channel_name, is_dm, thread_ts, request_ts, permalink,
      requester_id, summary, kind, can_mamo_do, proposed_work, priority,
      stall_reason, context_text, status
    ) VALUES (
      ${g.id}, ${g.channelId}, ${g.channelName}, ${g.isDm}, ${g.threadTs},
      ${g.requestTs}, ${g.permalink || null}, ${g.requesterId}, ${r.summary},
      ${r.kind}, ${r.can_mamo_do}, ${r.proposed_work || null}, ${r.priority},
      ${r.stall_reason || null}, ${context}, ${status}
    )
    ON CONFLICT (id) DO UPDATE SET
      request_ts = EXCLUDED.request_ts,
      permalink = COALESCE(EXCLUDED.permalink, work_items.permalink),
      requester_id = EXCLUDED.requester_id,
      summary = EXCLUDED.summary,
      kind = EXCLUDED.kind,
      can_mamo_do = EXCLUDED.can_mamo_do,
      proposed_work = EXCLUDED.proposed_work,
      priority = EXCLUDED.priority,
      stall_reason = EXCLUDED.stall_reason,
      context_text = EXCLUDED.context_text,
      -- 作業中のものは状態を巻き戻さない
      status = CASE WHEN work_items.status IN ('queued', 'running')
                    THEN work_items.status ELSE EXCLUDED.status END,
      updated_at = NOW()
  `;
}

// ------------------------------------------------------------
// 3. 提案する
// ------------------------------------------------------------

async function postDigest(botClient: WebClient, manual: boolean): Promise<number> {
  const db = getDb();
  const items = (await db`
    SELECT * FROM work_items WHERE status = 'backlog'
    ORDER BY
      CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
      can_mamo_do DESC,
      request_ts DESC
    LIMIT ${MAX_CARDS_PER_DIGEST}
  `) as WorkItem[];
  const remainRows = (await db`
    SELECT COUNT(*)::int AS n FROM work_items WHERE status = 'backlog'
  `) as { n: number }[];
  const remaining = (remainRows[0]?.n || 0) - items.length;

  const channel = await openDm(botClient);
  if (items.length === 0) {
    if (manual) {
      await botClient.chat.postMessage({
        channel,
        text: ":white_check_mark: 新しく拾えた未対応の依頼はありませんでした。",
      });
    }
    return 0;
  }

  const canDo = items.filter((i) => i.can_mamo_do).length;
  await botClient.chat.postMessage({
    channel,
    text: `🤖 拾った依頼 ${items.length}件（うち代わりに進められそう ${canDo}件）`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🤖 *拾った依頼 ${items.length}件*（うち代わりに進められそう *${canDo}件*）${remaining > 0 ? `\nほか ${remaining}件は次回に回します。` : ""}`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "🔍 を押すと、PCの Claude Code が分析・整理して結果をここに返します。返信は下書きまで作り、送信は ✅ を押したときだけです。",
          },
        ],
      },
    ],
  });

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const res = await botClient.chat.postMessage({
      channel,
      text: `依頼: ${item.summary}`,
      blocks: itemCardBlocks(item, i + 1),
    });
    await db`
      UPDATE work_items
      SET status = 'proposed', card_channel = ${channel}, card_ts = ${res.ts || null},
          proposed_at = NOW(), updated_at = NOW()
      WHERE id = ${item.id}
    `;
  }
  return items.length;
}

const KIND_LABEL: Record<WorkKind, string> = {
  analysis: "データ分析",
  organize: "情報整理",
  reply: "返信",
  decision: "判断",
  human: "人の対応",
};
const PRIORITY_LABEL = { high: "高", medium: "中", low: "低" } as const;
const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩";

export function itemCardBlocks(item: WorkItem, no?: number): KnownBlock[] {
  const head = no ? `${CIRCLED[no - 1] || no + "."} ` : "";
  const where = item.is_dm ? "DM" : `#${item.channel_name}`;
  const link = item.permalink ? ` <${item.permalink}|スレッドを開く>` : "";
  const lines = [
    `${head}<@${item.requester_id}>（${where}・${ageLabel(item.request_ts)}）${link}`,
    `*依頼：*${item.summary}`,
  ];
  if (item.can_mamo_do && item.proposed_work) {
    lines.push(`*代わりにやれること：*${item.proposed_work}`);
  }

  const buttons: SlackTypes.Button[] = [];
  if (item.can_mamo_do) {
    buttons.push(button("🔍 進めて", "work_analyze", item.id, "primary"));
  }
  buttons.push(button("📝 返信の下書き", "work_draft", item.id));
  buttons.push(button("🕒 明日に回す", "work_snooze", item.id));
  buttons.push(button("✅ 対応済み", "work_close", item.id));
  buttons.push(button("❌ 対象外", "work_ignore", item.id));

  return [
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `種類: ${KIND_LABEL[item.kind]} ｜ 優先度: ${PRIORITY_LABEL[item.priority]}${item.stall_reason ? ` ｜ 止まっていそうな理由: ${item.stall_reason}` : ""}`,
        },
      ],
    },
    { type: "actions", block_id: `work_actions_${item.id}`, elements: buttons },
  ];
}

// ------------------------------------------------------------
// 4. ボタンの処理
// ------------------------------------------------------------

export async function getItem(id: string): Promise<WorkItem | null> {
  const db = getDb();
  const rows = (await db`SELECT * FROM work_items WHERE id = ${id}`) as WorkItem[];
  return rows[0] || null;
}

/**
 * 押されたカードのボタン部分を、状態を示す1行に差し替える
 * （カードの中身＝依頼内容や分析結果はそのまま残す）
 */
export async function settleCard(
  botClient: WebClient,
  channel: string,
  ts: string,
  blocks: KnownBlock[],
  note: string,
): Promise<void> {
  const kept = blocks.filter((b) => b.type !== "actions");
  kept.push({ type: "context", elements: [{ type: "mrkdwn", text: note }] });
  await botClient.chat.update({ channel, ts, text: note, blocks: kept });
}

export function discardDraftStatus(item: WorkItem): WorkStatus {
  return item.result_json ? "done" : "proposed";
}

export async function queueAnalysis(id: string, instruction?: string): Promise<void> {
  const db = getDb();
  if (instruction) {
    await db`
      UPDATE work_items
      SET status = 'queued',
          instruction = CASE WHEN instruction IS NULL THEN ${instruction}
                             ELSE instruction || E'\n' || ${instruction} END,
          last_error = NULL, updated_at = NOW()
      WHERE id = ${id}
    `;
  } else {
    await db`
      UPDATE work_items SET status = 'queued', last_error = NULL, updated_at = NOW()
      WHERE id = ${id}
    `;
  }
}

export async function setStatus(id: string, status: WorkStatus): Promise<void> {
  const db = getDb();
  await db`UPDATE work_items SET status = ${status}, updated_at = NOW() WHERE id = ${id}`;
}

export async function snooze(id: string): Promise<void> {
  const db = getDb();
  await db`
    UPDATE work_items
    SET status = 'snoozed', snooze_until = ${nextMorning(9, 0).toISOString()}, updated_at = NOW()
    WHERE id = ${id}
  `;
}

const DRAFT_SYSTEM = `あなたは株式会社SAFELYの執行役員・BSG General Manager である高橋幹佳の代わりに、Slack の返信文の下書きを書きます。
- 高橋さん本人として書く。敬体で、落ち着いた丁寧な言葉づかい。絶対に過剰な称賛や絵文字を並べない
- 結論を先に、次に根拠、最後に次のアクション（誰が・いつまでに・何を）
- 分析結果がある場合は、数字と出典をそのまま使い、確かでないものは「未確認」と書く
- 相手に判断や確認を求める場合は、何を決めてほしいかを1文で明確にする
- 「いかがでしたか」「まとめると」などの定型文は使わない
- 返信本文だけを出力する（前置き・署名・説明は不要）`;

export async function createDraft(item: WorkItem): Promise<string> {
  const result = item.result_json
    ? `\n\n## 分析結果\n事実: ${item.result_json.facts}\n見立て: ${item.result_json.assessment}\n次の対応: ${item.result_json.next_actions}\n相談事項: ${item.result_json.decisions}`
    : "";
  const draft = await callClaudeText(
    DRAFT_SYSTEM,
    `## 依頼（${item.is_dm ? "DM" : `#${item.channel_name}`}）\n${item.summary}\n\n## やり取り\n${item.context_text || ""}${result}\n\n上の依頼への返信を書いてください。`,
  );
  const db = getDb();
  await db`
    UPDATE work_items SET draft_text = ${draft}, status = 'drafted', updated_at = NOW()
    WHERE id = ${item.id}
  `;
  return draft;
}

export async function saveDraft(id: string, text: string): Promise<void> {
  const db = getDb();
  await db`UPDATE work_items SET draft_text = ${text}, updated_at = NOW() WHERE id = ${id}`;
}

export function draftCardBlocks(item: WorkItem, draft: string): KnownBlock[] {
  const where = item.is_dm ? "DM" : `#${item.channel_name}`;
  const night = isNightJst();
  const buttons: SlackTypes.Button[] = night
    ? [
        button("⏰ 明朝8:30に送信", "work_send_schedule", item.id, "primary"),
        button("今すぐ送信", "work_send", item.id),
      ]
    : [button("✅ この内容で送信", "work_send", item.id, "primary")];
  buttons.push(button("✏️ 直す", "work_edit", item.id));
  buttons.push(button("🗑 送らない", "work_discard", item.id));

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `📝 *返信の下書き*（${where} → <@${item.requester_id}>）\n*依頼：*${item.summary}`,
      },
    },
    { type: "section", text: { type: "mrkdwn", text: quote(draft) } },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: night
            ? "まだ送っていません。22時〜翌5時のため、明朝の予約送信をおすすめします。"
            : "まだ送っていません。✅ を押すと高橋さん名義で送信します。",
        },
      ],
    },
    { type: "actions", block_id: `work_draft_actions_${item.id}`, elements: buttons },
  ];
}

/** 下書きを高橋さん名義で送る（✅ が押されたときだけ呼ぶ） */
export async function sendDraft(
  item: WorkItem,
  mode: "now" | "schedule",
): Promise<{ note: string }> {
  if (!env.SLACK_USER_TOKEN) throw new Error("SLACK_USER_TOKEN が未設定です");
  if (!item.draft_text) throw new Error("下書きがありません");
  const userClient = new WebClient(env.SLACK_USER_TOKEN);
  const threadTs = item.is_dm ? undefined : item.thread_ts;
  const db = getDb();

  if (mode === "schedule") {
    const postAt = Math.floor(nextMorning(8, 30).getTime() / 1000);
    await userClient.chat.scheduleMessage({
      channel: item.channel_id,
      text: item.draft_text,
      post_at: postAt,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    await db`UPDATE work_items SET status = 'scheduled', updated_at = NOW() WHERE id = ${item.id}`;
    return { note: `⏰ ${formatJst(String(postAt))} に送信するよう予約しました。` };
  }

  const res = await userClient.chat.postMessage({
    channel: item.channel_id,
    text: item.draft_text,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
  await db`
    UPDATE work_items SET status = 'sent', sent_ts = ${res.ts || null}, updated_at = NOW()
    WHERE id = ${item.id}
  `;
  let link = "";
  try {
    const p = await userClient.chat.getPermalink({
      channel: item.channel_id,
      message_ts: res.ts || "",
    });
    link = p.permalink ? ` <${p.permalink}|送った返信を開く>` : "";
  } catch {
    // リンク取得の失敗は送信結果に影響しない
  }
  return { note: `✅ 送信しました。${link}` };
}

// ------------------------------------------------------------
// 共通
// ------------------------------------------------------------

function button(
  text: string,
  actionId: string,
  value: string,
  style?: "primary" | "danger",
): SlackTypes.Button {
  return {
    type: "button",
    text: { type: "plain_text", text },
    action_id: actionId,
    value,
    ...(style ? { style } : {}),
  };
}

function renderMessages(
  messages: { user: string; text: string; ts: string }[],
  names: Map<string, string>,
): string {
  return messages
    .map((m) => {
      const who = m.user === SLACK_USER_ID ? "【高橋】" : names.get(m.user) || m.user;
      return `[${formatJst(m.ts)}] ${who}: ${m.text}`;
    })
    .join("\n");
}

function quote(text: string): string {
  const body = text.length > 2800 ? `${text.slice(0, 2800)}…` : text;
  return body
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

async function openDm(botClient: WebClient): Promise<string> {
  const dm = await botClient.conversations.open({ users: SLACK_USER_ID });
  if (!dm.channel?.id) throw new Error("DM を開けませんでした");
  return dm.channel.id;
}

function jstNow(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
}

export function isNightJst(): boolean {
  const h = jstNow().getHours();
  return h >= 22 || h < 5;
}

/** 次の「日本時間 hh:mm」（今日のその時刻を過ぎていれば翌日） */
function nextMorning(hour: number, minute: number): Date {
  const now = new Date();
  const jst = jstNow();
  const offsetMs = jst.getTime() - now.getTime(); // 実行環境のTZとJSTの差
  const target = new Date(jst);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= jst.getTime()) target.setDate(target.getDate() + 1);
  return new Date(target.getTime() - offsetMs);
}

function formatJst(ts: string): string {
  return new Date(Number(ts) * 1000).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ageLabel(ts: string): string {
  const hours = (Date.now() - Number(ts) * 1000) / 3600000;
  if (hours < 24) return `${Math.max(1, Math.round(hours))}時間前`;
  return `${Math.round(hours / 24)}日前`;
}

async function getKv(key: string): Promise<string | null> {
  const db = getDb();
  const rows = (await db`SELECT value FROM mamo_kv WHERE key = ${key}`) as {
    value: string;
  }[];
  return rows[0]?.value || null;
}

async function setKv(key: string, value: string): Promise<void> {
  const db = getDb();
  await db`
    INSERT INTO mamo_kv (key, value) VALUES (${key}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
