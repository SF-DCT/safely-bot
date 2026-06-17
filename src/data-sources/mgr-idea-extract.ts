import { Client } from "@notionhq/client";
import { env } from "../config/env.js";
import { getClaudeClient } from "../utils/claude-client.js";
import { readRange } from "./google-sheets.js";

/**
 * MGR Weekly MTG ページの「3.アイディアから吸い上げ」欄を、
 * 各メンバーの日報シートH列(アイデアシンキング)からSF関連のみ抽出して埋める。
 *
 * 毎週金曜 14:00 JST に scheduler/mgr-idea-extract.ts から呼ばれる。
 */

const PARENT_PAGE_ID = "33a0bcb6bd1080de80a0ca177138ca01"; // 2026年度

// 抽出対象メンバー
// format: "form" は Google フォーム回答シート（A=日付/H=アイディア/K=タイムスタンプ）
// format: "freeform" は自由記述シート（タブ別・列構造別。member.range / member.ideaCol / member.dateCol を使う）
type MemberFormat = "form" | "freeform";

interface Member {
  name: string;
  sheetId: string;
  format?: MemberFormat; // 省略時は "form"
  // freeform 専用
  range?: string;          // 例: "有泉!A2:E"
  dateColIdx?: number;     // 0始まり 例: 0
  ideaColIdx?: number;     // 0始まり 例: 2
}

const MEMBERS: Member[] = [
  { name: "吉井郁哉", sheetId: "1AQSP0P1zcbMozGKnvvfLRKkPeoS17nCLJgGLpQLVagU" },
  { name: "野室和佳子", sheetId: "17gW4_NsrF3loutiszMpvlMXTGkJe_po7PcKEK4IcMoU" },
  { name: "長嶺義博", sheetId: "1D1R5yG4UTtc5P_syxUlu1I_gIDTyC7H5ZG5QqfUBvao" },
  { name: "中岡正年", sheetId: "1jYELDh80gM09zhm7HAyCv8MHJ8skMuzZNbuDw_vbTxQ" },
  { name: "長澤裕輔", sheetId: "1Bdpaxva1cDSm-bGaTaYn6KWZVqBottINfjpA4GzqLpI" },
  { name: "久保木彩子", sheetId: "1Fm9qdyOUPHBMj8BxJRHjcA-C5T-dSO0RVjbj8uT6IxQ" },
  { name: "宮一優希", sheetId: "1MFeUJ58xwyQlKJiCzupAUEYAQBIyP3lVWPJfXfblmqg" },
  { name: "目黒真弓", sheetId: "1zyQVDAejIpePO8W2trR0lm_Kz-3DpkXgOjo_pjv6qF0" },
  { name: "関谷柚季", sheetId: "1VgpqQuB6PB5B-JHsWkgvokGG_av_pw83dGAinDhJAEg" },
  { name: "藤井樹", sheetId: "11fxmtIPdum_tZBSiMZ_E3RAJwdJ-3LO680FOVGZInbo" },
  { name: "柿沼佑", sheetId: "1fcDazQEQbBlNHezlQef7N-Vy12KGDVfK8G5ZpdNxBJ0" },
  { name: "小山和気", sheetId: "14Z9WASo5WvLyHuyyiJFFbfcS_BUwl84lNj5st9tWeTs" },
  { name: "倉本桃花", sheetId: "1EYSvnIysqAUnZW_WujRlWskfodUooWDz_MU6PQYIzvw" },
  { name: "小野寺真依", sheetId: "1YaLM63WQlsRgqKgVJsJSOaFt-60oejgkefhwQqHuT0U" },
  { name: "会嶋翔", sheetId: "1fPRnM43EOlv7N_s4eF4VQjkcJpK8FWhFtP0YJs_1gv4" },
  { name: "三浦良太", sheetId: "1yVdCV6poVIcYSeNfbnKD56mXfXMQuJYsVTPLnyhQKfM" },
  { name: "芳賀ひかり", sheetId: "1yPXE-OTrVy_SImQMUTpOvgOPPrtFip76k2WM94q8Tog" },
  { name: "森亜弥", sheetId: "11klaqmBX-TOJdykIAxdPuo-z2tVjz9eViZmi0ku64wo" }, // 旧姓: 田尾亜弥 / メール tao@safely.co.jp は変更なし
  {
    name: "有泉",
    sheetId: "1fasQEQUuNQyXH46lpwGK0d47fWCdT4McQ-z76reK_fQ",
    format: "freeform",
    range: "有泉!A2:E2000",
    dateColIdx: 0,
    ideaColIdx: 2,
  },
];

const SHEET_RANGE = "フォーム形式の回答!A1:K";

interface RawIdea {
  member: string;
  date: string; // YYYY/MM/DD
  idea: string;
}

interface SfIdea {
  member: string;
  date: string;
  headline: string;
  summary: string;
}

interface ExtractResult {
  targetPageId: string;
  targetPageTitle: string;
  targetPageUrl: string;
  rangeFrom: string; // YYYY/MM/DD
  rangeTo: string;
  totalRawIdeas: number;
  sfIdeas: SfIdea[];
  membersWithIdeas: string[];
  membersWithoutIdeas: string[];
  membersWithFetchError: string[];
  notionWriteStatus: "success" | "skipped_no_api_key" | "failed";
  notionWriteError?: string;
}

function getNotionClient(): Client | null {
  if (!env.NOTION_API_KEY) return null;
  return new Client({ auth: env.NOTION_API_KEY });
}

/** JST 日付文字列 (YYYY-MM-DD) を取得 */
function todayJst(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().slice(0, 10);
}

function parseYmd(s: string): Date {
  // "YYYY-MM-DD" or "YYYY/MM/DD"
  const norm = s.replace(/\//g, "-");
  return new Date(`${norm}T00:00:00Z`);
}

function fmtYmdSlash(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

function dayOfWeekJa(d: Date): string {
  const days = ["日", "月", "火", "水", "木", "金", "土"];
  return days[d.getUTCDay()];
}

/**
 * 親ページ「2026年度」配下の "MGR Weekly MTG_YYYYMMDD" 子ページを列挙し、
 * 日付昇順で返す。
 */
async function listMgrPages(): Promise<
  { id: string; title: string; date: string; url: string }[]
> {
  const notion = getNotionClient();
  if (!notion) {
    throw new Error("NOTION_API_KEY is not set");
  }
  const results: { id: string; title: string; date: string; url: string }[] =
    [];
  let cursor: string | undefined = undefined;

  do {
    const res = await notion.blocks.children.list({
      block_id: PARENT_PAGE_ID,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const block of res.results) {
      if ("type" in block && block.type === "child_page") {
        const title = block.child_page.title;
        const m = title.match(/^MGR Weekly MTG_(\d{8})$/);
        if (m) {
          const ymd = m[1];
          results.push({
            id: block.id,
            title,
            date: ymd,
            url: `https://www.notion.so/${block.id.replace(/-/g, "")}`,
          });
        }
      }
    }

    cursor = res.next_cursor || undefined;
  } while (cursor);

  results.sort((a, b) => a.date.localeCompare(b.date));
  return results;
}

/**
 * "M/D" / "MM/DD" / "YYYY/MM/DD" / "YYYY-MM-DD" を Date に変換。
 * 年が省略されている場合は referenceDate の年を採用し、結果が referenceDate より未来になる場合は前年扱い。
 */
function parseFreeformDate(s: string, referenceDate: Date): Date | null {
  const trimmed = s.trim();
  if (!trimmed) return null;

  // YYYY/MM/DD or YYYY-MM-DD
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(trimmed)) {
    const d = parseYmd(trimmed.split(/[ T]/)[0]);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // M/D (年省略)
  const m = trimmed.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  const month = parseInt(m[1], 10);
  const day = parseInt(m[2], 10);
  let year = referenceDate.getUTCFullYear();
  let candidate = new Date(Date.UTC(year, month - 1, day));
  // 未来日になったら前年扱い（年初の年またぎ対策）
  if (candidate.getTime() > referenceDate.getTime() + 24 * 3600 * 1000) {
    year -= 1;
    candidate = new Date(Date.UTC(year, month - 1, day));
  }
  return candidate;
}

/**
 * Googleフォーム回答シート（A=日付/H=アイディア/K=タイムスタンプ）からアイディアを取得。
 */
async function fetchFormMemberIdeas(
  member: Member,
  fromDate: Date,
  toDate: Date,
): Promise<RawIdea[]> {
  const rows = await readRange(member.sheetId, SHEET_RANGE);
  if (rows.length <= 1) return [];

  const ideas: RawIdea[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const idea = row[7] || ""; // H列
    const tsStr = row[10] || ""; // K列 タイムスタンプ "YYYY/MM/DD HH:MM:SS"

    if (!idea.trim()) continue;
    if (!tsStr) continue;

    const tsDate = tsStr.split(" ")[0];
    const ts = parseYmd(tsDate);
    if (Number.isNaN(ts.getTime())) continue;

    if (ts.getTime() < fromDate.getTime()) continue;
    if (ts.getTime() > toDate.getTime()) continue;

    ideas.push({
      member: member.name,
      date: tsDate,
      idea: idea.trim(),
    });
  }

  return ideas;
}

/**
 * 自由記述シート（A=日付 "M/D"、C=案 等、メンバーごとに列指定）からアイディアを取得。
 */
async function fetchFreeformMemberIdeas(
  member: Member,
  fromDate: Date,
  toDate: Date,
): Promise<RawIdea[]> {
  if (
    !member.range ||
    member.dateColIdx === undefined ||
    member.ideaColIdx === undefined
  ) {
    throw new Error(
      `Freeform member ${member.name} missing range/dateColIdx/ideaColIdx`,
    );
  }
  const rows = await readRange(member.sheetId, member.range);
  if (rows.length === 0) return [];

  const ideas: RawIdea[] = [];
  for (const row of rows) {
    const dateStr = row[member.dateColIdx] || "";
    const idea = row[member.ideaColIdx] || "";
    if (!idea.trim()) continue;
    if (!dateStr.trim()) continue;

    const d = parseFreeformDate(dateStr, toDate);
    if (!d) continue;
    if (d.getTime() < fromDate.getTime()) continue;
    if (d.getTime() > toDate.getTime()) continue;

    ideas.push({
      member: member.name,
      date: fmtYmdSlash(d),
      idea: idea.trim(),
    });
  }
  return ideas;
}

/**
 * 指定メンバーの from(inclusive) 〜 to(inclusive) 範囲のアイディアを取得。
 * シート構造ごとに分岐。
 */
async function fetchMemberIdeas(
  member: Member,
  fromDate: Date,
  toDate: Date,
): Promise<RawIdea[]> {
  if (member.format === "freeform") {
    return fetchFreeformMemberIdeas(member, fromDate, toDate);
  }
  return fetchFormMemberIdeas(member, fromDate, toDate);
}

/**
 * Claude API を使って SF 関連アイディアのみを仕分けし、見出し+要約に整形する。
 * SF判定の広めの基準:
 * - 明示的に「SF / SAFELY / セーフリー」を含む
 * - SF媒体機能(メンバーページ/コンシェルジュ/事業者紹介/アプリ/二次検索/トレーダーページ/X施策/診断テスト/業者カード等)を含む
 * - 他PF専有(TC/SKH/SKT/ISMS/ES/OL/ISCB/ISCL/ISWC等のみへの言及)は除外
 */
async function filterSfIdeas(rawIdeas: RawIdea[]): Promise<SfIdea[]> {
  if (rawIdeas.length === 0) return [];

  const claude = getClaudeClient();

  const systemPrompt = `あなたは株式会社SAFELYの事業アシスタントです。各メンバーの日報「アイデアシンキング」欄から、SAFELYメディア(SF)に関連するアイディアのみを抽出します。

判定基準:
- SF判定する: 「SF / SAFELY / セーフリー」明示、または SF媒体機能(メンバーページ・コンシェルジュ・事業者紹介・アプリ・二次検索・トレーダーページ・X施策・診断テスト・業者カード・toB営業・リード獲得 等) への言及がある
- SF判定しない: 他PF専有(TC/SKH/SKT/SKHH/ISMS/ES/OL/ISCB/ISCL/ISWC等のみ)、社内ツール/業務効率化のみ、内部MTG運営のみ
- 複数PF言及で SF を含む場合は SF として採用

出力は JSON 配列のみ。各要素:
{
  "index": 入力配列のindex(0始まり),
  "is_sf": true|false,
  "headline": "20文字以内の見出し",
  "summary": "1〜2行で要点を要約(100文字目安)"
}

is_sf=false の要素は出力に含めない。`;

  const userPrompt = `以下の生アイディアからSF関連のみを抽出・整形してください。

入力:
${JSON.stringify(
  rawIdeas.map((r, i) => ({ index: i, member: r.member, date: r.date, idea: r.idea })),
  null,
  2,
)}

JSONのみ出力(配列):`;

  const response = await claude.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const text = textBlock?.type === "text" ? textBlock.text : "";

  // JSON 配列を抽出
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.warn("[MGR Idea Extract] Claude response had no JSON array");
    return [];
  }

  let parsed: { index: number; is_sf: boolean; headline: string; summary: string }[];
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error("[MGR Idea Extract] Failed to parse Claude JSON:", e);
    return [];
  }

  const sfIdeas: SfIdea[] = [];
  for (const item of parsed) {
    if (!item.is_sf) continue;
    const raw = rawIdeas[item.index];
    if (!raw) continue;
    sfIdeas.push({
      member: raw.member,
      date: raw.date,
      headline: item.headline || "",
      summary: item.summary || "",
    });
  }

  return sfIdeas;
}

/**
 * 抽出結果から Notion ブロック配列を組み立てる。
 */
function buildNotionBlocks(result: ExtractResult): unknown[] {
  const blocks: unknown[] = [];

  // ヘッダー callout
  const fromD = parseYmd(result.rangeFrom);
  const toD = parseYmd(result.rangeTo);
  const fromLabel = `${result.rangeFrom}(${dayOfWeekJa(fromD)})`;
  const toLabel = `${result.rangeTo}(${dayOfWeekJa(toD)})`;
  const memberCount = MEMBERS.length;

  blocks.push({
    object: "block",
    type: "callout",
    callout: {
      icon: { type: "emoji", emoji: "📥" },
      color: "yellow_background",
      rich_text: [
        {
          type: "text",
          text: {
            content: `抽出期間: ${fromLabel}〜${toLabel}　／　対象: 各メンバー日報「アイデアシンキング（5分）」欄からSF関連のみ抽出\n抽出範囲: ${memberCount}名分\nSF関連: ${result.sfIdeas.length}件 / 生アイディア: ${result.totalRawIdeas}件`,
          },
        },
      ],
    },
  });

  // メンバーごとに heading + bulleted list
  const byMember = new Map<string, SfIdea[]>();
  for (const idea of result.sfIdeas) {
    if (!byMember.has(idea.member)) byMember.set(idea.member, []);
    byMember.get(idea.member)!.push(idea);
  }

  // MEMBERS の順序で出力
  for (const m of MEMBERS) {
    const ideas = byMember.get(m.name);
    if (!ideas || ideas.length === 0) continue;

    blocks.push({
      object: "block",
      type: "heading_3",
      heading_3: {
        rich_text: [{ type: "text", text: { content: m.name } }],
      },
    });

    for (const idea of ideas) {
      const mmdd = idea.date.slice(5).replace("/", "/"); // MM/DD
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: [
            {
              type: "text",
              text: { content: `${mmdd} ${idea.headline}` },
              annotations: { bold: true },
            },
            {
              type: "text",
              text: { content: `\n${idea.summary}` },
            },
          ],
        },
      });
    }
  }

  // フッター: SFアイディア無しメンバー
  if (result.membersWithoutIdeas.length > 0) {
    blocks.push({
      object: "block",
      type: "callout",
      callout: {
        icon: { type: "emoji", emoji: "ℹ️" },
        color: "gray_background",
        rich_text: [
          {
            type: "text",
            text: {
              content: `今回のSFアイディア無し: ${result.membersWithoutIdeas.join(" / ")}（アイディア欄が空、または他PF専有のアイディア）`,
            },
          },
        ],
      },
    });
  }

  // フッター: 取得エラー
  if (result.membersWithFetchError.length > 0) {
    blocks.push({
      object: "block",
      type: "callout",
      callout: {
        icon: { type: "emoji", emoji: "⚠️" },
        color: "red_background",
        rich_text: [
          {
            type: "text",
            text: {
              content: `取得エラー: ${result.membersWithFetchError.join(" / ")}（権限/シート名/列構造を確認してください）`,
            },
          },
        ],
      },
    });
  }

  return blocks;
}

/**
 * MGRページの「3.アイディアから吸い上げ」セクションの中身を、
 * 「## 4. ナレッジシェア」の直前まで全削除し、新ブロック群を挿入する。
 */
async function replaceSection3(
  pageId: string,
  newBlocks: unknown[],
): Promise<void> {
  const notion = getNotionClient();
  if (!notion) {
    throw new Error("NOTION_API_KEY is not set");
  }

  // すべてのトップレベルブロックを取得
  const allBlocks: { id: string; type: string; raw: unknown }[] = [];
  let cursor: string | undefined = undefined;
  do {
    const res = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const b of res.results) {
      if ("type" in b && "id" in b) {
        allBlocks.push({ id: b.id, type: b.type, raw: b });
      }
    }
    cursor = res.next_cursor || undefined;
  } while (cursor);

  // セクション3 / セクション4 の heading_2 を特定
  const isHeading = (b: { type: string; raw: unknown }, contains: string): boolean => {
    if (b.type !== "heading_2") return false;
    const r = b.raw as {
      heading_2?: { rich_text?: { plain_text?: string }[] };
    };
    const rts = r.heading_2?.rich_text || [];
    const text = rts.map((t) => t.plain_text || "").join("");
    return text.includes(contains);
  };

  const idx3 = allBlocks.findIndex((b) =>
    isHeading(b, "3.アイディアから吸い上げ"),
  );
  const idx4 = allBlocks.findIndex((b) => isHeading(b, "4. ナレッジシェア"));

  if (idx3 < 0) {
    throw new Error(
      "Section heading '## 3.アイディアから吸い上げ' not found on page",
    );
  }
  if (idx4 < 0) {
    throw new Error("Section heading '## 4. ナレッジシェア' not found on page");
  }
  if (idx4 <= idx3) {
    throw new Error("Section ordering invalid (idx4 <= idx3)");
  }

  // 間のブロックを削除
  const toDelete = allBlocks.slice(idx3 + 1, idx4);
  for (const b of toDelete) {
    try {
      await notion.blocks.delete({ block_id: b.id });
    } catch (e) {
      console.warn(`[MGR Idea Extract] Failed to delete block ${b.id}:`, e);
    }
  }

  // セクション3 heading の直後に新ブロック群を挿入
  // Notion API は append + after で指定位置挿入をサポート
  const headingId = allBlocks[idx3].id;
  await notion.blocks.children.append({
    block_id: pageId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    children: newBlocks as any,
    after: headingId,
  });
}

/**
 * 金曜抽出のメインエントリ。
 *
 * Notion API キーが未設定でも処理は走る（抽出だけ実施し、書き込みはスキップ）。
 * Slackへの通知は呼び出し側で実施。
 *
 * options で fromDate / toDate を明示すると、Notion ページ参照なしで任意期間を抽出できる
 * (アドホックな過去分取り直しに使う)。
 */
export async function extractWeeklyMgrIdeas(options?: {
  fromDate?: Date;
  toDate?: Date;
  skipNotionWrite?: boolean;
}): Promise<ExtractResult> {
  const hasNotion = !!env.NOTION_API_KEY;
  const skipNotionWrite = options?.skipNotionWrite === true;

  // 1. MGR ページ一覧取得（Notion接続あれば）
  let latestPage: { id: string; title: string; date: string; url: string } | null =
    null;
  let priorPage: { id: string; title: string; date: string; url: string } | null =
    null;

  if (hasNotion) {
    const pages = await listMgrPages();
    if (pages.length === 0) {
      throw new Error("No MGR Weekly MTG pages found under 2026年度");
    }
    latestPage = pages[pages.length - 1];
    priorPage = pages.length >= 2 ? pages[pages.length - 2] : null;
  }

  // 2. 抽出範囲: options 優先 → 前回MTG翌日 〜 今日 → 過去7日 の順
  const today = options?.toDate ?? parseYmd(todayJst());
  let fromDate: Date;
  if (options?.fromDate) {
    fromDate = options.fromDate;
  } else if (priorPage) {
    const priorDate = parseYmd(
      `${priorPage.date.slice(0, 4)}-${priorPage.date.slice(4, 6)}-${priorPage.date.slice(6, 8)}`,
    );
    fromDate = new Date(priorDate.getTime() + 24 * 3600 * 1000);
  } else {
    fromDate = new Date(today.getTime() - 7 * 24 * 3600 * 1000);
  }

  // 3. 各メンバーの日報からH列を取得
  const allRawIdeas: RawIdea[] = [];
  const membersWithFetchError: string[] = [];
  const membersWithRawIdeas = new Set<string>();

  for (const member of MEMBERS) {
    try {
      const ideas = await fetchMemberIdeas(member, fromDate, today);
      if (ideas.length > 0) membersWithRawIdeas.add(member.name);
      allRawIdeas.push(...ideas);
    } catch (e) {
      console.error(`[MGR Idea Extract] Fetch error for ${member.name}:`, e);
      membersWithFetchError.push(member.name);
    }
  }

  // 4. SF関連のみ抽出
  const sfIdeas = await filterSfIdeas(allRawIdeas);
  const membersWithSfIdeas = new Set(sfIdeas.map((i) => i.member));
  const membersWithoutSfIdeas = MEMBERS.map((m) => m.name).filter(
    (n) => !membersWithSfIdeas.has(n) && !membersWithFetchError.includes(n),
  );

  const result: ExtractResult = {
    targetPageId: latestPage?.id || "",
    targetPageTitle: latestPage?.title || "(Notion未連携)",
    targetPageUrl: latestPage?.url || "",
    rangeFrom: fmtYmdSlash(fromDate),
    rangeTo: fmtYmdSlash(today),
    totalRawIdeas: allRawIdeas.length,
    sfIdeas,
    membersWithIdeas: Array.from(membersWithSfIdeas),
    membersWithoutIdeas: membersWithoutSfIdeas,
    membersWithFetchError,
    notionWriteStatus: hasNotion ? "success" : "skipped_no_api_key",
  };

  // 5. Notion セクション3 を上書き（接続あれば、かつ skipNotionWrite が false）
  if (hasNotion && latestPage && !skipNotionWrite) {
    try {
      const blocks = buildNotionBlocks(result);
      await replaceSection3(latestPage.id, blocks);
      result.notionWriteStatus = "success";
    } catch (e) {
      console.error("[MGR Idea Extract] Notion write failed:", e);
      result.notionWriteStatus = "failed";
      result.notionWriteError = e instanceof Error ? e.message : String(e);
    }
  }

  return result;
}

/** ヘッダー（サマリ部分のみ）を Slack mrkdwn で整形 */
export function formatExtractSummaryForSlack(result: ExtractResult): string {
  const lines: string[] = [];
  lines.push("📥 *MGR金曜アイディア吸い上げ完了*");

  if (result.notionWriteStatus === "success" && result.targetPageUrl) {
    lines.push(`Notion: <${result.targetPageUrl}|${result.targetPageTitle}> に書き込み済み`);
  } else if (result.notionWriteStatus === "skipped_no_api_key") {
    lines.push(
      "Notion: _未連携のため書き込みスキップ_ → 下記内容を手動で「3.アイディアから吸い上げ」に転記してください",
    );
  } else if (result.notionWriteStatus === "failed") {
    lines.push(
      `⚠️ Notion書き込み失敗: \`${result.notionWriteError || "unknown"}\` → 下記内容を手動転記してください`,
    );
  }

  lines.push(`抽出期間: *${result.rangeFrom} 〜 ${result.rangeTo}*`);
  lines.push(
    `生アイディア *${result.totalRawIdeas}件* → SF関連 *${result.sfIdeas.length}件*`,
  );
  if (result.membersWithFetchError.length > 0) {
    lines.push(`⚠️ 取得エラー: ${result.membersWithFetchError.join(" / ")}`);
  }
  return lines.join("\n");
}

/** SFアイディア本体を Slack mrkdwn で整形（メンバー別） */
export function formatExtractDetailForSlack(result: ExtractResult): string {
  const lines: string[] = [];

  // メンバーごとにグループ化
  const byMember = new Map<string, SfIdea[]>();
  for (const idea of result.sfIdeas) {
    if (!byMember.has(idea.member)) byMember.set(idea.member, []);
    byMember.get(idea.member)!.push(idea);
  }

  // MEMBERS の順序で出力
  for (const m of MEMBERS) {
    const ideas = byMember.get(m.name);
    if (!ideas || ideas.length === 0) continue;

    lines.push(`\n*▼ ${m.name}*`);
    for (const idea of ideas) {
      const mmdd = idea.date.slice(5);
      lines.push(`• *${mmdd} ${idea.headline}*`);
      lines.push(`    ${idea.summary}`);
    }
  }

  // フッター
  if (result.membersWithoutIdeas.length > 0) {
    lines.push(
      `\n_今回SF無し:_ ${result.membersWithoutIdeas.join(" / ")}`,
    );
  }

  return lines.join("\n");
}

/** 旧API互換: サマリのみを返す */
export function formatExtractResultForSlack(result: ExtractResult): string {
  return formatExtractSummaryForSlack(result);
}
