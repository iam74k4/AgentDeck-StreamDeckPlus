# セットアップ手順

Stream Deck + に AgentDeck を載せて、実際に動かすまでの手順。

「どのキーを置いて、何を設定すればいいのか」を上から順に書いてある。
確認用のチェックリストは [`DEVICE_TEST.md`](./DEVICE_TEST.md)、
機能の説明は [`README.md`](../README.md) にある。

---

## 0. 必要なもの

| 必須 | 内容                                                                 |
| ---- | -------------------------------------------------------------------- |
| ○    | Windows 10 / 11                                                      |
| ○    | Stream Deck アプリ 6.5 以降 + Stream Deck + 本体                     |
| ○    | Node.js 20.5.1 以降                                                  |
| —    | Codex CLI（Agent操作・承認・モデル選択に必要。無くてもPluginは動く） |
| —    | git（Git / Diff キーに必要）                                         |
| —    | Claude Code 2.1.251 以降（Claude Usage に必要）                      |

Codex も Claude も無い状態でもインストールはできる。その場合キーが
`CLI?` / `SETUP` と表示されるだけで、Pluginは動き続ける。

---

## 1. インストール

### A. パッケージで入れる（チェックアウト不要）

```powershell
npm ci
npm run pack
```

`dist\com.agentdeck.streamdeck-plus.streamDeckPlugin` をダブルクリックする。
Stream Deck アプリが取り込んで再起動する。

### B. リンクして入れる（開発中はこちら）

```powershell
npm ci
npm run build
npx @elgato/cli link com.agentdeck.streamdeck-plus.sdPlugin
npx @elgato/cli restart com.agentdeck.streamdeck-plus
```

`npm run watch` にしておくと、ソースを編集するたびにビルドとPlugin再起動が走る。

---

## 2. 前提条件の確認

```powershell
npm run doctor
```

**FAIL が残っている間は先へ進まない。** WARN はその項目が使えなくなるだけで、
他の機能には影響しない（例: マイクが無ければ Push-to-Talk だけが使えない）。

doctor は失敗する順番どおりに確認する。Codex については
`--version` が通るだけでは足りないので、実際に `app-server` の
ハンドシェイクまで往復してからサインイン状態を見る。

---

## 3. キーを置く

Stream Deck アプリの右側、カテゴリ **AgentDeck** から
キーをドラッグして配置する。

設計書 §6.1 の推奨配置は次のとおり。全部置く必要はない。

```text
┌─────────┬─────────┬─────────┬─────────┐
│ Agent   │ Stop    │ Approve │ Deny    │  ← Agentの状態と、それへの応答
│ Status  │ Agent   │ Once    │         │
├─────────┼─────────┼─────────┼─────────┤
│ Push to │ Prompt  │ Usage   │ Project │  ← 入力と文脈
│ Talk    │         │         │         │
└─────────┴─────────┴─────────┴─────────┘
```

置ける全キー:

| キー             | 何をするか                                                |
| ---------------- | --------------------------------------------------------- |
| Agent Status     | Providerとセッションの状態、経過時間。押すとSession再取得 |
| Stop Agent       | 実行中Turnの中断。対象が無ければ減光                      |
| Approve Once     | 承認待ちを1回だけ承認。高リスクは長押し                   |
| Deny             | 承認待ちを拒否。常に1押し                                 |
| Prompt           | Prompt Presetを実行                                       |
| Push to Talk     | 押している間だけ録音、離すと送信                          |
| Screenshot to AI | 画面を取得してPromptと一緒に送信                          |
| Usage            | Rate limit 1枠                                            |
| Git Status       | ブランチと作業ツリーの件数                                |
| Diff Summary     | 変更量（追加 / 削除 / ファイル数）                        |
| Project          | Active Projectの表示と切替                                |
| App Launcher     | VS Code等をActive Projectのディレクトリで起動             |

### まず最低限動かすなら

**Agent Status** と **Usage** の2つだけ置けばいい。Codexにサインイン済みなら、
数秒で `CODEX / ● IDLE` と使用率が出る。ここが出れば接続は成功している。

その状態でリポジトリの中から `codex` を起動すれば、Projectも自動で登録される。
**手で入力が必要な設定は無い。**

---

## 4. 各キーの設定

キーを選ぶと右側に Property Inspector が出る。**空欄のままでも動く**ように
既定値を入れてあるので、変えたいものだけ触ればよい。

### 共通

- **Provider** — 空欄は Codex。Claude は監視のみなので、Stop / Approve /
  Prompt 系で選んでも動作しない
- 下の **Plugin settings** はどのキーから開いても同じ（全体設定）

### Usage

| 項目             | 説明                                                        |
| ---------------- | ----------------------------------------------------------- |
| Window           | `Auto` は最も逼迫している枠に追従。固定したい枠があれば選ぶ |
| Display          | 使用率 / 残量                                               |
| Warning / Danger | 色が変わる閾値（既定 75 / 90）                              |

### Git Status / Diff Summary

| 項目       | 説明                                                                 |
| ---------- | -------------------------------------------------------------------- |
| Repository | 作業ツリーの絶対パス。**空欄なら Active Project に追従する**（推奨） |

### Project

| 項目     | 説明                                                          |
| -------- | ------------------------------------------------------------- |
| Add path | ここにパスを入れて押すと、そのProjectを登録して有効化する     |
| Project  | 特定のProjectに固定したいときだけ指定。空欄なら押すたびに巡回 |

**最初にやること:** Project キーの Add path にリポジトリの絶対パス
（例 `C:\src\my-project`）を入れて1回押す。以後 Git / Diff / Launcher が
すべてそのProjectに追従する。

### Approve Once

| 項目      | 説明                                                   |
| --------- | ------------------------------------------------------ |
| Hold time | 高リスク要求の長押し秒数（既定 1.2秒、0.5〜5秒に制限） |

長押しを無効にはできない。低・中リスクは元から1押しで承認される。

### Push to Talk / Screenshot to AI

| 項目                  | 説明                                                    |
| --------------------- | ------------------------------------------------------- |
| Send through / Preset | どのPresetを通して送るか。空欄はPrompt Dialの選択に追従 |
| Capture               | Screenshotのみ。前面ウィンドウ / 全画面                 |

---

## 5. Touch Strip（ダイヤル）の設定

**Dashboard Segment** を Touch Strip にドラッグする。

4本すべてに置くと、位置で内容が決まる1枚のダッシュボードになる。

```text
┌──────────┬──────────┬──────────┬──────────┐
│ USAGE    │ AGENT    │ MODEL    │ PROJECT  │
└──────────┴──────────┴──────────┴──────────┘
```

3本以下なら、各ダイヤルの **Segment** 設定に従う。選べるのは
Usage / Agent / Session / Model / Prompt / Git / Diff / Project /
AI Overview / Provider。

回転と押下の意味はSegmentごとに違う。

| Segment | 回転                          | 押下                                            |
| ------- | ----------------------------- | ----------------------------------------------- |
| Usage   | 表示する枠を切替              | 更新                                            |
| Session | Sessionを切替                 | そのSessionをActiveに固定（もう一度押すと解除） |
| Model   | モデルとReasoning levelを切替 | **適用**（回転だけでは変わらない）              |
| Prompt  | Presetを切替                  | 実行                                            |
| その他  | Segment種別を切替             | 更新                                            |

---

## 6. Claude を繋ぐ（任意）

Claude Code は使用率を**push しかしない**（読み出すAPIが無い）ので、
Claude Code のステータスラインを AgentDeck 側へ向ける。

```powershell
npm run doctor
```

Claude bridge の項目に、**自分のマシンの絶対パスが入った貼り付け用のJSON**が
表示される。それを `%USERPROFILE%\.claude\settings.json` に入れる。

```json
{
	"statusLine": {
		"type": "command",
		"command": "node \"C:\\Users\\you\\AppData\\Roaming\\Elgato\\StreamDeck\\Plugins\\com.agentdeck.streamdeck-plus.sdPlugin\\bin\\statusline.mjs\""
	}
}
```

`%APPDATA%` ではなく絶対パスなのは意図的で、環境変数はClaude Codeが
`cmd.exe` 経由でコマンドを実行した場合しか展開されないため。

**既にステータスラインを設定している場合**は、末尾に `--then` を付けて
元のコマンドを続ける。標準入力もそのまま渡り、表示も元のままになる。

```json
"command": "node \"...\\bin\\statusline.mjs\" --then \"元のコマンド\""
```

設定後、Claude Code のセッションを開いてから `npm run doctor` を再実行すると
`Bridge readings` が OK になる。

- 認証情報はこの経路に一切関与しない。bridgeはClaude Codeが渡したものを
  `%LOCALAPPDATA%\AgentDeck\` へ書くだけ
- Claude Code を閉じると読み取りは古くなる。デッキは `STALE` と表示して
  直前の値を残す（現在値のふりはしない）

---

## 7. Prompt Preset を編集する（任意）

Prompt キーの Property Inspector 下部、**Presets** にJSONで書く。

```json
[
	{
		"id": "explain",
		"name": "Explain",
		"template": "これが何をしているか簡潔に説明して:\n\n{{input}}",
		"inputSource": "clipboard",
		"target": "active-session"
	}
]
```

| 項目          | 取りうる値                                        |
| ------------- | ------------------------------------------------- |
| `inputSource` | `none` / `clipboard` / `selection` / `screenshot` |
| `target`      | `active-session` / `new-session` / `clipboard`    |

- `{{input}}` が取得内容の入る場所。書き忘れても末尾に付く（捨てられない）
- 不正なJSONは保存されず、入力中のテキストも消えない
- 空にすると組み込みPresetに戻る

このPresetは Prompt キー・Prompt ダイヤル・Push-to-Talk・Screenshot to AI が
すべて共有する。

---

## 8. 困ったとき — デッキの表示から引く

| 表示       | 意味                           | 対処                                                            |
| ---------- | ------------------------------ | --------------------------------------------------------------- |
| `CLI?`     | Codex CLI が PATH に無い       | インストールするか、Plugin settings の Codex CLI にパスを入れる |
| `LOGIN`    | Codex にサインインしていない   | `codex` を一度実行してサインイン                                |
| `SETUP`    | Claude bridge が未設定         | 手順6                                                           |
| `OFFLINE`  | app-server が落ちた            | 自動で再接続する。繰り返すなら `npm run doctor`                 |
| `STALE`    | 取得に失敗し、直前の値を表示中 | Claude なら Claude Code が閉じている。Codex なら接続を確認      |
| `LIMIT`    | Rate limit に到達              | 待つ                                                            |
| `NO GIT`   | 指定パスがリポジトリではない   | Repository のパス、または Active Project を確認                 |
| `NO PROJ`  | Project が未登録               | Project キーの Add path から登録                                |
| `no diff`  | git が diff を返せなかった     | コミットが1つも無いリポジトリでは出る                           |
| キーが減光 | その操作の対象が無い           | Stop なら実行中Turnが無い、Approve なら承認待ちが無い           |
| 何も出ない | Pluginが起動していない         | `npm run doctor` の Stream Deck 項目を確認                      |

それでも分からないときは、Plugin settings の **Debug logging** を有効にして
`%APPDATA%\Elgato\StreamDeck\logs\` のログを見る。
認証情報はどのログレベルでも出力されない。

---

## 9. 次に

[`DEVICE_TEST.md`](./DEVICE_TEST.md) のチェックリストを上から順に。

**Push-to-Talk（§3.7）と Screenshot（§3.8）は実機が初回検証**になる。
CI環境にマイクもディスプレイも無いため、ロジックは自動テスト済みだが
PowerShellスクリプト自体は未検証の状態で出している。
