// mamo の worker — 高橋さんのPCで常駐し、Claude を使う処理をすべて引き受ける
//
// 2026-10-01 から API キー（従量課金）は使わない。mamo（Railway）は作業をキューに積むだけで、
// このPCの Claude Code（サブスク）が次を実行する:
//   - 依頼の拾い上げ（仕分け）     llm_jobs.kind = work_scan
//   - 返信の下書き                 llm_jobs.kind = draft
//   - DMでの会話                   llm_jobs.kind = chat
//   - Orbit改修依頼の分類          llm_jobs.kind = orbit_intake
//   - MGR金曜アイディア抽出        llm_jobs.kind = mgr_extract
//   - 依頼の分析・整理（🔍）       work_items.status = queued
//
// 起こし方: mamo が DM の「連絡用スレッド」に返信を付ける → worker が15秒ごとに Slack を見て気づく。
// DB は合図があったときだけ見る（定期的に問い合わせると Neon の計算資源が止まらず費用がかかるため）。
//
// 起動: Corporate/mamo_project で `node node_modules/tsx/dist/cli.mjs worker/work-runner.ts`
//       （常駐はスタートアップの worker/start-hidden.vbs。手順は worker/README.md）
//
// 秘密情報: mamo の鍵は起動時に `railway variables` からこのプロセスにだけ読み込む。
//           Claude Code の子プロセスには渡さない（claude-client.ts の cliChildEnv）。

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebClient } from "@slack/web-api";
import { setCliChildEnv, runClaudeCli } from "../src/utils/claude-client.js";

const ORIGINAL_ENV = { ...process.env };
setCliChildEnv(ORIGINAL_ENV);

const MAMO_DIR = path.resolve(__dirname, "..");
const WORKSPACE = path.resolve(MAMO_DIR, "..", ".."); // My project
const OUT_REL = "Private/mamo-work";
const OUT_DIR = path.join(WORKSPACE, OUT_REL);
const LOG_FILE = path.join(OUT_DIR, "_worker.log");
const LOCK_FILE = path.join(os.tmpdir(), "mamo-work-runner.lock");

const SIGNAL_POLL_MS = 15_000; // Slack の連絡用スレッドを見る間隔（Slack API は無料）
const SAFETY_CHECK_MS = 2 * 60 * 60_000; // 合図の取りこぼしに備えて DB を見る間隔
const ANALYSIS_TIMEOUT_MS = 40 * 60_000;
const CHAT_TIMEOUT_MS = 10 * 60_000;
const SLACK_USER_ID = "U01T29EAGDB"; // 高橋幹佳
const QUICK_KINDS = ["work_scan", "chat", "draft", "orbit_intake", "mgr_extract"] as const;

// 分析・会話で Claude Code に使わせない操作（送信・書き込み・公開・デプロイ）。
// 最終的な歯止めは auto モードの判定とプロンプトの厳守事項。ここは明示的な禁止リスト。
const DISALLOWED_TOOLS = [
  "mcp__claude_ai_Slack__slack_send_message",
  "mcp__claude_ai_Slack__slack_send_message_draft",
  "mcp__claude_ai_Slack__slack_schedule_message",
  "mcp__claude_ai_Slack__slack_create_canvas",
  "mcp__claude_ai_Slack__slack_update_canvas",
  "mcp__claude_ai_Slack__slack_add_reaction",
  "mcp__claude_ai_Slack__slack_create_conversation",
  "mcp__claude_ai_Gmail",
  "mcp__claude_ai_Google_Calendar",
  "mcp__claude_ai_Canva",
  "mcp__claude_ai_Figma",
  "mcp__claude_ai_Box",
  "mcp__claude_ai_Claude_Docs",
  "mcp__claude_ai_Asana__add_comment",
  "mcp__claude_ai_Asana__create_project",
  "mcp__claude_ai_Asana__create_project_from_template",
  "mcp__claude_ai_Asana__create_project_status_update",
  "mcp__claude_ai_Asana__create_task_from_template",
  "mcp__claude_ai_Asana__create_tasks",
  "mcp__claude_ai_Asana__delete_task",
  "mcp__claude_ai_Asana__update_project",
  "mcp__claude_ai_Asana__update_tasks",
  "mcp__claude_ai_Notion__notion-create-pages",
  "mcp__claude_ai_Notion__notion-update-page",
  "mcp__claude_ai_Notion__notion-create-database",
  "mcp__claude_ai_Notion__notion-update-data-source",
  "mcp__claude_ai_Notion__notion-create-comment",
  "mcp__claude_ai_Notion__notion-move-pages",
  "mcp__claude_ai_Notion__notion-duplicate-page",
  "mcp__claude_ai_Notion__notion-create-view",
  "mcp__claude_ai_Notion__notion-update-view",
  "mcp__claude_ai_Notion__notion-create-folder",
  "mcp__claude_ai_Notion__notion-update-folder",
  "mcp__claude_ai_Notion__notion-create-attachment",
  "mcp__claude_ai_Notion__notion-create-file-upload",
  "mcp__claude_ai_Notion__notion-upload-skill",
  "mcp__claude_ai_Notion__notion-spawn-session",
  "mcp__claude_ai_Notion__notion-send-message-to-session",
  "mcp__claude_ai_sf-tool__impact_tracker_create_item",
  "mcp__claude_ai_sf-tool__impact_tracker_update_item",
  "mcp__claude_ai_sf-tool__impact_tracker_add_analysis",
  "mcp__claude_ai_sf-tool__ai_chat_post",
  "mcp__claude_ai_sf-tool__ai_chat_create_thread",
  "mcp__claude_ai_sf-tool__ai_chat_add_member",
  "mcp__claude_ai_sf-tool__ai_skill_share_create",
  "mcp__claude_ai_sf-tool__ai_skill_share_update",
  "Artifact",
  "ArtifactData",
  "ArtifactComments",
  "ShareOnboardingGuide",
  "Workflow",
  "ScheduleWakeup",
  "CronCreate",
  "RemoteTrigger",
  "PushNotification",
  "SendMessage",
  "Bash(git commit:*)",
  "Bash(git push:*)",
  "Bash(railway:*)",
  "Bash(gh:*)",
  "Bash(vercel:*)",
  "Bash(npx vercel:*)",
  "Bash(clasp:*)",
  "Bash(gws gmail:*)",
  "Bash(gws sheets spreadsheets values update:*)",
  "Bash(gws sheets spreadsheets values append:*)",
  "Bash(gws sheets spreadsheets values batchUpdate:*)",
  "Bash(gws sheets spreadsheets values clear:*)",
  "Bash(gws sheets spreadsheets batchUpdate:*)",
  "Bash(gws drive files create:*)",
  "Bash(gws drive files update:*)",
  "Bash(gws drive files delete:*)",
  "Bash(gws drive permissions:*)",
  "Bash(sfdx data create:*)",
  "Bash(sfdx data update:*)",
  "Bash(sfdx data upsert:*)",
  "Bash(sfdx data delete:*)",
  "Bash(sf data create:*)",
  "Bash(sf data update:*)",
  "Bash(sf data upsert:*)",
  "Bash(sf data delete:*)",
];
const WORKSPACE_ARGS = ["--permission-mode", "auto", "--disallowedTools", ...DISALLOWED_TOOLS];

// ------------------------------------------------------------
// 共通
// ------------------------------------------------------------

fs.mkdirSync(OUT_DIR, { recursive: true });

function log(...args: unknown[]): void {
  const line = `[${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}] ${args.join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // ログ書き込みの失敗は処理を止めない
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function jstHour(): number {
  return (
    Number(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hour12: false })) % 24
  );
}

/** 22時〜翌7時は新しい作業を始めない（結果のDMが夜中に届かないように） */
function isQuietHours(): boolean {
  const h = jstHour();
  return h >= 22 || h < 7;
}

/** スリープ復帰直後・回線の瞬断など、待てば直るエラーか */
function isNetworkError(e: unknown): boolean {
  const err = e as { message?: string; code?: string; cause?: { message?: string; code?: string } };
  const text = `${err?.message || ""} ${err?.code || ""} ${err?.cause?.message || ""} ${err?.cause?.code || ""}`;
  return /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|getaddrinfo|socket hang up|dns error|error sending request|request_timeout|不明です/i.test(
    text,
  );
}

/** 一時的な通信エラーなら、時間をおいて数回やり直す */
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= 5 || !isNetworkError(e)) throw e;
      log(`${label}: 通信エラーのため30秒後に再試行します（${i}/5）`);
      await sleep(30_000);
    }
  }
}

function acquireLock(): boolean {
  try {
    const pid = Number(fs.readFileSync(LOCK_FILE, "utf8"));
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        return false; // 別の worker が動いている
      } catch {
        // 古いロック（プロセスは終了済み）
      }
    }
  } catch {
    // ロックなし
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  return true;
}

function releaseLock(): void {
  try {
    if (Number(fs.readFileSync(LOCK_FILE, "utf8")) === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch {
    // ignore
  }
}

function loadSecrets(): Promise<Record<string, string>> {
  // Windows の railway は npm のシム（railway.cmd）なので cmd 経由で呼ぶ
  const [cmd, args] =
    process.platform === "win32"
      ? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "railway", "variables", "--service", "safely-bot", "--json"]]
      : ["railway", ["variables", "--service", "safely-bot", "--json"]];
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: MAMO_DIR, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`railway variables に失敗: ${err.message.split("\n")[0]}`));
      try {
        const vars = JSON.parse(stdout) as Record<string, string>;
        if (!vars.DATABASE_URL || !vars.SLACK_BOT_TOKEN) {
          return reject(new Error("DATABASE_URL / SLACK_BOT_TOKEN が取得できません"));
        }
        resolve(vars);
      } catch (e) {
        reject(new Error(`railway variables の出力を読めません: ${errText(e)}`));
      }
    });
  });
}

/** 起動時に接続情報を取れるまで待つ（ログオン直後はネットワークがまだないことがある） */
async function loadSecretsWithRetry(): Promise<Record<string, string>> {
  let announced = false;
  for (;;) {
    try {
      const vars = await loadSecrets();
      if (announced) log("ネットワークにつながったため、接続情報を読み込みました");
      return vars;
    } catch (e) {
      if (!announced) {
        log(`接続情報を読めないため、1分ごとに再試行します: ${errText(e)}`);
        announced = true;
      }
      await sleep(60_000);
    }
  }
}

/** レーンを起こすための小さな仕組み（起きている間に呼ばれたら次の待ちをすぐ抜ける） */
class Waker {
  private pending = true; // 起動直後は1回 DB を見る
  private resolver: (() => void) | null = null;
  wake(): void {
    this.pending = true;
    this.resolver?.();
    this.resolver = null;
  }
  async wait(): Promise<void> {
    if (this.pending) {
      this.pending = false;
      return;
    }
    await new Promise<void>((r) => (this.resolver = r));
    this.pending = false;
  }
}

// ------------------------------------------------------------
// 本体（mamo のモジュールは秘密情報を読み込んでから import する）
// ------------------------------------------------------------

async function main(): Promise<void> {
  if (!acquireLock()) {
    log("別の worker が動いているため終了します");
    return;
  }
  process.on("exit", releaseLock);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  const vars = await loadSecretsWithRetry();
  Object.assign(process.env, vars, { MAMO_LLM: "cli" });

  const wi = await import("../src/data-sources/work-inbox.js");
  const jobs = await import("../src/data-sources/llm-jobs.js");
  const orbit = await import("../src/data-sources/orbit-fix.js");
  const mgr = await import("../src/data-sources/mgr-idea-extract.js");
  const { getDb } = await import("../src/data-sources/database.js");
  const { toSlackMrkdwn } = await import("../src/utils/slack-format.js");
  const sql = getDb();
  const slack = new WebClient(vars.SLACK_BOT_TOKEN);
  log(`worker started (pid=${process.pid}, workspace=${WORKSPACE})`);

  const openDm = async () => {
    const dm = await slack.conversations.open({ users: SLACK_USER_ID });
    if (!dm.channel?.id) throw new Error("DM を開けませんでした");
    return dm.channel.id;
  };

  // 途中で止まった作業を作業待ちに戻す（worker は1台なので起動時の running は中断扱い）
  try {
    const n = await withRetry(() => jobs.requeueStaleJobs(0), "requeue jobs");
    const rows = (await withRetry(
      () => sql`
        UPDATE work_items SET status = 'queued', last_error = 'worker が中断したため、作業待ちに戻しました', updated_at = NOW()
        WHERE status = 'running' RETURNING id
      `,
      "requeue analyses",
    )) as { id: string }[];
    if (n + rows.length > 0) log(`中断していた作業を作業待ちに戻しました（${n + rows.length}件）`);
  } catch (e) {
    log(`requeue on start error: ${errText(e)}`);
  }

  // ---------------- 軽い作業（会話・下書き・拾い上げ・Orbit・MGR） ----------------

  async function runChat(p: Record<string, unknown>): Promise<void> {
    const channel = String(p.channel);
    const placeholderTs = p.placeholder_ts ? String(p.placeholder_ts) : null;
    const threadTs = p.thread_ts ? String(p.thread_ts) : null;
    const requestTs = String(p.request_ts || "");

    // 直前のやり取りを文脈として渡す（スレッドならスレッド、DM なら直近の会話）
    let transcript = "";
    try {
      const msgs = threadTs
        ? (await slack.conversations.replies({ channel, ts: threadTs, limit: 20 })).messages || []
        : ((await slack.conversations.history({ channel, latest: requestTs, limit: 12 })).messages || []).reverse();
      transcript = msgs
        .filter((m) => m.ts !== placeholderTs && m.ts !== requestTs && (m.text || "").trim())
        .slice(-12)
        .map((m) => `${m.user === SLACK_USER_ID ? "高橋" : "mamo"}: ${(m.text || "").slice(0, 600)}`)
        .join("\n");
    } catch (e) {
      log(`chat context error: ${errText(e)}`);
    }

    const late = requestTs && Date.now() / 1000 - Number(requestTs) > 2 * 3600;
    const prompt = `あなたは mamo（株式会社SAFELY の Slack 秘書）として、高橋幹佳（執行役員・BSG General Manager）からの Slack DM に答えます。
このワークスペースの CLAUDE.md とメモリの知見（データの取り方・社内ルール・人物情報）に従ってください。

## 厳守すること
- 読み取りと調べもの・分析だけを行う。Slack・メール・Asana・Notion などへの送信・投稿・作成・更新、スプレッドシート／Salesforce／WordPress／広告アカウントへの書き込み、git push、デプロイ、Artifact の公開はしない
- ファイルを作成・変更しない（必要なら ${OUT_REL}/_tmp/ だけ使ってよい）
- 送信や登録などの操作を頼まれたら、mamo ではできないことを伝え、文案や手順を返す
- 数値には出典と期間を添える。確かめられないことは「未確認」と書く
- 高橋さんが今この会話を見ていない前提で、確認のために止まらず答えを出す

## 返し方
- Slack の DM に表示する本文だけを返す（前置き・自己紹介は不要）
- 敬体で簡潔に。結論を先に。長くなるときは見出しの代わりに *太字* を使う（Markdown の # 見出しは使わない）
- 絵文字や過剰な称賛は使わない

## 直前のやり取り
${transcript || "（なし）"}

## 今回のメッセージ
${String(p.text || "")}`;

    const out = await runClaudeCli({
      prompt,
      mode: "workspace",
      cwd: WORKSPACE,
      extraArgs: WORKSPACE_ARGS,
      timeoutMs: CHAT_TIMEOUT_MS,
    });
    const answer = toSlackMrkdwn(String(out.result || "（回答を作れませんでした）")).slice(0, 38000);
    const text = late ? `（PCが止まっていたため、遅れての回答です）\n${answer}` : answer;
    if (placeholderTs) {
      await withRetry(() => slack.chat.update({ channel, ts: placeholderTs, text }), "update chat");
    } else {
      await withRetry(
        () => slack.chat.postMessage({ channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) }),
        "post chat",
      );
    }
  }

  async function runDraft(p: Record<string, unknown>): Promise<void> {
    const channel = String(p.channel);
    const placeholderTs = p.placeholder_ts ? String(p.placeholder_ts) : null;
    try {
      const item = await wi.getItem(String(p.item_id));
      if (!item) throw new Error("依頼が見つかりませんでした");
      const draft = await wi.createDraft(item);
      const blocks = wi.draftCardBlocks(item, draft);
      if (placeholderTs) {
        await withRetry(() => slack.chat.update({ channel, ts: placeholderTs, text: "📝 返信の下書き", blocks }), "update draft");
      } else {
        await withRetry(() => slack.chat.postMessage({ channel, text: "📝 返信の下書き", blocks }), "post draft");
      }
    } catch (e) {
      const text = `⚠️ 返信の下書きを作れませんでした: ${errText(e).split("\n")[0].slice(0, 300)}`;
      if (placeholderTs) await slack.chat.update({ channel, ts: placeholderTs, text }).catch(() => {});
      throw e;
    }
  }

  async function runScan(job: { id: string; payload: Record<string, unknown> }): Promise<void> {
    const merged = await jobs.settleDuplicates("work_scan", job.id);
    const manual = job.payload.manual === true;
    try {
      const summary = await wi.runWorkScan(slack, { manual: manual || merged > 0 });
      log(`scan: ${summary}`);
      if (manual) await slack.chat.postMessage({ channel: await openDm(), text: summary });
    } catch (e) {
      if (await wi.shouldNotifyScanFailure(e)) {
        await slack.chat.postMessage({ channel: await openDm(), text: wi.scanFailureText(e) }).catch(() => {});
      }
      throw e;
    }
  }

  async function runQuickJob(job: { id: string; kind: string; payload: Record<string, unknown> }): Promise<void> {
    const started = Date.now();
    log(`start ${job.kind} ${job.id}`);
    try {
      switch (job.kind) {
        case "chat":
          await runChat(job.payload);
          break;
        case "draft":
          await runDraft(job.payload);
          break;
        case "work_scan":
          await runScan(job);
          break;
        case "orbit_intake": {
          const p = job.payload;
          await orbit.handleOrbitFixIntake(slack, {
            channelId: String(p.channelId),
            userId: String(p.userId),
            text: String(p.text),
            ts: String(p.ts),
            threadTs: p.threadTs ? String(p.threadTs) : undefined,
            source: p.source === "dm" ? "dm" : "mention",
          });
          break;
        }
        case "mgr_extract":
          await mgr.runMgrIdeaExtractAndNotify(slack);
          break;
        default:
          throw new Error(`未知の作業: ${job.kind}`);
      }
      await withRetry(() => jobs.finishJob(job.id), "finish job");
      log(`done ${job.kind} ${job.id} (${Math.round((Date.now() - started) / 1000)}s)`);
    } catch (e) {
      log(`failed ${job.kind} ${job.id}: ${errText(e)}`);
      if (job.kind === "chat") {
        const p = job.payload;
        const text = `⚠️ 回答を作れませんでした: ${errText(e).split("\n")[0].slice(0, 300)}`;
        if (p.placeholder_ts) {
          await slack.chat.update({ channel: String(p.channel), ts: String(p.placeholder_ts), text }).catch(() => {});
        }
      }
      await withRetry(() => jobs.finishJob(job.id, errText(e).slice(0, 1000)), "finish job").catch(() => {});
    }
  }

  // ---------------- 分析・整理（🔍） ----------------

  type WorkItemRow = Awaited<ReturnType<typeof wi.getItem>> & { report_path?: string | null };

  function reportRelPath(item: NonNullable<WorkItemRow>): string {
    if (item.report_path) return item.report_path;
    const d = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
    return `${OUT_REL}/${d}-${String(item.id).replace(/[^A-Za-z0-9]+/g, "-")}.md`;
  }

  function analysisPrompt(item: NonNullable<WorkItemRow>, reportRel: string): string {
    const where = item.is_dm ? "DM" : `#${item.channel_name}`;
    const prev = item.result_json
      ? `\n## 前回の結果（これを踏まえて更新する）\n- 報告ファイル: ${reportRel}\n- 事実: ${item.result_json.facts}\n- 見立て: ${item.result_json.assessment}\n`
      : "";
    const instruction = item.instruction ? `\n## 高橋さんからの追加指示（最優先）\n${item.instruction}\n` : "";
    return `あなたは高橋幹佳（株式会社SAFELY 執行役員・BSG General Manager）の代わりに、Slack で届いた依頼の分析・整理を進めます。
このワークスペースの CLAUDE.md とメモリにある知見（データの取り方・落とし穴・社内ルール）に従ってください。高橋さんは今この作業を見ていません。確認のために止まらず、最後まで進めてください。

## 依頼
- 場所: ${where}
- 依頼者: <@${item.requester_id}>
- 要約: ${item.summary}
- 想定した作業: ${item.proposed_work || "（未設定。依頼内容から判断する）"}
- スレッド: ${item.permalink || "（リンクなし）"}

## やり取り（抜粋・【高橋】は本人）
${item.context_text || "（本文なし）"}
${prev}${instruction}
## 厳守すること
1. 読み取りと分析・整理だけを行う。Slack・メール・Asana・Notion・Canva などへの送信・投稿・作成・更新、スプレッドシート／Salesforce／WordPress／広告アカウントへの書き込み、git の commit／push、デプロイ、Artifact の公開は一切しない
2. 作成・変更してよいファイルは \`${reportRel}\`（報告）と \`${OUT_REL}/_tmp/\` 配下（計算用の一時ファイル）だけ
3. 数値には出典（データ・期間・取得日）を付ける。確かめられないものは「未確認」と書き、推測で埋めない
4. 判断が必要な点は、選択肢とトレードオフを整理して「相談事項」に書く。高橋さんの代わりに決めない
5. データにアクセスできない、または時間内に終わらない場合は、そこまでの結果と足りないものを書いて終える
6. 人事・評価・報酬に関わる内容は、原因を断定しない

## 出力
1. 詳しい報告を \`${reportRel}\` に日本語で書く。見出しは「事実／見立て／次の対応／相談事項／根拠データと出典／限界」
2. 最後の応答は、次の JSON オブジェクトだけにする（コードブロック・前置き・後書きは付けない）
{"title": "20字程度の件名", "facts": "いま何が起きているか", "assessment": "何が課題だと考えるか", "next_actions": "誰が・いつまでに・何をするか", "decisions": "高橋さんに判断してほしいこと（なければ「なし」）", "limitations": "確かめられなかったこと・前提"}
- 各値は Slack で読める長さにする（それぞれ400字以内。箇条書きは「・」で始めて改行で区切る）`;
  }

  function parseResult(text: string, item: NonNullable<WorkItemRow>) {
    const s = String(text || "");
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const j = JSON.parse(s.slice(start, end + 1));
        return {
          title: j.title || item.summary,
          facts: j.facts || "",
          assessment: j.assessment || "",
          next_actions: j.next_actions || "",
          decisions: j.decisions || "なし",
          limitations: j.limitations || "",
        };
      } catch {
        // 下で本文ごと返す
      }
    }
    return {
      title: item.summary,
      facts: s.slice(0, 1500),
      assessment: "（結果の形式が崩れていたため、本文をそのまま表示しています）",
      next_actions: "",
      decisions: "なし",
      limitations: "",
    };
  }

  const clip = (text: unknown, n = 2900) => {
    const s = String(text || "").trim() || "—";
    return s.length > n ? `${s.slice(0, n)}…` : s;
  };
  const btn = (text: string, action_id: string, value: string, style?: "primary") => ({
    type: "button" as const,
    text: { type: "plain_text" as const, text },
    action_id,
    value,
    ...(style ? { style } : {}),
  });

  async function runAnalysis(item: NonNullable<WorkItemRow>): Promise<void> {
    const reportRel = reportRelPath(item);
    const started = Date.now();
    const where = item.is_dm ? "DM" : `#${item.channel_name}`;
    log(`start analysis ${item.id}: ${item.summary}`);

    let result: ReturnType<typeof parseResult>;
    try {
      const out = await runClaudeCli({
        prompt: analysisPrompt(item, reportRel),
        mode: "workspace",
        cwd: WORKSPACE,
        extraArgs: WORKSPACE_ARGS,
        timeoutMs: ANALYSIS_TIMEOUT_MS,
      });
      result = parseResult(String(out.result || ""), item);
    } catch (e) {
      const message = errText(e);
      log(`failed analysis ${item.id}: ${message}`);
      await withRetry(
        () => sql`
          UPDATE work_items SET status = 'failed', last_error = ${message}, finished_at = NOW(), updated_at = NOW()
          WHERE id = ${item.id}
        `,
        "save failure",
      ).catch(() => {});
      await slack.chat
        .postMessage({
          channel: await openDm(),
          text: "⚠️ 分析を完了できませんでした",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `⚠️ *分析を完了できませんでした*\n*依頼：*<@${item.requester_id}>（${where}）${clip(item.summary, 300)}\n*理由：*${clip(message, 800)}`,
              },
            },
            {
              type: "actions",
              block_id: `work_failed_actions_${item.id}`,
              elements: [
                btn("🔁 もう一度", "work_retry", item.id),
                btn("🔁 指示を足してやり直す", "work_reinstruct", item.id),
                btn("✅ 対応済み", "work_close", item.id),
              ],
            },
          ],
        })
        .catch((e2) => log(`failure notice error: ${errText(e2)}`));
      return;
    }

    // 結果の通知と保存は、通信エラーなら時間をおいてやり直す（分析結果を捨てない）
    const minutes = Math.max(1, Math.round((Date.now() - started) / 60000));
    const reportExists = fs.existsSync(path.join(WORKSPACE, reportRel));
    const link = item.permalink ? ` <${item.permalink}|スレッドを開く>` : "";
    const channel = await withRetry(openDm, "open DM");
    const posted = await withRetry(
      () =>
        slack.chat.postMessage({
          channel,
          text: `📊 分析できました：${result.title}`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `📊 *分析できました：${clip(result.title, 150)}*\n*依頼：*<@${item.requester_id}>（${where}）${clip(item.summary, 300)}${link}`,
              },
            },
            { type: "section", text: { type: "mrkdwn", text: `*事実*\n${clip(result.facts)}` } },
            { type: "section", text: { type: "mrkdwn", text: `*見立て*\n${clip(result.assessment)}` } },
            { type: "section", text: { type: "mrkdwn", text: `*次の対応*\n${clip(result.next_actions)}` } },
            { type: "section", text: { type: "mrkdwn", text: `*相談事項（判断してほしいこと）*\n${clip(result.decisions)}` } },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `詳細: \`${reportExists ? reportRel : "（報告ファイルなし）"}\` ｜ 所要 ${minutes}分${result.limitations ? ` ｜ 限界: ${clip(result.limitations, 400)}` : ""}`,
                },
              ],
            },
            {
              type: "actions",
              block_id: `work_result_actions_${item.id}`,
              elements: [
                btn("📝 返信の下書き", "work_draft", item.id, "primary"),
                btn("🔁 指示を足してやり直す", "work_reinstruct", item.id),
                btn("✅ 完了にする", "work_close", item.id),
              ],
            },
          ],
        }),
      "post result",
    );
    await withRetry(
      () => sql`
        UPDATE work_items
        SET status = 'done', result_json = ${JSON.stringify(result)}::jsonb,
            report_path = ${reportExists ? reportRel : null}, result_ts = ${posted.ts || null},
            finished_at = NOW(), last_error = NULL, updated_at = NOW()
        WHERE id = ${item.id}
      `,
      "save result",
    );
    log(`done analysis ${item.id} (${minutes}min)`);
  }

  async function claimAnalysis(): Promise<NonNullable<WorkItemRow> | null> {
    const rows = (await sql`
      UPDATE work_items
      SET status = 'running', started_at = NOW(), updated_at = NOW()
      WHERE id = (
        SELECT id FROM work_items WHERE status = 'queued'
        ORDER BY updated_at LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `) as NonNullable<WorkItemRow>[];
    return rows[0] || null;
  }

  // ---------------- レーン（軽い作業と分析は並行。分析が長くても会話は待たせない） ----------------

  const quick = new Waker();
  const analysis = new Waker();
  const wakeAll = () => {
    quick.wake();
    analysis.wake();
  };

  async function lane(name: string, waker: Waker, step: () => Promise<boolean>): Promise<never> {
    for (;;) {
      await waker.wait();
      try {
        while (!isQuietHours() && (await step())) {
          // 作業がある限り続ける
        }
      } catch (e) {
        log(`${name} lane error: ${errText(e)}`);
        await sleep(60_000);
        waker.wake(); // 少し待ってからもう一度見る
      }
    }
  }

  void lane("quick", quick, async () => {
    const job = await withRetry(() => jobs.claimJob([...QUICK_KINDS]), "claim job");
    if (!job) return false;
    await runQuickJob(job);
    return true;
  });
  void lane("analysis", analysis, async () => {
    const item = await withRetry(claimAnalysis, "claim analysis");
    if (!item) return false;
    await runAnalysis(item);
    return true;
  });

  // ---------------- 合図の見張り（Slack の連絡用スレッド） ----------------

  let board = await withRetry(() => jobs.getBoard(), "get board").catch(() => null);
  if (!board) log("連絡用スレッドがまだありません（mamo の起動時に作られます）。2時間ごとの確認で拾います");
  let lastSeen = String(Math.floor(Date.now() / 1000) - 24 * 3600);
  let lastSafety = Date.now();
  let wasQuiet = isQuietHours();
  let offlineSince: number | null = null;

  for (;;) {
    try {
      const quiet = isQuietHours();
      if (wasQuiet && !quiet) wakeAll(); // 朝7時に、夜のあいだ溜まった作業を始める
      wasQuiet = quiet;

      if (Date.now() - lastSafety > SAFETY_CHECK_MS) {
        lastSafety = Date.now();
        if (!board) board = await jobs.getBoard().catch(() => null);
        if (!quiet) wakeAll();
      }

      if (board) {
        const res = await slack.conversations.replies({
          channel: board.channel,
          ts: board.ts,
          oldest: lastSeen,
          limit: 100,
        });
        const signals = (res.messages || []).filter(
          (m) => m.ts && m.ts !== board!.ts && Number(m.ts) > Number(lastSeen),
        );
        if (signals.length > 0) {
          lastSeen = signals.map((m) => m.ts as string).sort().slice(-1)[0];
          if (!quiet) wakeAll();
          for (const m of signals) {
            await slack.chat.delete({ channel: board.channel, ts: m.ts as string }).catch(() => {});
          }
        }
      }

      if (offlineSince) {
        log(`ネットワーク復旧（${Math.round((Date.now() - offlineSince) / 60000)}分間つながりませんでした）`);
        offlineSince = null;
        wakeAll(); // つながらない間に入った作業を拾う
      }
    } catch (e) {
      if (isNetworkError(e)) {
        if (!offlineSince) {
          offlineSince = Date.now();
          log("ネットワークにつながらないため待機します（スリープ復帰直後など）");
        }
      } else {
        log(`signal watch error: ${errText(e)}`);
      }
    }
    await sleep(SIGNAL_POLL_MS);
  }
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.stack || e.message : String(e)}`);
  process.exit(1);
});
