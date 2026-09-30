# worker — 業務の受付箱の「実作業」担当（高橋さんのPCで常駐）

mamo（Railway）が拾った依頼のうち、スマホで「🔍 進めて」を押したものを、このPCの Claude Code が分析・整理して、結果を高橋さんのDMに返す。

```
Slack の依頼 → mamo が拾ってDMにカード → 🔍 進めて（work_items.status = queued）
  → このPCの worker が1件ずつ取り出す → claude -p で分析 → Private/mamo-work/ に報告
  → DMに結果カード（事実／見立て／次の対応／相談事項）→ 📝 返信の下書き → ✅ で送信
```

## 動かし方

| やりたいこと | コマンド（`Corporate/mamo_project` で実行） |
|---|---|
| 常駐させる | `wscript worker\start-hidden.vbs`（ログオン時はスタートアップから自動起動） |
| 1件だけ処理して終える | `node worker/work-runner.mjs --once` |
| 止める | タスクマネージャーで `node.exe`（コマンドラインに `work-runner.mjs`）を終了 |
| ログを見る | `Private/mamo-work/_worker.log` |

- スタートアップのショートカット: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\mamo-work-runner.lnk`（`wscript.exe` で `start-hidden.vbs` を起動）。**このPCだけに置く**（2台で動かさない）
- 二重起動は `%TEMP%\mamo-work-runner.lock` で防ぐ
- 22時〜翌7時は新しい作業を始めない（結果のDMが夜中に届かないように）
- 1件の上限は40分。超えたら止めて「完了できませんでした」を返す

## 前提

- `railway` CLI にログイン済みで、このフォルダが `vigilant-determination / safely-bot` にリンクされていること（起動時に `railway variables` で DATABASE_URL と SLACK_BOT_TOKEN をメモリに読む。ファイルには書かない）
- `claude`（Claude Code CLI）にログイン済みであること。分析はこのPCの Claude Code の契約枠で動く

## 安全の仕組み（3重）

1. **秘密情報を渡さない**: mamo の鍵は worker のメモリにだけ置き、Claude Code の子プロセスには渡さない
2. **禁止リスト**: 送信・投稿・書き込み・デプロイ系のツールとコマンドを `--disallowedTools` で禁止（`work-runner.mjs` の `DISALLOWED_TOOLS`）
3. **auto モード＋厳守事項**: Claude Code は auto モードで動き、プロンプトで「読み取りと分析だけ・書いてよいのは報告ファイルだけ」を指示

ただし Bash で任意のスクリプトを書けるため、完全な隔離ではない。Slack への返信は必ず mamo の下書き → ✅ 経由で行う。
