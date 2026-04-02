# SAFELY 日報ボット — Slack App 作成ガイド

## 概要

このガイドでは、日報自動生成ボットのためのSlack Appを作成し、SAFELYのワークスペースにインストールするまでの手順を説明します。

所要時間: 約15〜20分

---

## 前提条件

- SAFELYのSlackワークスペースの管理者権限（またはApp承認権限）
- ブラウザでの作業（api.slack.com を使用）

---

## Step 1: Slack Appの作成

1. [https://api.slack.com/apps](https://api.slack.com/apps) にアクセス
2. 右上の **「Create New App」** をクリック
3. **「From scratch」** を選択
4. 以下を入力:
   - **App Name**: `SAFELY日報Bot`（任意の名前でOK）
   - **Workspace**: SAFELYのワークスペースを選択
5. **「Create App」** をクリック

---

## Step 2: Socket Mode を有効化

Socket Modeを使うと、パブリックURLやサーバー公開なしで双方向通信が可能になります。開発段階では特に便利です。

1. 左メニューの **「Socket Mode」** をクリック
2. **「Enable Socket Mode」** をトグルON
3. App-Level Token の作成を求められるので:
   - **Token Name**: `socket-token`
   - **Scope**: `connections:write` を追加
4. **「Generate」** をクリック
5. 表示された **App Token（`xapp-` で始まる）** をコピーして安全に保存

> **重要**: このトークンは後で `.env` ファイルに設定します。

---

## Step 3: Bot Token Scopes の設定

1. 左メニューの **「OAuth & Permissions」** をクリック
2. **「Scopes」** セクションまでスクロール
3. **Bot Token Scopes** に以下を追加:

| Scope | 用途 |
|-------|------|
| `chat:write` | ボットからメッセージを送信（日報投稿、DM送信） |
| `im:write` | ボットからDMを開始（確認依頼の送信） |
| `im:history` | DMの履歴を読み取り（修正指示の受信） |
| `channels:history` | パブリックチャンネルのメッセージ読み取り（今日の活動収集） |
| `groups:history` | プライベートチャンネルのメッセージ読み取り |
| `channels:read` | チャンネル一覧の取得 |
| `groups:read` | プライベートチャンネル一覧の取得 |
| `users:read` | ユーザー情報の取得 |

> **補足**: 必要に応じて後から追加可能です。最小限で始めて、機能拡張時に追加するのがベストプラクティスです。

---

## Step 4: Event Subscriptions の設定

ボットがメッセージやボタン操作を受信するための設定です。

1. 左メニューの **「Event Subscriptions」** をクリック
2. **「Enable Events」** をトグルON
3. **「Subscribe to bot events」** で以下を追加:

| Event | 用途 |
|-------|------|
| `message.im` | DMでの会話（修正指示の受信） |
| `app_mention` | チャンネルでの `@SAFELY日報Bot` メンション |

4. **「Save Changes」** をクリック

---

## Step 5: Interactivity（ボタン操作）の設定

承認・修正ボタンのクリックを受け取るための設定です。

1. 左メニューの **「Interactivity & Shortcuts」** をクリック
2. **「Interactivity」** をトグルON
3. Socket Mode を使用しているため、Request URL の入力は不要です
4. **「Save Changes」** をクリック

---

## Step 6: App Home の設定（任意だが推奨）

1. 左メニューの **「App Home」** をクリック
2. **「Messages Tab」** を有効化（ボットとのDMを許可）
3. 「Allow users to send Slash commands and messages from the messages tab」にチェック

---

## Step 7: ワークスペースにインストール

1. 左メニューの **「Install App」** をクリック
2. **「Install to Workspace」** をクリック
3. 権限の確認画面で **「許可する」** をクリック
4. 表示された **Bot User OAuth Token（`xoxb-` で始まる）** をコピーして安全に保存

---

## Step 8: Signing Secret の取得

1. 左メニューの **「Basic Information」** をクリック
2. **「App Credentials」** セクションの **Signing Secret** をコピー

---

## 取得すべきトークン一覧

以下の3つの値をすべて取得し、`.env` ファイルに設定します:

```
# .env ファイル
SLACK_BOT_TOKEN=xoxb-xxxxxxxxxxxx      # Step 7 で取得
SLACK_APP_TOKEN=xapp-xxxxxxxxxxxx      # Step 2 で取得
SLACK_SIGNING_SECRET=xxxxxxxxxxxxxxxx  # Step 8 で取得
ANTHROPIC_API_KEY=sk-ant-xxxxxx        # Anthropic Console から取得
```

---

## Step 9: ボットをチャンネルに招待

日報を投稿するチャンネルにボットを追加します:

1. Slackで日報チャンネル（例: `#日報`）を開く
2. チャンネル内で `/invite @SAFELY日報Bot` を入力して実行
3. ボットがチャンネルメンバーに追加されたことを確認

---

## Step 10: 動作確認テスト

すべての設定が完了したら、以下の簡単なスクリプトで接続を確認できます:

```javascript
// test-connection.js
import pkg from '@slack/bolt';
const { App } = pkg;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// DM受信テスト
app.message(async ({ message, say }) => {
  await say(`接続成功！受信メッセージ: ${message.text}`);
});

// ボタンアクション受信テスト
app.action('approve_report', async ({ ack, say }) => {
  await ack();
  await say('日報を承認しました！');
});

(async () => {
  await app.start();
  console.log('⚡️ SAFELY日報Bot が起動しました');
})();
```

起動コマンド:
```bash
node --env-file=.env test-connection.js
```

Slack上でボットにDMを送り、エコーバックされれば接続成功です。

---

## 次のステップ

Slack Appの作成が完了したら、以下の順で開発を進めます:

1. **プロジェクトのスキャフォールディング** — ディレクトリ構成、依存パッケージのセットアップ
2. **データ収集モジュール** — Slack / Notion / Google Calendar からの情報取得
3. **日報ドラフト生成** — Anthropic API でフォーマット済み日報を生成
4. **確認・承認フロー** — Block Kit UIでの承認ボタン実装
5. **スケジューラー設定** — 毎日19:00 JST自動実行
6. **デプロイ** — Render / Fly.io 等へのホスティング

---

## トラブルシューティング

**「not_authed」エラーが出る場合**
→ `SLACK_BOT_TOKEN` が正しくセットされているか確認。`xoxb-` で始まる値が必要です。

**Socket Mode接続が切れる場合**
→ `SLACK_APP_TOKEN`（`xapp-` で始まる値）を確認。Socket Modeが有効になっているかも再確認してください。

**ボットからDMが送れない場合**
→ `im:write` スコープが追加されているか確認。スコープ追加後はAppの再インストールが必要です。

**チャンネルに投稿できない場合**
→ ボットがそのチャンネルに招待されているか確認。`/invite @SAFELY日報Bot` を実行してください。
