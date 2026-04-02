import { getClaudeClient } from "../utils/claude-client.js";
import type { DailyReportData } from "./data-collector.js";

const REPORT_SYSTEM_PROMPT = `あなたはSAFELYの日報作成アシスタントです。
収集されたデータから、以下のフォーマットに沿って日報ドラフトを生成してください。
ドラフト本文のみを出力し、前置きや説明は不要です。

## フォーマット（必ずこの順序・見出しで出力）

**■ 前日設定したTRY**
（前日日報の「今後行う業務」から転記）

**■ 本日行った業務**
**【MTG】**
- （会議名・内容）
**【IS】**
- （Integration Service関連業務。「広告費確認・キャンペーン精査」は定常的に含める）
**【SF】**
- （セーフリーメディア関連業務）
**【TC】**
- （水道修理のセーフリー関連業務。「GA4確認」「コミットメントタスクの進行」は定常的に含める）
**【Another】**
- （その他業務）
**【Routine】**
- （定常業務）

**■ 本日の業務での不足／不足を埋めるための行動**
（課題・遅れが発生しているもの）

**■ 上司からのFBで得た気付き／ネクストアクション**
（岡野社長からのフィードバック・情報発信からの気付き）

**■ 気付いたこと／良かったこと／継続していきたいこと**
（今日の達成・成功体験）

**■ 今後行う業務**
（翌日のタスク・予定）

**■ その他**
（特になければ「特になし」）

## ルール
- 情報が足りない部分は【要記入】と明示する
- 曜日は半角カッコ+漢字: 4月1日(火) — 環境依存文字（㊋等）は不可
- Slack太字は **テキスト**（ダブルアスタリスク）
- 各セクション見出しの前に空行を入れる
- 岡野社長の名前は書かない（日報を本人が読むため不要）
- 推測で書ける部分は書くが、確証がない内容は【要記入】にする`;

/**
 * 収集データから日報ドラフトを生成
 */
export async function generateDailyReportDraft(
  data: DailyReportData,
): Promise<string> {
  const client = getClaudeClient();

  let prompt = `今日は${data.date}です。以下のデータから日報ドラフトを作成してください。\n\n`;

  if (data.previousReportTry) {
    prompt += `## 前日の「今後行う業務」（= 今日のTRY）\n${data.previousReportTry}\n\n`;
  } else {
    prompt += `## 前日の「今後行う業務」\n取得できませんでした。【要記入】としてください。\n\n`;
  }

  if (data.selfDmMemos.length > 0) {
    prompt += `## 自分宛DMメモ（今日分）\n${data.selfDmMemos.map((m, i) => `${i + 1}. ${m}`).join("\n")}\n\n`;
  }

  if (data.ceoMessages.length > 0) {
    prompt += `## 岡野社長の発信（今日分）\n${data.ceoMessages.join("\n")}\n\n`;
  }

  if (
    !data.previousReportTry &&
    data.selfDmMemos.length === 0 &&
    data.ceoMessages.length === 0
  ) {
    prompt +=
      "※ 自動収集できたデータが限られています。各セクションで【要記入】を多めに設定し、ユーザーが加筆しやすいようにしてください。\n\n";
  }

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    system: REPORT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  });

  return response.content
    .filter((b) => b.type === "text")
    .map((b) => ("text" in b ? b.text : ""))
    .join("\n");
}

/**
 * 修正指示を反映してドラフトを再生成
 */
export async function reviseDailyReportDraft(
  currentDraft: string,
  userFeedback: string,
): Promise<string> {
  const client = getClaudeClient();

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    system: REPORT_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `以下の日報ドラフトに対して修正指示がありました。指示を反映した修正版を出力してください。\n\n## 現在のドラフト\n${currentDraft}\n\n## 修正指示\n${userFeedback}`,
      },
    ],
  });

  return response.content
    .filter((b) => b.type === "text")
    .map((b) => ("text" in b ? b.text : ""))
    .join("\n");
}
