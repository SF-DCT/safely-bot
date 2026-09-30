// 業務の受付箱（Work Inbox）worker — 高橋さんのPCで常駐する
//
// mamo（Railway）が work_items.status='queued' にした依頼を1件ずつ取り出し、
// このPCの Claude Code（claude -p）に分析・整理させて、結果を高橋さんのDMに返す。
//
// 起動: Corporate/mamo_project で `node worker/work-runner.mjs`（--once で1件だけ処理して終了）
// 常駐: スタートアップの worker/start-hidden.vbs から起動（README.md 参照）
//
// 秘密情報の扱い:
// - DATABASE_URL と SLACK_BOT_TOKEN は起動時に `railway variables` からメモリにだけ読む（ファイルに書かない）
// - Claude Code には渡さない（子プロセスの環境変数は、このPCの元の環境のまま）

import { neon } from "@neondatabase/serverless";
import { WebClient } from "@slack/web-api";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAMO_DIR = path.resolve(HERE, "..");
const WORKSPACE = path.resolve(MAMO_DIR, "..", ".."); // My project
const OUT_REL = "Private/mamo-work";
const OUT_DIR = path.join(WORKSPACE, OUT_REL);
const LOG_FILE = path.join(OUT_DIR, "_worker.log");
const LOCK_FILE = path.join(os.tmpdir(), "mamo-work-runner.lock");

const POLL_MS = 60_000;
const JOB_TIMEOUT_MS = 40 * 60_000;
const CLAUDE_BIN =
  process.env.CLAUDE_BIN ||
  path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
const ONCE = process.argv.includes("--once");
const SLACK_USER_ID = "U01T29EAGDB"; // 高橋幹佳

// 分析用の Claude Code に使わせない操作（送信・書き込み・公開・デプロイ）。
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

// ------------------------------------------------------------

fs.mkdirSync(OUT_DIR, { recursive: true });

function log(...args) {
  const line = `[${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}] ${args.join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // ログ書き込みの失敗は処理を止めない
  }
}

function jstHour() {
  return Number(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hour12: false }),
  ) % 24;
}

/** 22時〜翌7時は新しい作業を始めない（結果のDMが夜中に届かないように） */
function isQuietHours() {
  const h = jstHour();
  return h >= 22 || h < 7;
}

function acquireLock() {
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

function releaseLock() {
  try {
    if (Number(fs.readFileSync(LOCK_FILE, "utf8")) === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch {
    // ignore
  }
}

function loadSecrets() {
  // Windows の railway は npm のシム（railway.cmd）なので cmd 経由で呼ぶ
  const [cmd, args] =
    process.platform === "win32"
      ? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "railway", "variables", "--service", "safely-bot", "--json"]]
      : ["railway", ["variables", "--service", "safely-bot", "--json"]];
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd: MAMO_DIR, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error(`railway variables に失敗: ${err.message}`));
        try {
          const vars = JSON.parse(stdout);
          if (!vars.DATABASE_URL || !vars.SLACK_BOT_TOKEN) {
            return reject(new Error("DATABASE_URL / SLACK_BOT_TOKEN が取得できません"));
          }
          resolve({ databaseUrl: vars.DATABASE_URL, botToken: vars.SLACK_BOT_TOKEN });
        } catch (e) {
          reject(new Error(`railway variables の出力を読めません: ${e.message}`));
        }
      },
    );
  });
}

// ------------------------------------------------------------

async function claimJob(sql) {
  const rows = await sql`
    UPDATE work_items
    SET status = 'running', started_at = NOW(), updated_at = NOW()
    WHERE id = (
      SELECT id FROM work_items WHERE status = 'queued'
      ORDER BY updated_at LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `;
  return rows[0] || null;
}

function reportRelPath(item) {
  if (item.report_path) return item.report_path;
  const d = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
  const slug = String(item.id).replace(/[^A-Za-z0-9]+/g, "-");
  return `${OUT_REL}/${d}-${slug}.md`;
}

function buildPrompt(item, reportRel) {
  const where = item.is_dm ? "DM" : `#${item.channel_name}`;
  const prev = item.result_json
    ? `\n## 前回の結果（これを踏まえて更新する）\n- 報告ファイル: ${reportRel}\n- 事実: ${item.result_json.facts}\n- 見立て: ${item.result_json.assessment}\n`
    : "";
  const instruction = item.instruction
    ? `\n## 高橋さんからの追加指示（最優先）\n${item.instruction}\n`
    : "";

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

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      "auto",
      "--no-session-persistence",
      "--disallowedTools",
      ...DISALLOWED_TOOLS,
    ];
    const child = spawn(CLAUDE_BIN, args, {
      cwd: WORKSPACE,
      env: process.env, // このPCの元の環境のまま（mamo の秘密情報は含まない）
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    const timer = setTimeout(() => {
      log(`timeout: pid=${child.pid} を停止します`);
      if (process.platform === "win32") {
        execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
      } else {
        child.kill("SIGKILL");
      }
    }, JOB_TIMEOUT_MS);

    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!stdout.trim()) {
        return reject(new Error(`Claude Code が出力なしで終了しました（code=${code}）${stderr ? `: ${stderr.slice(0, 300)}` : ""}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Claude Code の出力を読めません: ${stdout.slice(0, 300)}`));
      }
    });
    child.stdin.end(prompt);
  });
}

function parseResult(text, item) {
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

function clip(text, n = 2900) {
  const s = String(text || "").trim() || "—";
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function resultBlocks(item, result, reportRel, minutes) {
  const where = item.is_dm ? "DM" : `#${item.channel_name}`;
  const link = item.permalink ? ` <${item.permalink}|スレッドを開く>` : "";
  return [
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
          text: `詳細: \`${reportRel}\` ｜ 所要 ${minutes}分${result.limitations ? ` ｜ 限界: ${clip(result.limitations, 400)}` : ""}`,
        },
      ],
    },
    {
      type: "actions",
      block_id: `work_result_actions_${item.id}`,
      elements: [
        { type: "button", text: { type: "plain_text", text: "📝 返信の下書き" }, action_id: "work_draft", value: item.id, style: "primary" },
        { type: "button", text: { type: "plain_text", text: "🔁 指示を足してやり直す" }, action_id: "work_reinstruct", value: item.id },
        { type: "button", text: { type: "plain_text", text: "✅ 完了にする" }, action_id: "work_close", value: item.id },
      ],
    },
  ];
}

function failureBlocks(item, message) {
  const where = item.is_dm ? "DM" : `#${item.channel_name}`;
  return [
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
        { type: "button", text: { type: "plain_text", text: "🔁 もう一度" }, action_id: "work_retry", value: item.id },
        { type: "button", text: { type: "plain_text", text: "🔁 指示を足してやり直す" }, action_id: "work_reinstruct", value: item.id },
        { type: "button", text: { type: "plain_text", text: "✅ 対応済み" }, action_id: "work_close", value: item.id },
      ],
    },
  ];
}

async function openDm(slack) {
  const dm = await slack.conversations.open({ users: SLACK_USER_ID });
  return dm.channel.id;
}

async function processJob(sql, slack, item) {
  const reportRel = reportRelPath(item);
  const started = Date.now();
  log(`start ${item.id}: ${item.summary}`);

  try {
    const out = await runClaude(buildPrompt(item, reportRel));
    if (out.is_error || out.subtype !== "success") {
      throw new Error(`Claude Code がエラーで終了しました（${out.subtype || "unknown"}）: ${String(out.result || "").slice(0, 300)}`);
    }
    const result = parseResult(out.result, item);
    const minutes = Math.max(1, Math.round((Date.now() - started) / 60000));
    const reportExists = fs.existsSync(path.join(WORKSPACE, reportRel));

    const channel = await openDm(slack);
    const posted = await slack.chat.postMessage({
      channel,
      text: `📊 分析できました：${result.title}`,
      blocks: resultBlocks(item, result, reportExists ? reportRel : "（報告ファイルなし）", minutes),
    });
    await sql`
      UPDATE work_items
      SET status = 'done', result_json = ${JSON.stringify(result)}::jsonb,
          report_path = ${reportExists ? reportRel : null}, result_ts = ${posted.ts || null},
          finished_at = NOW(), last_error = NULL, updated_at = NOW()
      WHERE id = ${item.id}
    `;
    log(`done ${item.id} (${minutes}min, cost=${out.total_cost_usd ?? "?"})`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(`failed ${item.id}: ${message}`);
    await sql`
      UPDATE work_items SET status = 'failed', last_error = ${message}, finished_at = NOW(), updated_at = NOW()
      WHERE id = ${item.id}
    `;
    try {
      const channel = await openDm(slack);
      await slack.chat.postMessage({
        channel,
        text: "⚠️ 分析を完了できませんでした",
        blocks: failureBlocks(item, message),
      });
    } catch (e2) {
      log(`failure notice error: ${e2 instanceof Error ? e2.message : String(e2)}`);
    }
  }
}

async function main() {
  if (!acquireLock()) {
    log("別の worker が動いているため終了します");
    return;
  }
  process.on("exit", releaseLock);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  let secrets = await loadSecrets();
  let sql = neon(secrets.databaseUrl);
  let slack = new WebClient(secrets.botToken);
  log(`worker started (pid=${process.pid}, workspace=${WORKSPACE})`);

  for (;;) {
    try {
      if (!isQuietHours()) {
        const item = await claimJob(sql);
        if (item) {
          await processJob(sql, slack, item);
          if (ONCE) break;
          continue; // 続けて次の依頼を見る
        }
      }
      if (ONCE) {
        log("作業待ちの依頼はありません");
        break;
      }
    } catch (e) {
      log(`loop error: ${e instanceof Error ? e.message : String(e)}`);
      try {
        secrets = await loadSecrets(); // 接続情報が変わった可能性に備えて読み直す
        sql = neon(secrets.databaseUrl);
        slack = new WebClient(secrets.botToken);
      } catch (e2) {
        log(`secrets reload error: ${e2 instanceof Error ? e2.message : String(e2)}`);
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.stack || e.message : String(e)}`);
  process.exit(1);
});
