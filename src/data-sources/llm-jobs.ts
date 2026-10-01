import type { WebClient } from "@slack/web-api";
import { SLACK_USER_ID } from "../config/env.js";
import { getDb } from "./database.js";
import { getKv, setKv } from "./work-inbox.js";

// ============================================================
// PC の worker に渡す作業（Claude を使う処理）のキュー
// - mamo（Railway）は Claude を呼ばず、ここに積んで worker を起こすだけ
// - worker を起こす合図は Slack の「連絡用スレッド」への返信（DB を定期的に見に行かないため。
//   Neon は問い合わせがないと計算資源が止まり、費用が抑えられる）
// - worker は合図を受けたときだけ DB から作業を取り出す
// ============================================================

export type JobKind = "work_scan" | "chat" | "draft" | "orbit_intake" | "mgr_extract";

export interface LlmJob {
  id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  status: "queued" | "running" | "done" | "failed";
  error: string | null;
  created_at: string;
}

const BOARD_KEY = "worker_board";
const BOARD_TEXT =
  "🛠 mamo ⇄ PCの worker の連絡用です（自動で使います。このスレッドの返信は worker が読んだら消えます）";

export async function enqueueJob(
  client: WebClient,
  kind: JobKind,
  payload: Record<string, unknown> = {},
): Promise<string> {
  const db = getDb();
  const id = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await db`
    INSERT INTO llm_jobs (id, kind, payload, status)
    VALUES (${id}, ${kind}, ${JSON.stringify(payload)}::jsonb, 'queued')
  `;
  await signalWorker(client);
  return id;
}

/** worker に「作業が入った」と知らせる（連絡用スレッドに短い返信を付ける） */
export async function signalWorker(client: WebClient): Promise<void> {
  try {
    const board = await ensureBoard(client);
    await client.chat.postMessage({ channel: board.channel, thread_ts: board.ts, text: "🔔" });
  } catch (e) {
    // 合図に失敗しても、worker は起動時と定期確認で拾う
    console.error("[LlmJobs] signal failed:", e);
  }
}

/** 連絡用スレッドの親メッセージ（高橋さんとの DM に1つだけ置く） */
export async function ensureBoard(client: WebClient): Promise<{ channel: string; ts: string }> {
  const saved = await getBoard();
  if (saved) return saved;
  const dm = await client.conversations.open({ users: SLACK_USER_ID });
  if (!dm.channel?.id) throw new Error("DM を開けませんでした");
  const res = await client.chat.postMessage({ channel: dm.channel.id, text: BOARD_TEXT });
  if (!res.ts) throw new Error("連絡用メッセージを作れませんでした");
  await setKv(BOARD_KEY, `${dm.channel.id}:${res.ts}`);
  return { channel: dm.channel.id, ts: res.ts };
}

export async function getBoard(): Promise<{ channel: string; ts: string } | null> {
  const v = await getKv(BOARD_KEY);
  if (!v) return null;
  const [channel, ts] = v.split(":");
  return channel && ts ? { channel, ts } : null;
}

// ------------------------------------------------------------
// worker 側
// ------------------------------------------------------------

export async function claimJob(kinds: JobKind[]): Promise<LlmJob | null> {
  const db = getDb();
  const rows = (await db`
    UPDATE llm_jobs
    SET status = 'running', started_at = NOW()
    WHERE id = (
      SELECT id FROM llm_jobs
      WHERE status = 'queued' AND kind = ANY(${kinds}::text[])
      ORDER BY created_at LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `) as LlmJob[];
  return rows[0] || null;
}

export async function finishJob(id: string, error?: string): Promise<void> {
  const db = getDb();
  await db`
    UPDATE llm_jobs
    SET status = ${error ? "failed" : "done"}, error = ${error || null}, finished_at = NOW()
    WHERE id = ${id}
  `;
}

/** 同じ種類の作業待ちをまとめて完了扱いにする（PCが止まっていて拾い上げが溜まった場合など） */
export async function settleDuplicates(kind: JobKind, exceptId: string): Promise<number> {
  const db = getDb();
  const rows = (await db`
    UPDATE llm_jobs SET status = 'done', error = 'まとめて実行したため省略', finished_at = NOW()
    WHERE kind = ${kind} AND status = 'queued' AND id <> ${exceptId}
    RETURNING id
  `) as { id: string }[];
  return rows.length;
}

/** 中断した作業を作業待ちに戻す（worker は1台なので、起動時の running はすべて中断扱い） */
export async function requeueStaleJobs(minutes: number): Promise<number> {
  const db = getDb();
  const rows = (await db`
    UPDATE llm_jobs SET status = 'queued', error = 'worker が中断したため作業待ちに戻しました'
    WHERE status = 'running' AND started_at < NOW() - make_interval(mins => ${minutes}::int)
    RETURNING id
  `) as { id: string }[];
  return rows.length;
}
