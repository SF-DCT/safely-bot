import { app } from "./app.js";
import {
  env,
  SLACK_USER_ID,
  SLACK_REPORT_CHANNEL,
  CGS_CHANNEL_ID,
} from "./config/env.js";
import { scheduleIntelligenceBriefing } from "./scheduler/intelligence-briefing.js";
import { scheduleGmailCheck } from "./scheduler/gmail-check.js";
import { scheduleDailyReport } from "./scheduler/daily-report.js";
import { scheduleEnhancedCvUpload } from "./scheduler/enhanced-cv.js";
import { scheduleAdSpendSync } from "./scheduler/ad-spend-sync.js";
import { scheduleAdReport } from "./scheduler/ad-report.js";
import { schedulePendingThreadsCheck } from "./scheduler/pending-threads.js";
import { scheduleMgrIdeaExtract } from "./scheduler/mgr-idea-extract.js";
import { scheduleMirrorBounceCheck } from "./scheduler/mirror-bounce-check.js";
import { scheduleReviewWatch } from "./scheduler/review-watch.js";
import { scheduleWorkInbox } from "./scheduler/work-inbox.js";
import { initDatabase } from "./data-sources/database.js";
import type { BlockAction, types as SlackTypes } from "@slack/bolt";
import {
  getItem,
  settleCard,
  queueAnalysis,
  setStatus,
  snooze,
  saveDraft,
  draftCardBlocks,
  sendDraft,
  discardDraftStatus,
} from "./data-sources/work-inbox.js";
import { enqueueJob, signalWorker, ensureBoard } from "./data-sources/llm-jobs.js";
// 2026-05-09: シナリオエンジンは Orbit (cgs-crm) に移管 (Phase B/C)。
// mamo側の seed/engine 起動は廃止。tools経由でOrbit HTTP APIを叩く。
import {
  postApprovedReport,
  getPendingDraft,
  clearPendingDraft,
  setEditMode,
  handleEditFeedback,
} from "./report/report-sender.js";
import {
  approveRequest,
  rejectRequest,
  askRequester,
} from "./data-sources/orbit-fix.js";

let botUserId = "";

// ============================================================
// 2026-10-01: API課金を避けるため、mamo（Railway）は Claude を呼ばない。
// Claude を使う処理（会話・依頼の仕分け・下書き・Orbit分類・MGR抽出）は
// llm_jobs に積み、高橋さんのPCの worker（サブスクの Claude Code）が実行する。
// PCの Claude Code はワークスペース全体を読めるため、会話は高橋さん本人からだけ受け付ける。
// 会話オブザーバーは同日に停止。
// ============================================================

const SCAN_COMMAND = /依頼.*(拾|ひろ|チェック|確認|ある)|溜まってる依頼|代わりにできること/;

function isNightJst(): boolean {
  const h = Number(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hour12: false }),
  ) % 24;
  return h >= 22 || h < 7;
}

/** PCの worker が動かない時間帯の注記（22時〜翌7時は作業しない） */
function pcNote(): string {
  return isNightJst() ? "\n（22時〜7時はPCで作業しないため、7時以降に対応します）" : "";
}

const NOT_ACCEPTING =
  "mamo への質問は、現在は高橋さん本人からのみ受け付けています（回答に高橋さんのPCの Claude Code を使っているため）。";

/** 会話を PC の worker に頼む。考え中の表示を先に出し、worker がそれを回答に書き換える */
async function requestChat(channel: string, text: string, requestTs: string, threadTs?: string) {
  const placeholder = await app.client.chat.postMessage({
    channel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    text: `💭 PCの Claude Code が考えています…（1〜3分）${pcNote()}`,
  });
  await enqueueJob(app.client, "chat", {
    channel,
    text,
    request_ts: requestTs,
    thread_ts: threadTs || null,
    placeholder_ts: placeholder.ts || null,
  });
}

// DM message handler — 会話は PC の worker に回す
app.message(async ({ message, say }) => {
  if (message.subtype) return;
  if (!("text" in message) || !message.text) return;
  if (!("user" in message)) return;
  if (message.user === botUserId) return;

  // DM以外では自発応答しない（チャンネル/グループでの反応は app_mention 経由のみ）
  if (!("channel_type" in message) || message.channel_type !== "im") return;
  if (!("channel" in message)) return;

  if (message.user !== SLACK_USER_ID) {
    await say(NOT_ACCEPTING);
    return;
  }

  // 日報修正モード中なら、メッセージを修正指示として扱う（日報の定時実行は停止中）
  const pendingState = getPendingDraft(message.user);
  if (pendingState?.editing) {
    try {
      await handleEditFeedback(
        app.client,
        message.user,
        message.channel,
        message.text,
      );
    } catch (e) {
      console.error("[DailyReport] Edit error:", e);
      await say("修正の反映中にエラーが発生しました。もう一度お試しください。");
    }
    return;
  }

  try {
    if (SCAN_COMMAND.test(message.text)) {
      await enqueueJob(app.client, "work_scan", { manual: true });
      await say(`高橋さん宛ての依頼を拾うよう、PCの Claude Code に頼みました。数分でカードが届きます。${pcNote()}`);
      return;
    }
    await requestChat(message.channel, message.text, message.ts);
  } catch (e) {
    console.error("[Chat] request error:", e);
    await say("すみません、PCへの依頼でエラーが発生しました。もう一度お試しください。");
  }
});

// App mention handler — 全応答はスレッド内に集約する（チャンネル本体への直接投稿を避ける）
app.event("app_mention", async ({ event, say }) => {
  const text = (event.text || "").replace(/<@[^>]+>/g, "").trim();
  // スレッド内 → そのスレッドへ。スレッド外 → 親メッセージのtsに新スレッド。
  const replyThreadTs = event.thread_ts || event.ts;

  if (!text) {
    await say({
      text: `<@${event.user}> 何かお手伝いできることはありますか？`,
      thread_ts: replyThreadTs,
    });
    return;
  }

  // CGSチャンネル内 → Orbit改修依頼の分類（Claude を使うため PC の worker で実行）
  if (event.user && event.channel === CGS_CHANNEL_ID) {
    try {
      await enqueueJob(app.client, "orbit_intake", {
        channelId: event.channel,
        userId: event.user,
        text,
        ts: event.ts,
        threadTs: event.thread_ts || null,
        source: "mention",
      });
    } catch (e) {
      console.error("[OrbitFix] mention intake enqueue error:", e);
    }
    // CGSチャンネルでOrbit以外の話題には反応しない（無駄な発信防止）
    return;
  }

  if (event.user !== SLACK_USER_ID) {
    await say({ text: NOT_ACCEPTING, thread_ts: replyThreadTs });
    return;
  }

  try {
    await requestChat(event.channel, text, event.ts, replyThreadTs);
  } catch (e) {
    console.error("[Chat] mention request error:", e);
    await say({
      text: "すみません、PCへの依頼でエラーが発生しました。もう一度お試しください。",
      thread_ts: replyThreadTs,
    });
  }
});

// --- 日報 Block Kit ボタンハンドラー ---

app.action("daily_report_approve", async ({ ack, body }) => {
  await ack();
  const userId = body.user.id;
  try {
    const ts = await postApprovedReport(app.client, userId);
    const dm = await app.client.conversations.open({ users: userId });
    const channelId = dm.channel?.id;
    if (channelId) {
      await app.client.chat.postMessage({
        channel: channelId,
        text: ts
          ? ":white_check_mark: 日報を <#" + SLACK_REPORT_CHANNEL + "> に投稿しました！"
          : ":warning: 保留中のドラフトが見つかりませんでした。",
      });
    }
  } catch (e) {
    console.error("[DailyReport] Approve error:", e);
  }
});

app.action("daily_report_edit", async ({ ack, body }) => {
  await ack();
  const userId = body.user.id;
  setEditMode(userId, true);
  try {
    const dm = await app.client.conversations.open({ users: userId });
    const channelId = dm.channel?.id;
    if (channelId) {
      await app.client.chat.postMessage({
        channel: channelId,
        text: ":pencil2: 修正内容をメッセージで送ってください。（例: 「MTGにXX会議を追加」「不足欄を○○に変更」）",
      });
    }
  } catch (e) {
    console.error("[DailyReport] Edit mode error:", e);
  }
});

app.action("daily_report_cancel", async ({ ack, body }) => {
  await ack();
  const userId = body.user.id;
  clearPendingDraft(userId);
  try {
    const dm = await app.client.conversations.open({ users: userId });
    const channelId = dm.channel?.id;
    if (channelId) {
      await app.client.chat.postMessage({
        channel: channelId,
        text: ":x: 日報の作成をキャンセルしました。",
      });
    }
  } catch (e) {
    console.error("[DailyReport] Cancel error:", e);
  }
});

// --- Orbit改修依頼 1段階目承認ボタン ---

app.action("orbit_fix_approve", async ({ ack, action }) => {
  await ack();
  const requestId = (action as { value?: string }).value || "";
  try {
    await approveRequest(app.client, requestId);
  } catch (e) {
    console.error("[OrbitFix] approve action error:", e);
  }
});

app.action("orbit_fix_reject", async ({ ack, body, action, client }) => {
  await ack();
  const requestId = (action as { value?: string }).value || "";
  const triggerId = (body as { trigger_id?: string }).trigger_id || "";
  try {
    await client.views.open({
      trigger_id: triggerId,
      view: {
        type: "modal",
        callback_id: "orbit_fix_reject_submit",
        private_metadata: requestId,
        title: { type: "plain_text", text: "却下理由を入力" },
        submit: { type: "plain_text", text: "却下を送信" },
        close: { type: "plain_text", text: "キャンセル" },
        blocks: [
          {
            type: "input",
            block_id: "reason_block",
            label: {
              type: "plain_text",
              text: "依頼者に伝える却下理由",
            },
            element: {
              type: "plain_text_input",
              action_id: "reason_input",
              multiline: true,
              placeholder: {
                type: "plain_text",
                text: "例: 既存機能で代替可能。〜の機能を使ってください。",
              },
            },
          },
        ],
      },
    });
  } catch (e) {
    console.error("[OrbitFix] reject modal open error:", e);
  }
});

app.action("orbit_fix_ask", async ({ ack, body, action, client }) => {
  await ack();
  const requestId = (action as { value?: string }).value || "";
  const triggerId = (body as { trigger_id?: string }).trigger_id || "";
  try {
    await client.views.open({
      trigger_id: triggerId,
      view: {
        type: "modal",
        callback_id: "orbit_fix_ask_submit",
        private_metadata: requestId,
        title: { type: "plain_text", text: "依頼者に質問" },
        submit: { type: "plain_text", text: "質問を送信" },
        close: { type: "plain_text", text: "キャンセル" },
        blocks: [
          {
            type: "input",
            block_id: "question_block",
            label: {
              type: "plain_text",
              text: "依頼者へ送る確認事項",
            },
            element: {
              type: "plain_text_input",
              action_id: "question_input",
              multiline: true,
              placeholder: {
                type: "plain_text",
                text: "例: 該当画面のURLと、再現手順を教えてください。",
              },
            },
          },
        ],
      },
    });
  } catch (e) {
    console.error("[OrbitFix] ask modal open error:", e);
  }
});

app.view("orbit_fix_reject_submit", async ({ ack, view }) => {
  await ack();
  const requestId = view.private_metadata;
  const reason =
    view.state.values.reason_block?.reason_input?.value?.trim() || "";
  if (!requestId || !reason) return;
  try {
    await rejectRequest(app.client, requestId, reason);
  } catch (e) {
    console.error("[OrbitFix] reject submit error:", e);
  }
});

app.view("orbit_fix_ask_submit", async ({ ack, view }) => {
  await ack();
  const requestId = view.private_metadata;
  const question =
    view.state.values.question_block?.question_input?.value?.trim() || "";
  if (!requestId || !question) return;
  try {
    await askRequester(app.client, requestId, question);
  } catch (e) {
    console.error("[OrbitFix] ask submit error:", e);
  }
});

// --- 業務の受付箱（Work Inbox）ボタンハンドラー ---
// カードは高橋さんのDMにだけ届く。送信系は ✅ を押したときだけ実行する。

type KnownBlock = SlackTypes.KnownBlock;

function cardOf(body: unknown): { channel: string; ts: string; blocks: KnownBlock[] } {
  const b = body as BlockAction;
  return {
    channel: b.channel?.id || b.container?.channel_id || "",
    ts: b.message?.ts || b.container?.message_ts || "",
    blocks: ((b.message?.blocks as KnownBlock[] | undefined) || []),
  };
}

function valueOf(action: unknown): string {
  return (action as { value?: string }).value || "";
}

async function notifyWorkError(channel: string, e: unknown): Promise<void> {
  console.error("[WorkInbox] action error:", e);
  try {
    await app.client.chat.postMessage({
      channel,
      text: `:x: 処理中にエラーが発生しました: ${e instanceof Error ? e.message : String(e)}`,
    });
  } catch {
    // ignore
  }
}

app.action("work_analyze", async ({ ack, body, action }) => {
  await ack();
  const card = cardOf(body);
  try {
    await queueAnalysis(valueOf(action));
    await signalWorker(app.client);
    await settleCard(
      app.client,
      card.channel,
      card.ts,
      card.blocks,
      "⏳ 作業待ちに入れました。PCの Claude Code が順番に分析し、結果をここに送ります（PCが起動中のとき・22時〜7時は翌朝）。",
    );
  } catch (e) {
    await notifyWorkError(card.channel, e);
  }
});

app.action("work_retry", async ({ ack, body, action }) => {
  await ack();
  const card = cardOf(body);
  try {
    await queueAnalysis(valueOf(action));
    await signalWorker(app.client);
    await settleCard(app.client, card.channel, card.ts, card.blocks, "⏳ もう一度、作業待ちに入れました。");
  } catch (e) {
    await notifyWorkError(card.channel, e);
  }
});

app.action("work_snooze", async ({ ack, body, action }) => {
  await ack();
  const card = cardOf(body);
  try {
    await snooze(valueOf(action));
    await settleCard(app.client, card.channel, card.ts, card.blocks, "🕒 明日の朝にもう一度お知らせします。");
  } catch (e) {
    await notifyWorkError(card.channel, e);
  }
});

app.action("work_close", async ({ ack, body, action }) => {
  await ack();
  const card = cardOf(body);
  try {
    await setStatus(valueOf(action), "closed");
    await settleCard(app.client, card.channel, card.ts, card.blocks, "✅ 対応済みにしました。");
  } catch (e) {
    await notifyWorkError(card.channel, e);
  }
});

app.action("work_ignore", async ({ ack, body, action }) => {
  await ack();
  const card = cardOf(body);
  try {
    await setStatus(valueOf(action), "ignored");
    await settleCard(app.client, card.channel, card.ts, card.blocks, "❌ 対象外にしました（今後は拾いません）。");
  } catch (e) {
    await notifyWorkError(card.channel, e);
  }
});

app.action("work_draft", async ({ ack, body, action }) => {
  await ack();
  const card = cardOf(body);
  try {
    const item = await getItem(valueOf(action));
    if (!item) throw new Error("依頼が見つかりませんでした");
    // 下書きは Claude を使うため PC の worker で作る（できたらこの表示を下書きカードに書き換える）
    const placeholder = await app.client.chat.postMessage({
      channel: card.channel,
      text: `📝 返信の下書きを作っています…（PCの Claude Code で作成・1〜2分）${pcNote()}`,
    });
    await enqueueJob(app.client, "draft", {
      item_id: item.id,
      channel: card.channel,
      placeholder_ts: placeholder.ts || null,
    });
  } catch (e) {
    await notifyWorkError(card.channel, e);
  }
});

async function handleSend(body: unknown, action: unknown, mode: "now" | "schedule"): Promise<void> {
  const card = cardOf(body);
  try {
    const item = await getItem(valueOf(action));
    if (!item) throw new Error("依頼が見つかりませんでした");
    const { note } = await sendDraft(item, mode);
    await settleCard(app.client, card.channel, card.ts, card.blocks, note);
  } catch (e) {
    await notifyWorkError(card.channel, e);
  }
}

app.action("work_send", async ({ ack, body, action }) => {
  await ack();
  await handleSend(body, action, "now");
});

app.action("work_send_schedule", async ({ ack, body, action }) => {
  await ack();
  await handleSend(body, action, "schedule");
});

app.action("work_discard", async ({ ack, body, action }) => {
  await ack();
  const card = cardOf(body);
  try {
    const item = await getItem(valueOf(action));
    if (item) await setStatus(item.id, discardDraftStatus(item));
    await settleCard(app.client, card.channel, card.ts, card.blocks, "🗑 この下書きは送らないことにしました。");
  } catch (e) {
    await notifyWorkError(card.channel, e);
  }
});

app.action("work_edit", async ({ ack, body, action, client }) => {
  await ack();
  const card = cardOf(body);
  try {
    const item = await getItem(valueOf(action));
    if (!item) throw new Error("依頼が見つかりませんでした");
    await client.views.open({
      trigger_id: (body as { trigger_id?: string }).trigger_id || "",
      view: {
        type: "modal",
        callback_id: "work_edit_submit",
        private_metadata: JSON.stringify({ id: item.id, channel: card.channel, ts: card.ts }),
        title: { type: "plain_text", text: "下書きを直す" },
        submit: { type: "plain_text", text: "保存（まだ送らない）" },
        close: { type: "plain_text", text: "キャンセル" },
        blocks: [
          {
            type: "input",
            block_id: "draft_block",
            label: { type: "plain_text", text: "返信の本文" },
            element: {
              type: "plain_text_input",
              action_id: "draft_input",
              multiline: true,
              initial_value: (item.draft_text || "").slice(0, 3000),
            },
          },
        ],
      },
    });
  } catch (e) {
    await notifyWorkError(card.channel, e);
  }
});

app.view("work_edit_submit", async ({ ack, view }) => {
  await ack();
  const meta = JSON.parse(view.private_metadata || "{}") as { id?: string; channel?: string; ts?: string };
  const text = view.state.values.draft_block?.draft_input?.value?.trim() || "";
  if (!meta.id || !meta.channel || !meta.ts || !text) return;
  try {
    await saveDraft(meta.id, text);
    const item = await getItem(meta.id);
    if (!item) return;
    await app.client.chat.update({
      channel: meta.channel,
      ts: meta.ts,
      text: "📝 返信の下書き（修正済み）",
      blocks: draftCardBlocks(item, text),
    });
  } catch (e) {
    await notifyWorkError(meta.channel, e);
  }
});

app.action("work_reinstruct", async ({ ack, body, action, client }) => {
  await ack();
  const card = cardOf(body);
  try {
    await client.views.open({
      trigger_id: (body as { trigger_id?: string }).trigger_id || "",
      view: {
        type: "modal",
        callback_id: "work_reinstruct_submit",
        private_metadata: JSON.stringify({ id: valueOf(action), channel: card.channel, ts: card.ts }),
        title: { type: "plain_text", text: "指示を足してやり直す" },
        submit: { type: "plain_text", text: "作業待ちに入れる" },
        close: { type: "plain_text", text: "キャンセル" },
        blocks: [
          {
            type: "input",
            block_id: "instruction_block",
            label: { type: "plain_text", text: "追加の指示" },
            element: {
              type: "plain_text_input",
              action_id: "instruction_input",
              multiline: true,
              placeholder: {
                type: "plain_text",
                text: "例: 8月と9月の比較にして、TCとSFを分けて見て",
              },
            },
          },
        ],
      },
    });
  } catch (e) {
    await notifyWorkError(card.channel, e);
  }
});

app.view("work_reinstruct_submit", async ({ ack, view }) => {
  await ack();
  const meta = JSON.parse(view.private_metadata || "{}") as { id?: string; channel?: string; ts?: string };
  const instruction = view.state.values.instruction_block?.instruction_input?.value?.trim() || "";
  if (!meta.id || !meta.channel || !instruction) return;
  try {
    await queueAnalysis(meta.id, instruction);
    await signalWorker(app.client);
    await app.client.chat.postMessage({
      channel: meta.channel,
      ...(meta.ts ? { thread_ts: meta.ts } : {}),
      text: `⏳ 追加の指示で作業待ちに入れました。\n> ${instruction.replace(/\n/g, "\n> ")}`,
    });
  } catch (e) {
    await notifyWorkError(meta.channel, e);
  }
});

// Start the app
(async () => {
  // Bot自身のUser IDを取得
  const authResult = await app.client.auth.test();
  botUserId = authResult.user_id || "";
  console.log(`🤖 Bot User ID: ${botUserId}`);

  // DB接続初期化 (Orbit改修依頼フロー用 — orbit_requestsテーブル等)
  // シナリオエンジンはOrbit (cgs-crm) に移管済み (2026-05-09)。
  if (env.DATABASE_URL) {
    try {
      await initDatabase();
      await ensureBoard(app.client); // PCの worker との連絡用スレッド
    } catch (e) {
      console.error("[Startup] Database init failed:", e);
    }
  }

  // scheduleIntelligenceBriefing(); // 一時停止 2026-04-21 精度改善のため回収
  // scheduleGmailCheck(); // 一時停止 2026-04-17 精度改善のため回収
  // scheduleDailyReport(); // 一時停止 2026-04-17 精度改善のため回収
  // scheduleEnhancedCvUpload(); // 一時停止 2026-08-05 難波さん側でCV設定を進めるため（二重アップロード防止）
  scheduleAdSpendSync();
  scheduleAdReport();
  scheduleMgrIdeaExtract();
  scheduleMirrorBounceCheck();
  scheduleReviewWatch();
  if (env.DATABASE_URL) scheduleWorkInbox(); // 業務の受付箱（work_items テーブル必須）
  // schedulePendingThreadsCheck(); // 一時停止 2026-04-17 精度改善のため回収

  await app.start();
  console.log("⚡ SAFELY Bot is running!");
  console.log("🧠 Claude: PC worker only (no API key usage on Railway)");
  console.log("💤 Proactive observer: stopped (2026-10-01)");
  // console.log("📰 Intelligence briefing: weekdays 9:00 JST"); // 一時停止
  //   console.log("📬 Gmail check: weekdays 8:30 JST"); // 一時停止
  //   console.log("💬 Pending threads check: weekdays 9:30 JST"); // 一時停止
  //   console.log("📝 Daily report: weekdays 19:00 JST"); // 一時停止
  // console.log("📊 Enhanced CV upload: weekdays 9:00 JST"); // 一時停止 2026-08-05
  console.log("📈 Ad spend sync: weekdays 8:00 JST");
  console.log("📊 Ad report: weekdays 9:05 JST");
  console.log("📥 MGR weekly idea extract: Fridays 14:00 JST");
  console.log("🚨 Mirror bounce check: every 30 min (24/7)");
  console.log("💬 TC review watch: every 15 min (24/7)");
  console.log("📥 Work inbox: weekdays 9:30 / 14:00 JST (worker = 高橋さんのPC)");
  console.log(`🛰️ Orbit改修依頼フロー (Phase 1): @mamo mention in ${CGS_CHANNEL_ID}`);
  console.log(`🔄 Scenario engine: Orbit (${env.ORBIT_API_BASE}) — operated via tools`);
})();
