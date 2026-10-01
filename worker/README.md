# worker — mamo の Claude 処理をすべて引き受ける（高橋さんのPCで常駐）

2026-10-01 から mamo は API キー（従量課金）を使わない。Claude を使う処理はすべて、このPCの Claude Code（チームプランのサブスク枠）が行う。

| 処理 | きっかけ | worker の中身 |
|---|---|---|
| 依頼の拾い上げ（仕分け） | 平日 9:30 / 14:00、DMで「依頼を拾って」 | `runWorkScan`（`src/data-sources/work-inbox.ts`） |
| 依頼の分析・整理 | カードの 🔍 | ワークスペースで `claude -p`（報告は `Private/mamo-work/`） |
| 返信の下書き | 📝 | `createDraft` |
| DMでの会話 | 高橋さん本人からのDM・@mamo | ワークスペースで `claude -p`（読み取りのみ） |
| Orbit改修依頼の分類 | CGSチャンネルの @mamo | `handleOrbitFixIntake`（`src/data-sources/orbit-fix.ts`） |
| MGR金曜アイディア抽出 | 金曜 14:00 | `runMgrIdeaExtractAndNotify` |

```
mamo（Railway・Claudeを呼ばない）
  → llm_jobs / work_items に作業を積む
  → DMの「連絡用スレッド」に 🔔 を返信（＝合図）
worker（このPC）
  → 15秒ごとに Slack の連絡用スレッドを見る（Slack API は無料）
  → 合図があったときだけ DB から作業を取り出す（Neon を起こしっぱなしにしない）
  → claude -p で実行 → 結果を Slack に書く → 合図の返信を消す
```

mamo のコード（`src/`）は Claude を `getClaudeClient()` 経由で呼ぶ。worker の中では `MAMO_LLM=cli` になり、`claude -p` を呼ぶアダプターに差し替わる（`src/utils/claude-client.ts`）。Railway 上で呼ばれた場合は課金を防ぐためにエラーになる。

## 動かし方

| やりたいこと | コマンド（`Corporate/mamo_project` で実行） |
|---|---|
| 常駐させる | `wscript worker\start-hidden.vbs`（ログオン時はスタートアップから自動起動） |
| 手元で動かして様子を見る | `node node_modules/tsx/dist/cli.mjs worker/work-runner.ts` |
| 止める | タスクマネージャーで `node.exe`（コマンドラインに `work-runner.ts`）を終了 |
| ログを見る | `Private/mamo-work/_worker.log` |
| 型チェック | `npx tsc -p worker/tsconfig.json` |

- スタートアップのショートカット: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\mamo-work-runner.lnk`（`wscript.exe` で `start-hidden.vbs` を起動）。**このPCだけに置く**（2台で動かさない）
- 二重起動は `%TEMP%\mamo-work-runner.lock` で防ぐ
- 22時〜翌7時は新しい作業を始めない。夜のあいだの依頼は朝7時から処理する
- 分析は40分、会話は10分で打ち切る。分析と軽い作業（会話・下書き・拾い上げ）は別々に並行して動くので、長い分析中でも会話は待たない
- PC が止まっていた間の作業は、次に起動したときに処理する（同じ拾い上げが溜まっていたら1回にまとめる）

## 前提

- `railway` CLI にログイン済みで、このフォルダが `vigilant-determination / safely-bot` にリンクされていること（起動時に `railway variables` で鍵をこのプロセスにだけ読む。ファイルには書かない）
- `claude`（Claude Code CLI）に高橋さんのアカウントでログイン済みであること。利用枠は claude.ai のチャットや普段の Claude Code と共有（5時間ごと・週ごと）。枠を超えると止まり、課金はされない（usage credits を有効にしていない限り）

## 安全の仕組み

1. **会話は高橋さん本人だけ**: PC の Claude Code はワークスペース全体（Private/ を含む）を読めるため、他の人からの DM・@mamo には答えない（mamo 側で断る）
2. **秘密情報を渡さない**: mamo の鍵・API キーは Claude Code の子プロセスに渡さない（API キーがあると従量課金になるため、その意味でも外す）
3. **禁止リスト**: 送信・投稿・書き込み・デプロイ系のツールとコマンドを `--disallowedTools` で禁止（`work-runner.ts` の `DISALLOWED_TOOLS`）
4. **auto モード＋厳守事項**: プロンプトで「読み取りと分析だけ」を指示

ただし Bash で任意のスクリプトを書けるため、完全な隔離ではない。Slack への返信は必ず mamo の下書き → ✅ 経由で行う。
