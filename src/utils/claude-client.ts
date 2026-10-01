import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FriendlyClaudeError } from "./claude-errors.js";

// ============================================================
// Claude の呼び出し口
// 2026-10-01 から API キー（従量課金）は使わない方針。
// Claude を使う処理はすべて高橋さんのPCの worker（worker/work-runner.ts）で動かし、
// そこでは MAMO_LLM=cli として、このPCの Claude Code（サブスク）を claude -p で呼ぶ。
// Railway 上の mamo から呼ばれた場合は、課金を防ぐためにエラーにする。
// ============================================================

let client: Anthropic | null = null;

export function getClaudeClient(): Anthropic {
  if (!client) {
    if (process.env.MAMO_LLM !== "cli") {
      throw new FriendlyClaudeError(
        "mamo（Railway）からは Claude を呼びません（API課金を避けるため）。この処理は高橋さんのPCの worker で実行する必要があります。",
        "moved",
      );
    }
    client = createCliClient() as unknown as Anthropic;
  }
  return client;
}

// ------------------------------------------------------------
// Claude Code CLI（claude -p）を messages.create の形で呼ぶ薄いアダプター
// ------------------------------------------------------------

const CLAUDE_BIN =
  process.env.CLAUDE_BIN ||
  path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
const CLI_TIMEOUT_MS = 10 * 60_000;

// 子プロセスに渡さない環境変数（mamo の秘密情報・API キー。API キーがあると従量課金になる）
const SECRET_ENV = /^(SLACK_|ANTHROPIC_|GOOGLE_|GMAIL_|NOTION_|YOUTUBE_|SALESFORCE_|WP_|DATABASE_URL|GITHUB_TOKEN|ORBIT_|SCENARIO_|RAILWAY_|MAMO_)/;

let childEnvBase: NodeJS.ProcessEnv | null = null;

/** worker が秘密情報を読み込む前の環境を渡しておく（Claude Code にはこちらを使わせる） */
export function setCliChildEnv(base: NodeJS.ProcessEnv): void {
  childEnvBase = { ...base };
}

export function cliChildEnv(): NodeJS.ProcessEnv {
  const base = childEnvBase || process.env;
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (!SECRET_ENV.test(k)) out[k] = v;
  }
  return out;
}

/** CLAUDE.md やメモリを読み込まない、作業用の空ディレクトリ（軽い呼び出し用） */
function neutralDir(): string {
  const dir = path.join(os.tmpdir(), "mamo-llm");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

interface CliResult {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
}

/**
 * claude -p を1回実行して JSON の結果を返す。
 * mode="light": ツールなし・MCPなし・空ディレクトリ（仕分けや下書きなどの短い作業）
 * mode="workspace": ワークスペースで通常の Claude Code として動く（DMでの会話・分析）
 */
export function runClaudeCli(opts: {
  prompt: string;
  systemPrompt?: string;
  jsonSchema?: object;
  mode?: "light" | "workspace";
  cwd?: string;
  extraArgs?: string[];
  timeoutMs?: number;
}): Promise<CliResult> {
  const mode = opts.mode || "light";
  const args = ["-p", "--output-format", "json", "--no-session-persistence"];
  if (mode === "light") {
    args.push("--tools", "", "--strict-mcp-config");
  }
  if (opts.systemPrompt) args.push("--system-prompt", opts.systemPrompt);
  if (opts.jsonSchema) args.push("--json-schema", JSON.stringify(opts.jsonSchema));
  if (opts.extraArgs) args.push(...opts.extraArgs);

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd: opts.cwd || neutralDir(),
      env: cliChildEnv(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill("SIGKILL");
      }
    }, opts.timeoutMs || CLI_TIMEOUT_MS);

    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!stdout.trim()) {
        return reject(
          new Error(`Claude Code が出力なしで終了しました（code=${code}）${stderr ? `: ${stderr.slice(0, 300)}` : ""}`),
        );
      }
      let parsed: CliResult;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        return reject(new Error(`Claude Code の出力を読めません: ${stdout.slice(0, 300)}`));
      }
      const text = String(parsed.result || "");
      if (/session limit|weekly limit|usage limit/i.test(text) && parsed.is_error) {
        return reject(
          new FriendlyClaudeError(
            "Claude Code の利用枠（5時間ごと／週ごと）に達しました。枠が戻ると作業を再開します。",
            "rate",
          ),
        );
      }
      if (parsed.is_error || parsed.subtype !== "success") {
        return reject(new Error(`Claude Code がエラーで終了しました（${parsed.subtype || "unknown"}）: ${text.slice(0, 300)}`));
      }
      resolve(parsed);
    });
    child.stdin.end(opts.prompt);
  });
}

type CreateParams = {
  system?: string | { text?: string }[];
  messages: { role: "user" | "assistant"; content: unknown }[];
  output_config?: { format?: { schema?: object } };
};

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
      .join("\n");
  }
  return String(content ?? "");
}

function createCliClient() {
  return {
    messages: {
      async create(params: CreateParams): Promise<Anthropic.Message> {
        const system = Array.isArray(params.system)
          ? params.system.map((s) => s.text || "").join("\n")
          : params.system;
        // 1往復の呼び出しが前提。複数メッセージのときは会話を文字に起こして渡す
        const prompt =
          params.messages.length === 1
            ? contentToText(params.messages[0].content)
            : params.messages
                .map((m) => `${m.role === "user" ? "ユーザー" : "アシスタント"}: ${contentToText(m.content)}`)
                .join("\n\n");
        const schema = params.output_config?.format?.schema;
        const out = await runClaudeCli({ prompt, systemPrompt: system, jsonSchema: schema });
        const text =
          schema && out.structured_output !== undefined
            ? JSON.stringify(out.structured_output)
            : String(out.result || "");
        return {
          id: `cli_${Date.now()}`,
          type: "message",
          role: "assistant",
          model: "claude-code-cli",
          content: [{ type: "text", text, citations: null }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null },
        } as unknown as Anthropic.Message;
      },
    },
  };
}
