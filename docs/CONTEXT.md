# safely-bot プロジェクト — CONTEXT.md

> Claude Code用メモリファイル。2026/04/01 の claude.ai での議論を集約。
> このファイルをCLAUDE.mdから参照するか、プロジェクトルートに配置してください。

---

## プロジェクト概要

safely-botは、株式会社SAFELYのBGS事業部 GM 高橋幹佳の業務効率化を目的としたSlack AIアシスタント。
日報自動化から始まり、AI秘書（未対応サマリー・広告運用・メール・カレンダー・ナレッジ検索等）へ段階的に拡張する。
将来的には外部企業向けの「AI秘書構築・伴走支援サービス」として商品化を構想中。

---

## 現在の到達点（2026/04/01時点）

### Phase 1: Claude Codeスキル — 完成済み
- `/daily-report` コマンドでSlack/Googleカレンダー/Notionからデータ収集→日報ドラフト生成→確認→Slack投稿
- gws-cli経由でGoogleカレンダー取得成功
- 自分宛SlackDMにメモを残しておくと日報に自動反映
- 制約：Claude Codeセッション中のみ動作、毎回手動起動が必要

### Phase 2: 自前Slack Bot「safely-bot」 — 構築中
- Node.js + TypeScript / Slack Bolt（Socket Mode）/ Anthropic API（Claude Sonnet 4）
- **Step 1 完了**: Slack BotがSocket Modeで接続し、DMに応答できる状態
- Step 2〜5 が残り

---

## 技術スタック

```
Runtime:      Node.js + TypeScript
Slack:        Slack Bolt for JavaScript（Socket Mode）
AI:           Anthropic API（Claude Sonnet 4）— tool use でインテント分類・ツール選択
Data:         Slack API, Google Calendar API, Notion API
Scheduler:    node-cron（平日19:00 JST）
Hosting:      Railway / Render / Fly.io（~$5/月）
```

---

## アーキテクチャ — コアエンジン（全Phase共通）

### Intent Router（意図分類器）
Slack DMのメッセージをClaude tool useで解析し、適切なツールモジュールにルーティング。

### Tool Dispatcher（ツール実行器）
選択されたツールを実行。モジュールとして独立しており、新機能追加はツール定義の追加のみ。

### Approval Flow（承認フロー）
すべての「書き込み」操作にBlock Kit UIで確認画面を表示。「承認」「修正」「キャンセル」の3択。

### データフロー
```
Slack DM / 定時トリガー
    ↓
Intent Router（Claude tool use）
    ↓
Tool Dispatcher → 各API呼び出し
    ↓
結果をClaudeが整形・分析
    ↓
Slack DMで確認依頼（Block Kit UI）
    ↓
[承認] → 実行 + ログ記録
[修正] → 再生成ループ
[キャンセル] → 終了
```

---

## Phase 2: 日報自動化 — 残りステップ

### Step 2: データ収集モジュール（3-5日）
6データソースを `Promise.allSettled` で並列取得:
1. Slack活動ログ: `search.messages` で今日の自分のメッセージ
2. 前日日報: #日報-高橋幹佳 から「今後行う業務」を抽出 → 今日のTRY
3. 自分宛DMメモ: 業務中のメモ → 自動反映
4. 岡野社長の発信: lab-xx チャンネル → 「上司からのFB」欄
5. Googleカレンダー: 今日のMTG + 明日の予定
6. Notion: タスク・ノート

### Step 3: Claude APIで日報ドラフト生成（2-3日）
プロンプトにビジネスルールを全記載:
- 日報フォーマット（7セクション）
- IS欄に「広告費確認・キャンペーン精査」を定常的に含める
- TC欄に「GA4確認」「コミットメントタスクの進行」を含める
- 日付は `4月1日(火)` 形式（環境依存文字㊋は不可）
- Slack太字は `*テキスト*`（シングルアスタリスク）

### Step 4: Slack DM確認フロー（2-3日）
Block Kit UIで「承認して投稿」「編集」「キャンセル」ボタン。
編集はモーダル or DM内テキスト入力で指示 → 再生成。

### Step 5: node-cronスケジューラー + デプロイ（1-2日）
平日19:00 JST に Step 2〜4 を自動実行。Dockerizeしてホスティング。

---

## 日報フォーマット（SAFELY定型）

```
1. 前日設定したTRY
2. 本日行った業務（MTG / IS / SF / TC / Another / Routine）
3. 本日の業務での不足／不足を埋めるための行動
4. 上司からのFBで得た気付き／ネクストアクション
5. 気付いたこと／良かったこと／継続していきたいこと
6. 今後行う業務（ルーティン＋明日のカレンダー）
7. その他
```

---

## Phase 3: AI秘書化 — モジュール一覧と実装順序

### 推奨実装順序（Phase 2完成後）

| 順 | モジュール | 難易度 | 見積もり | 追加Auth |
|----|----------|--------|---------|---------|
| 1 | Slack知識検索 | 低 | 2-3日 | 不要 |
| 2 | カレンダーイベント作成 | 低 | 2-3日 | スコープ追加のみ |
| 3 | Asanaタスク操作 | 低 | 2-3日 | MCP接続済み |
| 4 | Notion知識検索 | 低 | 2-3日 | トークン流用 |
| 5 | Google Ads レポート | 中 | 1週間 | デベロッパートークン要 |
| 6 | Google Ads 問題診断 | 中 | 1週間 | 同上 |
| 7 | Google Ads アカウント操作 | 高 | 2週間 | 同上（MutateOperation） |
| 8 | Gmail返信ドラフト | 中 | 1週間 | OAuth Gmail scope |
| 9 | WordPress記事管理 | 中 | 1週間 | Application Passwords |
| 10 | Salesforceデータ連携 | 高 | 2週間 | OAuth Connected App |

### Google Ads API — 要注意事項
- デベロッパートークンが必要（MCC > ツールと設定 > APIセンターで申請）
- 審査に数日〜1週間 → Phase 2 実装と並行して早めに申請すること
- npm: `google-ads-api` v23.0.0
- GAQL でキャンペーン・アセットグループ・予算のメトリクス取得可能
- MutateOperation で予算変更・入札戦略調整・キーワード追加/除外が可能
- 安全対策: 全変更にDM承認必須、#ads-operations に変更ログ、ロールバック機能

### Intent Router — ツール定義一覧
```
generate_daily_report   — 日報ドラフトを生成
search_slack            — Slackメッセージを検索して要約
search_notion           — Notionを検索して情報取得
get_ads_performance     — Google Adsパフォーマンスデータ取得
diagnose_ads_issue      — 広告の問題診断 + 改善案提示
apply_ads_change        — 承認された広告変更を実行
create_calendar_event   — Googleカレンダーにイベント登録
draft_email_reply       — Gmail返信ドラフト作成
send_email              — 承認済みメール送信
create_asana_task       — Asanaタスク作成
publish_wp_draft        — WordPress下書き記事作成
get_pending_items       — 未対応・ボール停滞案件のサマリー
```

---

## Phase 4: チーム展開・高度化（将来構想）

- マルチユーザー対応（長嶺さん、愛嶋さん、野村さん等への展開）
- GA4 / GSC データ分析自動化（AIO影響モニタリング含む）
- freee工数管理連携
- 会議議事録パイプライン（transcript → 要約 → Asanaタスク → Slack投稿）
- チームダッシュボード

---

## 商品化構想 — AI秘書構築・伴走支援サービス

### コンセプト
ツール販売（SaaS）ではなく「業務コンサル × カスタム構築 × 継続改善」の伴走型。

### ターゲット
従業員20〜200名の中小企業。Slack利用、マネージャー3〜10名。
優先業種: 広告代理店 > SaaS/IT > 人材 > 不動産/士業。

### 価格体系（3段階: Entry → Expand → Embed）
- E1 Entry（1ヶ月）: 50万円 — ヒアリング3回 + 初期モジュール1つ + 導入支援
- E2 Expand（月額）: 15万円/月 — 月次ヒアリング + モジュール追加1-2個/月 + 改善
- E3 Embed（月額）: 8万円/月 — 四半期レビュー + 保守 + 軽微改善
- 年間クライアント単価: 約160万円
- 10社で年商 約1,600万円

### 競合差別化
汎用ツール（Slack AI等）との差別化ポイントは「業務理解力」。
技術ではなく「業務の棚卸し → 課題の構造化 → 仕組みでの解決」の伴走力が本質的な価値。

### 営業プロセス
1. 初回面談（無料30分）— 課題ヒアリング
2. 簡易診断レポート（無料A4 1枚）
3. デモ（safely-botデモ画面）
4. 提案書 + E1見積もり
5. E1実施 → 効果実感 → E2移行

### 最重要セールス質問
- 「毎朝Slackを開いて最初にやることは何ですか？」
- 「確認依頼に返信するのに1日何分使ってますか？」
- 「今、誰かの返信待ちで止まっている案件はありますか？」

---

## アクションプラン

### 4月
- [ ] safely-bot Phase 2 を Step 2〜5 まで完成
- [ ] 社内利用データ・効果測定を開始
- [ ] Google Ads API デベロッパートークン申請

### 5月
- [ ] Phase 3 主要モジュール実装（Slack検索、カレンダー、広告レポート）
- [ ] BGSチーム 2〜3名に展開
- [ ] 社内版「導入効果レポート」作成

### 6月
- [ ] 岡野社長に成果報告 + 外部展開の提案
- [ ] 1社目の候補に声かけ（SAFELY既存クライアント or 知人企業）
- [ ] E1実施 → サービス設計ブラッシュアップ

### 7月以降
- [ ] サービスメニュー確定
- [ ] note記事で事例発信開始
- [ ] 2〜3社目の獲得

---

## 関連ファイル

| ファイル | 内容 |
|---------|------|
| `docs/safely-bot-setup-guide.md` | Slack App作成手順（Socket Mode, Scope, Event設定等） |
| `docs/safely-bot-vision.md` | 全体構想書（Phase 2〜4 の全機能詳細 + コスト + セキュリティ） |
| `docs/ai-secretary-service-design.md` | 商品化サービス設計書（メニュー・価格・競合差別化・営業プロセス） |
| `docs/ai-secretary-proposal-template.md` | クライアント向け提案書テンプレート |
| `docs/safely-bot-demo.html` | 社長 / クライアント向けデモ画面（4シナリオ自動再生） |

---

*最終更新: 2026/04/01 — claude.ai での議論をもとに作成*
