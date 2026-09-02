# Technical Spike 報告書

- 対象: AgentDeck for Stream Deck Plus
- 正本: [`AGENTDECK_DESIGN.md`](../AGENTDECK_DESIGN.md)
- 実装指示: [`AGENTDECK_CLAUDE_INSTRUCTIONS.md`](./AGENTDECK_CLAUDE_INSTRUCTIONS.md)
- フェーズ: Technical Spike（v0.1本実装の前段）
- 作成日: 2026-08-30

---

## 1. Step 1 — Repository確認結果

着手時点のリポジトリ内容は以下のみだった。

```text
LICENSE
README.md
```

指示書 §3 Step 1 の確認対象に対する差分は次のとおり。

| 確認対象                    | 着手時 | 対応                                                     |
| --------------------------- | ------ | -------------------------------------------------------- |
| ディレクトリ構成            | なし   | 設計書 §24 / 指示書 §6 に沿って作成                      |
| `package.json`              | なし   | 作成（Node >= 20.5.1、ESM）                              |
| Stream Deck Plugin scaffold | なし   | `com.agentdeck.streamdeck-plus.sdPlugin/` を作成         |
| TypeScript設定              | なし   | `tsconfig.json` / `tsconfig.build.json` を作成（strict） |
| ESLint / Prettier           | なし   | ESLint 10 flat config / Prettier 3 を作成                |
| Test framework              | なし   | Vitest を導入                                            |
| `.gitignore`                | なし   | 作成                                                     |
| manifest                    | なし   | 作成（SDK 2 / Stream Deck 6.5+ / Windows 10+）           |

指示書 §2.1 に従い、設計書と実装指示書をリポジトリ内へ取り込み、正本として参照できるようにした。

---

## 2. Step 3 — Technical Spike 実施結果

### Spike A — Codex App Server

| 検証項目                              | 結果 | 根拠                                                                                |
| ------------------------------------- | ---- | ----------------------------------------------------------------------------------- |
| `codex app-server --stdio` 起動       | 済   | `infrastructure/process-manager.ts`。CLI不在は `CLI_NOT_FOUND` へ分離               |
| JSONL read/write                      | 済   | `providers/codex/json-rpc.ts`。分割chunk・複数行同時到達・非JSON行を検証            |
| JSON-RPC request/response correlation | 済   | 応答順序が入れ替わっても各requestが自分の応答を受け取ることを検証                   |
| `initialize`                          | 済   | `providers/codex/app-server-client.ts`                                              |
| `initialized` notification            | 済   | 送出順序 `initialize` → 応答 → `initialized` を検証                                 |
| `account/rateLimits/read`             | 済   | 起動時に取得し `UsageWindow[]` へ変換                                               |
| `account/rateLimits/updated`          | 済   | Sparse merge を実装・検証（後述）                                                   |
| Turn state event                      | 済   | `turn/started` / `turn/completed` / `thread/status/changed` を Session state へ写像 |
| `turn/interrupt`                      | 済   | `turnId` 既知時は直接、未知時は `thread/read` から解決                              |

`initialized` 前の `account` / `thread` / `turn` 呼び出しは、送信前に
`INITIALIZATION_FAILED` で失敗する（指示書 §7.1）。テストではワイヤ上に1バイトも
出ていないことまで確認している。

### Spike B — Stream Deck Plus

| 検証項目                       | 結果 | 根拠                                                     |
| ------------------------------ | ---- | -------------------------------------------------------- |
| Dynamic Key image              | 済   | `presentation/renderers/key-renderer.ts`（SVG data URI） |
| Encoder Action                 | 済   | `actions/dashboard-encoder-action.ts`                    |
| Custom layout / `setFeedback`  | 済   | `layouts/segment.json` + `encoder-renderer.ts`           |
| Touch Strip描画                | 済   | 4 segment を1フレームで更新                              |
| 4 Encoder context管理          | 済   | `Map<DeviceId, Map<Column, EncoderContext>>`             |
| `willAppear` / `willDisappear` | 済   | 登録・解除とデバイス単位の独立性を検証                   |

4枠が揃わない場合は Standalone Segment Mode（各Actionの設定に従う）へ
フォールバックする（設計書 §6.2）。

### Spike C — Git

| 検証項目                              | 結果 | 根拠                                            |
| ------------------------------------- | ---- | ----------------------------------------------- |
| branch                                | 済   | `--porcelain=v2 --branch`                       |
| modified / staged / untracked         | 済   | XY欄を staged / worktree で分離集計             |
| ahead / behind                        | 済   | `# branch.ab`                                   |
| 非Gitディレクトリ時のfailure handling | 済   | `GIT_NOT_REPOSITORY`。git不在は `CLI_NOT_FOUND` |

detached HEAD、コミット0件、CRLF、conflicted（`u`行）、ignored（`!`行）も検証済み。

### Spike成功条件に対する到達状況

指示書 §3 の成功条件は「実機Stream Deck Plus上に `CODEX / ● WORKING or IDLE /
Usage xx%` が表示され、STOPキーで実行中Turnを中断できること」である。

下図は実際のRenderer出力（`npm run preview` で再生成可能）。

![AgentDeckのキーとTouch Strip](images/deck.svg)

**ソフトウェア側は成立している。** `tests/integration/spike-acceptance.test.ts` が、
実プロセス（app-serverのワイヤ形式を話す子プロセス）・実サービス・実Coordinatorを
通して以下を検証している。

- Touch Strip 4列に `CODEX 41% 5h` / `AGENT IDLE` / `GIT main` / `CODEX READY`
- `turn/started` 受信で `AGENT WORKING` へ遷移し、STOPキーが有効表示になる
- `SessionService.interruptActive()` で実行中Turnが中断され `idle` へ戻る
- Codex CLI不在時に `CLI?`、app-server異常終了時に `STALE` / `OFFLINE`

**未達は実機検証のみ。** 本作業環境にStream Deck Plus実機とCodex CLIが無いため、
指示書 §12 Device の項目（実機Key更新 / Encoder回転・押下 / Profile切替 /
Device再接続 / Plugin再起動）は未実施である。実機確認手順は
[`docs/DEVICE_TEST.md`](./DEVICE_TEST.md) にまとめた。

---

## 3. 設計との差異・確認事項

指示書 §14 の報告フォーマットに従う。いずれも軽微かつ追加的で、
Domain Model・依存方向・Safe by Default の各原則は変更していない。

### 設計差異 1 — Provider に Usage の pull 経路を追加

#### 現行設計

設計書 §8.1 の `AgentProvider` は `listSessions` / `interrupt` / `steer` /
`getModels` を任意メンバとして持つが、Usage取得メソッドを持たない。

#### 実際の制約

設計書 §17.1 は `Provider → UsageService → Snapshot Cache` というデータフローを
定めており、Manual Refresh（設計書 §21.3）はユーザー操作を起点に
Provider へ問い合わせる必要がある。push経路（`usage-updated`）だけでは
「今すぐ取り直す」を表現できない。

#### 推奨変更

`AgentProvider` に任意メンバ `refreshUsage?(): Promise<UsageSnapshot>` を追加する。
実装しないProviderはpush経路のみで動作し、`UsageService` はキャッシュを返す。

#### 影響範囲

`src/providers/provider.ts` のみ。既存の任意メンバと同じ扱いのため、
Provider追加時の負担は増えない。

---

### 設計差異 2 — `GitService` の追加

#### 現行設計

設計書 §24 の `application/` は
`usage-service` / `session-service` / `project-service` / `approval-service` /
`provider-registry` を列挙し、Git向けサービスを含まない。

#### 実際の制約

設計書 §16.3 は「Project active時のみ低頻度polling」「Agentイベントを契機に
git refresh」を要求する。この制御をAction側に置くと、同一リポジトリを見る
複数Actionが個別に `git status` を起動し、設計書 §17.2 と同じ多重実行問題が
Git側で再発する。

#### 推奨変更

`application/git-service.ts` を追加し、パス単位のキャッシュ・single-flight・
watcher数に応じたpolling開始/停止を持たせる。`GitAdapter` は注入する。

#### 影響範囲

`application/` に1ファイル追加。Domain・Provider・依存方向に変更なし。

---

### 設計差異 3 — Touch Strip 第4列の暫定割り当て

#### 現行設計

設計書 §6.1 の Touch Strip は `USAGE | AGENT | MODEL | PROJECT`、
指示書 §8.2 は `USAGE | AGENT | GIT | PROJECT` を示す。

#### 実際の制約

`PROJECT` は v0.1（Project Service）、`MODEL` は v0.4（Model Selector）の
スコープであり、指示書 §2.2 によりSpike段階では先行実装できない。

#### 推奨変更

Spike段階の4列を `USAGE | AGENT | GIT | PROVIDER` とする。第4列はCodex
app-serverの接続状態（READY / STALE / LOGIN / CLI? / ERROR）を表示し、
Spike検証そのものに役立つ。v0.1 で `PROJECT` に置き換える。

#### 影響範囲

`presentation/plus-dashboard-coordinator.ts` の `DASHBOARD_COLUMNS` 1箇所。
列の意味は定数表で定義しているため差し替えは局所的。

---

### 確認事項 — Codex protocol 型生成

設計書 §9.6 は `codex app-server generate-ts` による型生成を求めている。
本環境にCodex CLIが無いため生成できず、代わりに
`src/providers/codex/protocol.ts` に**意図的に狭い寛容な読み取りモデル**を置いた。
未知フィールド・null を安全に無視する。

- 生成用スクリプト: `npm run codex:generate-types`（出力先 `src/generated/codex/`、gitignore対象）
- 生成型へ切り替える際に変更が必要なのは `src/providers/codex/mapper.ts` のみ

ワイヤ形状は openai/codex の `codex-rs/app-server-protocol`（`protocol/v2`、
serde `rename_all = "camelCase"`）および `codex-rs/app-server/README.md` で確認した。
特に `RateLimitSnapshot` は全メンバがnullableで、Rust側コメントにも
「`None` は未報告であり sparse-update の復元ではない」と明記されている。
設計書 §9.4 の「不明値で既存値を消さない」と一致する。

---

## 4. 検証結果

```text
npm run verify
  ├─ prettier --check   OK
  ├─ eslint             OK (0 errors)
  ├─ tsc --noEmit       OK
  ├─ vitest run         12 files / 203 tests passed
  └─ rollup -c          OK

npx @elgato/cli validate com.agentdeck.streamdeck-plus.sdPlugin
  Validation successful
```

テスト内訳:

| 区分        | ファイル            | 内容                                                   |
| ----------- | ------------------- | ------------------------------------------------------ |
| Unit        | `redact`            | Credential / Prompt / Clipboard の非出力（指示書 §11） |
| Unit        | `codex-mapper`      | Usage mapper、Sparse update merge、Session reducer     |
| Unit        | `domain`            | Window selection、Project validation、Error mapping    |
| Unit        | `git-status-parser` | Git parser                                             |
| Unit        | `json-rpc`          | Framing、correlation、handshake順序                    |
| Unit        | `application`       | Shared cache、single-flight、STALE保持、Session選択    |
| Unit        | `presentation`      | Key/Segment描画、4 Encoder Coordinator                 |
| Integration | `codex-provider`    | Process lifecycle、notification、crash recovery        |
| Integration | `git-adapter`       | 実リポジトリに対するGit Adapter                        |
| Integration | `spike-acceptance`  | Spike成功条件の通し検証                                |

### 実装中に検出・修正した不具合

Spike acceptance テストを書いた際に、単体テストでは見えなかった3件を検出し修正した。

1. **Provider異常時にUsage cacheが更新されない**
   `provider-status` イベントのみを発行していたため、CLI不在やプロセス異常終了後も
   `UsageService` のキャッシュが `ready` のまま残り、キーが古い値を表示し続けた。
   健全性の変化はUsage snapshotとしても発行するよう修正。

2. **Touch StripでWindow labelが警告表示に上書きされる**
   `STALE` や reset表示が `5h` / `7d` を押し出し、どのWindowの%か分からなくなっていた。
   Window labelを常に残し、警告を追記する形へ修正。

3. **背景再描画がGit segmentを消す**
   リポジトリパスはAction設定由来のため、Runtime側の定期再描画が
   パス無しでdashboardを再構築し、Git列が空になっていた。
   `setDashboardContext()` を追加し、Encoder Actionが文脈を通知する形へ修正。

---

## 5. コードレビューと是正

Spike完了後にブランチ全体（110ファイル / 約14.4k行）を10観点でレビューし、
**15件の指摘をすべて修正した**。160テストが全緑の状態で出た指摘であり、
テストがサービス層とマッパーに寄りすぎて **Action層（SDK境界）が素通し**
だったことが原因である。修正と併せてAction層のテストを新設した。

15件は独立した15個ではなく、4つのパターンに集約された。

### パターン1 — クロージャが古い settings を掴む（3件）

`willAppear` で `ev.payload.settings` をキャプチャし、`onDidReceiveSettings` で
購読を張り直していなかった。SDKはイベントごとにpayloadを作り直す
(`ActionEvent` が `this.payload = source.payload`) ため、Property Inspectorで
変更した設定が次の背景再描画で元に戻っていた。Agent Statusは `tick` 購読が
あるため1秒で戻る。`GitAction` だけが正しい形だった。

**是正**: `src/actions/renderer-binding.ts` を新設し、全Actionが同一の
bind経路（release → 購読 → 初回描画）を通るようにした。再発の原因は
「実装が分岐していたこと」なので、共有化そのものが修正である。

### パターン2 — Encoder回転が機能していない（2件）

`#cycleUsageWindow` が次のWindowを計算して破棄していた。Segment切替も、
プラグイン側 `setSettings` が `didReceiveSettings` を返さない
(SDK `dist/plugin/actions/action.js:88` で確認) ため `preferredSegment` が
更新されなかった。manifestで `Rotate: "Change view"` と宣伝しているのに
両方とも無効だった。

**是正**: `DashboardEncoderSettings` に `windowMode` / `windowId` を追加し、
`UiCoordinator.dashboardData` が `WindowSelection` を受け取るようにした。
回転は `auto → 各Window → auto` を巡回する（設計書 §7.5 により、消えた
Pinned Windowは自動差替えせず `--` を出すため、autoへ戻る導線が要る）。
回転時はローカルにも即座に再registerして描画する。

### パターン3 — 文字列マッチによるエラー分岐（2件、指示書§10違反）

git の stderr と Codex のエラーメッセージを正規表現で判定していた。
Windows版gitはNLS同梱のため、日本語環境では `NO GIT` ではなく `ERROR` が出る。

**是正**:

- Git: 失敗時に `rev-parse --is-inside-work-tree` の**終了ステータス**で判定。
  併せて `LC_ALL=C` を固定した。
- Codex: `json-rpc.ts` から認証判定を削除。代わりに `account/read` の
  **戻り値の形**（内部タグ付きunionのタグの有無）で判定する。
  これにより未使用だった `AppServerClient.readAccount` が実際に使われるようになった。

### パターン4 — 設定・寿命管理の穴（4件）

Property Inspectorがキーストロークごとに `setGlobalSettings` を送り、
1打鍵ごとにapp-serverが再起動していた。さらに `#startOnce` のガードに
`"stopping"` が無いため start/stop が競合し、**子プロセスをリークしたうえ
health checkが恒久停止**する経路があった。

**是正**:

- PI: テキスト入力を400msデバウンス（select/checkboxは即時）。
  編集中のフィールドは外部更新で上書きしない。
- Provider: start/stopを単一キューで直列化。`#stopping` は同期的に立て、
  再起動タイマーが最新の意図を見るようにした。
- Health check間隔に下限15秒、git polling間隔に下限5秒を設けた
  （PIの `min` はJSが `value` を読む際に強制されない）。
- `gitPollIntervalMs` を実際に配線し、`GitService.setPollInterval` を追加した。

### 単体の指摘

| 指摘                                                                        | 是正                                                                      |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `rateLimits` と `rateLimitsByLimitId` で同じ枠を2重にバケット化             | keyed mapがある場合はそちらを正とする。実測で4窓→2窓を確認                |
| `session-removed` が provider を跨いでIDの一致するSessionを削除             | provider修飾したキーで削除するよう修正                                    |
| Runtime が `tick` を常時購読し、Idleガードを無効化                          | Encoder occupancy（0↔1遷移）に応じて購読/解除するよう変更                 |
| `branch.oid (initial)` が実質デッドコードで、`detached` のdocと実装が不一致 | `hasCommits` を追加。`detached` は detached HEAD のみを意味するよう明確化 |
| `spawnErrorToAgentDeckError` が未使用で、documentした契約が未実装           | `ProcessExit.error` として実際に配線。ENOEXECもCLI_NOT_FOUNDへ            |
| `CodexMethod.AccountUsageRead` / `TurnSteer` が未使用                       | 削除（呼び出し側が来る段階で追加する）                                    |

### テスト

160 → **203件**。追加の中心は今まで存在しなかったAction層である。

| 追加                                | 内容                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `tests/unit/actions.test.ts`        | 設定変更が**次の**背景再描画を跨いで保持されること、Encoder回転、STOPの有効/無効            |
| `tests/unit/ui-coordinator.test.ts` | 概念別の通知ルーティング、1Hzタイマーの起動条件                                             |
| `tests/helpers/fake-runtime.ts`     | 実サービスで組んだRuntime（モックではなく実配線を検証する）                                 |
| 既存ファイルへ追加                  | バケット重複、認証、start/stop競合、spawn失敗、間隔下限、poll間隔、occupancy、localized git |

新テストが元の不具合を実際に捕捉することは、修正を一時的に戻して
失敗することを確認済み。

なお、Vitest（Vite 7 / oxc）はTC39標準デコレータを降格しないため、
Action層のテストが読み込めなかった。`vitest.config.ts` に、デコレータを
含むファイルだけを `tsc`（製品ビルドと同じコンパイラ）で変換する
小さなプラグインを追加して解決した。

---

## 6. Spike D — Claude（v0.2 Claude Usage Provider）

設計書 §25 Spike D と §10 に基づき、Claude の取得口を調査して実装した。

### 調査結果

設計書 §10.1 は「Claude側は公開・安定した Usage API が保証されない可能性を前提に
する」としていた。実際に Claude Code 2.1.251 を調べた結果は次のとおり。

| 検証項目                | 結果                                                    |
| ----------------------- | ------------------------------------------------------- |
| Usage取得可否           | **可能**。ただし pull ではなく push のみ                |
| ローカルUsageキャッシュ | **無し**。`~/.claude` 配下に該当ファイルは存在しない    |
| CLIコマンド             | **無し**。`claude --help` に usage 系サブコマンドは無い |
| Credential discovery    | **不要**。認証情報を一切読まずに取得できる              |
| Parser fixture          | 用意済（`tests/fixtures/claude/*.json`）                |

決め手は **status line 機構**である。Claude Code は
`settings.json` の `statusLine.command` に設定されたコマンドへ、セッション情報を
JSON で stdin に渡す。その中に次が含まれる。

```json
"rate_limits": {
  "five_hour":   { "used_percentage": 23.5, "resets_at": 1738425600 },
  "seven_day":   { "used_percentage": 41.2, "resets_at": 1738857600 },
  "spend_limit": { "used_percentage": 62.8, "resets_at": 1740787200 }
}
```

これは設計書 §7.3 の `UsageWindow`（usedPercent / resetsAt / windowDurationMinutes）
へそのまま写像でき、5h / 7d という窓は設計書 §18 の例（`Claude 96% 7d`）とも一致する。
インストール済みバイナリに当該フィールド名が存在することも確認済み。

### 実装

```text
Claude Code
   ↓ statusLine (JSON on stdin)
bin/statusline.mjs   ← AgentDeckのbridge
   ↓ atomic write
%LOCALAPPDATA%\AgentDeck\ (Windows)
   ↓
ClaudeStatusFileSource → StatusLineUsageParser → UsageSnapshot
```

設計書 §10.1 の `Claude Raw Response → ClaudeUsageParser → UsageSnapshot` を
そのまま満たす。§10.3 の Credential 要件（読み取り専用 / Plugin へコピーしない /
更新は公式Clientへ任せる）は、**そもそも認証情報を触らない**ことで満たしている。

bridge は既存の status line を奪わない。`--then "<元のコマンド>"` を付ければ
元コマンドが同じ stdin を受け取り、その stdout がそのまま Claude Code に表示される。
不正な入力・書き込み失敗・チェーン先の異常終了、いずれでも exit 0 を返す
（デッキが止まることより、ユーザーの status line が壊れることの方が問題が大きい）。

実機の bridge 動作は検証済み。ビルド済み `bin/statusline.mjs` に実 payload を
流し、次を確認した。

- Node 20 / 21 / 22 のいずれでも exit 0（**拡張子は `.js` ではなく `.mjs`**。
  インストール先の `.sdPlugin` に package.json が無いため、`.js` は CommonJS と
  解釈され、ESM構文検出のない Node では読み込みに失敗する）
- ファイル書き出しとチェーン先出力の両立、単体使用時の無出力
- 壊れた stdin でも status line が生存、チェーン先が exit 3 でも exit 0
- 2セッション同時でも互いを上書きしない（セッション単位のファイル）
- `session_id` にパストラバーサルを仕込んでもディレクトリ外へ出ない
- rename 失敗時に一時ファイルを残さない

### Claude は監視のみ

Claude Code の status line は「どのセッションが開いているか」は報告するが、
**「今ターンが走っているか」は報告しない**。また制御チャネルも存在しない。
よって `ClaudeProvider` は `interrupt` / `steer` を実装せず、Session state は
`idle` を報告する（推測しない）。設計書 §8.1 でこれらが任意メンバなのは
まさにこのためであり、実装しないことが「押せないSTOPをデッキに出さない」
（設計書 §12.2）を担保している。

### AI Overview

設計書 §18 に従い、Provider を横並びで表示し合算しない。最も逼迫した Provider が
見出しになり、残りは後ろに列挙される。**データを報告していない Provider も
一覧から消えない** —— `Claude --` という行が、bridge が未設定であることを
ユーザーに伝える唯一の手がかりだからである。

Touch Strip 第4列の既定を `PROVIDER` から `OVERVIEW` へ変更した（§3 設計差異3の
暫定割り当ての解消）。`PROVIDER` は Segment 設定で引き続き選択できる。

### 残課題

- Claude Desktop deep link（設計書 §10.4）は未実装
- `spend_limit` は Claude apps gateway 配下でのみ出現するため、実データでの確認は未
- 実機での bridge 設定手順の確認（`docs/DEVICE_TEST.md`）

---

## 7. v0.1 Control Core 完了

指示書 §4 の v0.1 範囲を実装した。

| 項目                                                                | 実装                                                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Project登録 / 一覧 / Active / 切替 / path validation                | `application/project-service.ts`。永続化はStream Deck global settingsだが、Serviceは注入された`ProjectStore`しか知らない |
| App Launcher（VS Code / Windows Terminal / Codex CLI / 任意アプリ） | `adapters/launcher/app-launcher.ts`                                                                                      |
| Project Action / App Launcher Action                                | `actions/project-action.ts` / `actions/launcher-action.ts`                                                               |
| Git のリポジトリを Active Project から解決                          | Git Actionは設定が空ならActive Projectを使う。Touch Strip も同様                                                         |
| Touch Strip 第4列                                                   | `OVERVIEW` から `PROJECT` へ（設計書 §6.1 / 指示書 §8.2 のとおり）。OVERVIEWはSegment設定で選択可能                      |

### 設計判断

**Launcher はシェルを介さない。** 引数配列 + `shell: false` で spawn するため、
プロジェクトパスに `&` や引用符が含まれてもコマンドとして再解釈されない。
未インストールのアプリはキーが減光表示になり、押しても失敗しない。

**ドライブ相対パスを拒否する。** `\src\game` は Windows 的には絶対パスだが、
その時点のカレントドライブに依存して解決される。永続化される設定が依存してよい
性質ではないため、ドライブレター / UNC / `/` を要求する。

### 残課題

- **実機検証**（[`DEVICE_TEST.md`](./DEVICE_TEST.md)）— 唯一の未達
- Claude Desktop deep link（設計書 §10.4）

---

## 8. v0.4 — Approval UI / Model selector

指示書 §5.4 のうち Approval UI と Model / Reasoning selector を実装した。
Plan Progress / Diff Summary / Session Manager強化は未着手。

### Approval

#### Codexには承認要求の窓口が2つある

`openai/codex` の `server_request_definitions!` を読み直したところ、
Server→Client の承認要求は起動経路によって別のメソッドになる。

| メソッド                                | 対象                                   | 応答の語彙                 |
| --------------------------------------- | -------------------------------------- | -------------------------- |
| `item/commandExecution/requestApproval` | `turn/start` で開始したTurn（現行API） | `accept` / `decline` ほか  |
| `item/fileChange/requestApproval`       | 同上                                   | `accept` / `decline` ほか  |
| `execCommandApproval`                   | `sendUserTurn` 等のレガシーAPI         | `approved` / `denied` ほか |
| `applyPatchApproval`                    | 同上                                   | 同上                       |

当初はレガシー側だけを実装していた。現行APIを使うClientに届くのは上の2つなので、
`providers/codex/approval-mapper.ts` は4つすべてを受け、**要求が届いたメソッドと
同じ方言で応答する**。無応答はAgentを永久に待たせるため、レガシー側も答える。

#### `Always Approve` を構造的に送れないようにする

両方の語彙に「以後聞かない」系の値がある。

```text
現行  acceptForSession / acceptWithExecpolicyAmendment / applyNetworkPolicyAmendment
旧    approved_for_session / approved_execpolicy_amendment
      approved_mcp_policy_amendment / network_policy_amendment
```

指示書 §2.5 はこれらすべてを禁じている。Mapperの関数はいずれも
`ApprovalDecision`（`"approve-once" | "deny"` の2値）だけを受け取るため、
禁止値は「送らない」のではなく**表現できない**。テストは4メソッド×2決定の
直積をシリアライズし、禁止語がバイト列に現れないことを確認する。

#### リスク判定は `bash -lc` の内側を読む

Codexはほとんどのコマンドを `["bash","-lc","<script>"]` で実行する。
`argv[0]` だけを見ると全部 `bash` になり、`rm -rf` が低リスクになってしまう。
`domain/approval.ts` はシェルラッパを解いて中のスクリプトを取り出し、
`|` `&&` `;` で区切った**各コマンドを個別に**判定する。

判定できない入力は `high`（＝Hold必須）に倒す。コマンド置換（`$(…)` / backtick）や
引用符の不一致は、コマンドを隠せてしまうため解析を諦めて `high` にする。

現行APIの `item/fileChange/requestApproval` はファイルパスを含まない
（`itemId` で参照する）。デッキ上で内容を判断できない以上 `high` として扱い、
Hold を要求する。

#### 誰も代わりに答えない

タイムアウトも既定値も置いていない。唯一の例外は切断で、app-serverが去る前に
待機中の要求を `deny` で閉じる（設計書 §22.2 fail closed）。

### Model / Reasoning selector

`thread/settings/update` の `model` / `effort` のみを送る。同APIには
approval policy / sandbox policy / permission profile も乗るが、デッキから
Codex側の安全設定を緩められてしまうため**意図的に送らない**。

回転はハイライトの移動だけで、適用は押下時のみ（設計書 §19）。
未適用のハイライトは `… · press` と表示して区別する。

### Touch Strip 第3列

設計差異3で `GIT` に置いていた第3列を、設計書 §6.1 のとおり `MODEL` にした。
`GIT` は Segment 設定で選べる（Overview / Provider と同じ扱い）。

### 検出した不具合

- **`APPROVE` が `PPROV` と描画される。** プレート上に背景色で描く文字が
  プレート幅を超えると、はみ出した部分が背景に溶けて消える。SVGは文字幅を
  測れないため、`fitFontSize` で収まるサイズまで縮めるようにした。
  プレビュー画像をPNGへ落として目視したときにだけ見つかる種類の不具合で、
  回帰テストは推定幅がプレート幅以下であることを検査する。
- **Hold中にキューが動くと、読んでいない要求を承認しうる。** Holdは約1秒かかる。
  完了時に「今の先頭」を承認する実装だと、その間に元の要求が別経路で解決されて
  次の要求が先頭に来た場合、ユーザーが読んでいない要求をHoldが承認してしまう。
  Approve / Deny とも**描画した要求のidを指定して**解決するようにし、Holdの各
  フレームで対象がまだ待機中かを確認するようにした。
- **切断時の `deny` がワイヤに出ない。** 応答の書き込みはPromiseの継続で
  起きるため、`transport.close()` の直前に1マイクロタスク譲るだけでは間に合わない。
  イベントループを1周譲るように直し、統合テストで実際のバイト列を確認した。

### 制約（過大評価しないための注記）

承認要求は**その会話を持つClient**へ届く。AgentDeckは自前のapp-serverプロセスを
持つため、届くのは原則としてAgentDeck自身が開始したTurnの承認である。
Turn開始（`turn/start`）はv0.3の作業のため、現時点でこの経路はプロトコル
レベルの統合テストで検証済みだが、デッキから始めたTurnでの実地検証は未了。

### 残課題

- 実機検証（[`DEVICE_TEST.md`](./DEVICE_TEST.md) §3.4 / §3.5）
- v0.4 の残り（Plan Progress / Diff Summary / Session Manager強化）

---

## 9. v0.2 残項目 と v0.3 — Voice / Vision

v0.2 の Prompt Dial / Clipboard → AI と、v0.3 の Push-to-Talk / Voice Steer /
Screenshot → AI を実装した。

### 前提 — Agentへテキストを送る経路

v0.3 の入力はすべて「Agentへ何かを届ける」ので、まずその経路を作った。

| 状況                  | メソッド       | 備考                              |
| --------------------- | -------------- | --------------------------------- |
| Turnが走っている      | `turn/steer`   | `expectedTurnId` が必須の事前条件 |
| Idle                  | `turn/start`   | 応答の `turn.id` をSessionへ反映  |
| 送り先のSessionが無い | `thread/start` | Active Projectの `cwd` で開く     |

`expectedTurnId` があるおかげで、「デッキが状態を読んでから要求が届くまでの間に
Turnが終わっていた」場合は前提条件エラーになり、別の場所へ紛れ込まない。

### 設計差異 4 — `steer` のシグネチャ

設計書 §8.1 は `steer?(sessionId: string, text: string)` としているが、
Screenshot → AI（§15.1）は画像を添える必要がある。`AgentInput`
（`{ text?, imagePaths? }`）へ広げた。メソッドを2つ並べるより、デッキが
掴んだものを1つの型で運ぶほうが読みやすいと判断した。

Codex側は `UserInput` の `text` / `localImage` バリアントへ写像する。

### Prompt Preset

設計書 §14 のとおり、Promptはキーを増やさずDialで選ぶ。Preset は
「テンプレート＋入力元＋送り先」で、Push-to-Talk も Screenshot → AI も
同じPresetを通す。送り先が3種（active-session / new-session / clipboard）
あるので、§13.4 の Target Action もこれで賄える。

テンプレートに `{{input}}` が無い場合でも入力は捨てずに末尾へ付ける。
ユーザーが編集したPresetでプレースホルダを書き忘れたとき、コピーした内容が
黙って消えるほうが問題だと考えた。

### Desktop adapter — 1か所に閉じる

Clipboard / Screenshot / Voice はいずれもNodeにバインディングが無いWindows APIを
使うため、`src/adapters/desktop/host-shell.ts` 1か所からPowerShellを呼ぶ。
スクリプトは引数配列で渡し、可変値は**環境変数経由**でスクリプト本文へ
文字列連結しない（コマンド化を構造的に防ぐ）。

CI環境にはWindowsもディスプレイもマイクも無いため、**スクリプト本体は未検証**。
テストできる部分（プラットフォーム判定・上限・一時ファイルの寿命・
ログに内容が出ないこと）は自動テストで担保している。

### Voice — ローカル認識のみ

設計書 §22.3 は「Local STT利用時は外部送信しない / Remote STT時は設定画面で明示する」
と定める。実装は Windows 標準の `System.Speech`（ローカル）だけを持つため、
明示すべきRemote STTがそもそも無い。音声も認識テキストもディスクに書かず、
ログにも出さない（指示書 §11 "Voice raw data"）。

Push-to-Talk は**押している間だけ**録音する。トグルにしなかったのは §22.3 の
「録音停止状態を常に確認可能」のためで、2回目の押下を取りこぼして録音が
続く状態を作れないようにした。

### 検出した不具合

- **Preset名がキーからはみ出す。** `Debug Screen` は11文字で切ると
  `Debug Scre…` になり、しかも26pxでは144pxのキーに収まらない。折り返し →
  縮小 → それでも入らなければ切り詰め、の順に直した。`fitFontSize` だけでは
  最小サイズで頭打ちになり、`Internationalisation` のような1語が
  はみ出したままになる。
- **Touch Strip の Prompt detail が切れる。** `2/10 · clipboard → agent` は
  200px幅に入らない。位置表示をタイトル側（`PROMPT 2/10`）へ移した。
- **Dashboard の再描画対象リストが二重管理だった。** 実装とテスト用ランタイムで
  別々に持っていたため、`voice` を追加したときテスト側だけ古いままになった。
  `DASHBOARD_CONCERNS` として1か所へ出し、両方が同じ配線を使うようにした。

### 制約（過大評価しないための注記）

- Push-to-Talk / Screenshot は**実機未検証**。ロジックは自動テスト済みだが、
  PowerShellスクリプトが意図どおり動くかは [`DEVICE_TEST.md`](./DEVICE_TEST.md)
  §3.7 / §3.8 が初回検証になる。
- `inputSource: "selection"` は Ctrl+C を送って読む方式のため、前面アプリが
  コピーに対応していることが前提。対応していなければ空になる。
- Windows 以外では desktop adapter は `NOT_CONFIGURED` を返し、キーは
  `SETUP` 相当のアラートになる（Pluginは動き続ける）。

---

## 10. v0.4 残項目 — Plan Progress / Diff Summary / Session Manager

これでロードマップ v0.4 までの全項目が実装済みになった。

### Plan Progress

Codex の `plan` ThreadItem は**構造化されたステップではなく自由テキスト**で、
かつ upstream で EXPERIMENTAL と明記されている。実際の描画は markdown の
チェックリストなので、チェックリスト行だけを数える。

チェックボックスが1つも無いテキストは「プランではない」と判断して
`undefined` を返す。`Plan 0/0` をキーに出すのは、意味のない数字を
置くことになるため。

新しいTurnが始まったら `plan` と `diff` を落とす。前のTurnの `Plan 4/4` が
次のTurn中も表示され続ける状態を作らないため。

`Plan 2/4` は Touch Strip の detail 行に出す（設計書 §6.1）。キーの detail 行は
経過時間が使う（§12.1）ので、両方が必要なときは `02:18 · Plan 2/4` と並べる。

### Diff Summary — 2種類ある

設計書は `DiffSummary` を §16（Git Integration）の §16.2 に置きつつ、
`AgentSession` にも `diff?` を持たせている。これは別物なので両方実装した。

| 出所                                    | 意味                   | 表示先            |
| --------------------------------------- | ---------------------- | ----------------- |
| `git diff --numstat HEAD`               | 作業ツリー全体の変更量 | Diff キー/Segment |
| Codex `fileChange` item の unified diff | そのAgentが加えた変更  | Session Segment   |

`DiffSummary` の定義は `domain/git.ts` へ置いた。git だけで生成できる概念で、
実際そちらが主経路のため。

**Untracked は含めない。** `git diff` はそもそも見ないし、デッキには既に
`U:` として出ている。二重に数えるより、片方に寄せて説明できるほうがよい。

**diff が読めなくてもブランチは失わない。** `git diff --numstat` が失敗しても
`getStatus` は status を返す。Git キーの存在理由はブランチと件数であって、
diff の欠落でそれを失うのは割に合わない。

**「変更なし」と「読めなかった」を区別する。** 前者は `+0 -0 · clean`、
後者は減光した `no diff`。同じ見た目にすると、git が壊れていることに
気づけなくなる。

### Session Manager

設計書 §6.1 の Dial 2（回転=Session切替 / 押下=Active Session選択）を実装した。
Model selector と同じ「回転はハイライト移動、押下で確定」の形にしている。
デッキの脇を通るときにダイヤルに触れただけで STOP の対象が変わってしまう、
という事態を作らないため。

pin 済みのSessionをもう一度押すと pin が解除され、「最も忙しいSession」へ戻る。
設定画面へ行かずに戻れる導線が要るため。

pin 中のSessionが消えた場合は pin もハイライトも落とす。

### 検出した不具合

- **Segment順に依存したテストが2回壊れた。** `SEGMENT_KINDS` に項目を足すたび、
  「agent の次は model」と決め打ちしたテストが落ちる。回転テストは
  `cycleSegment` の結果と突き合わせる形に変えた（順序そのものは
  `cycleSegment` 自身のテストが担保する）。

### 残課題

- 実機検証（[`DEVICE_TEST.md`](./DEVICE_TEST.md)）— v0.3 / v0.4 の
  Push-to-Talk・Screenshot は実機が初回検証
- v1.0 に向けた項目（設定Migration / Installer / Marketplace配布）

---

## 11. 全体レビュー（v0.2 – v0.4）

3コミット分（99ファイル / +8159行）を通しでレビューし、12件を修正した。
うち5件は再現テストで確認してから直している。

### 動作に関わるもの

| #   | 内容                                                                                                                                   | 確認方法                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | Session Segment の位置表示（`2/3`）が回転順と別の順序で数えられていた。回転は id 順、表示は挿入順                                      | 再現テストで確認                         |
| 2   | Screenshot Presetを Push-to-Talk / 固定テキストから実行すると、**画像が付かない**まま送られていた                                      | 再現テストで確認                         |
| 3   | `item/started` が確定済みの `Plan n/m` を消していた。startedの時点ではテキストがまだ流れてきていない                                   | 再現テストで確認                         |
| 4   | 認識エンジンが起動直後に落ちても「無音」と同じ結果になり、マイクが無いことに気づけなかった                                             | 再現テストで確認                         |
| 5   | Push-to-Talkのキーを離してから送信まで**約3秒**待たされていた。スクリプトはstdinを読まないので、stdin closeの猶予3秒を丸ごと待っていた | `process-manager` の停止手順を読んで特定 |
| 6   | 1回のTurnで複数ファイルを変更すると、Session の diff が**最後の1ファイル分**しか出ていなかった                                         | パス単位の集計へ変更                     |
| 11  | Plugin終了時に認識プロセスの停止を待っておらず、マイクを掴んだまま残りうる                                                             | 停止順を読んで特定                       |

### 設計との差分

| #   | 内容                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 7   | 設計書 §14「PresetはProperty Inspectorで編集可能とする」が未実装だった。`promptPresets` は読むだけで、書くUIが無かった。JSONエディタを追加し、不正なJSONは保存せず入力中のテキストも消さないようにした |
| 8   | Screenshotの一時ファイルパスがログへ出る経路があった（設計書 §21.2 の禁止項目）                                                                                                                        |

### 実機で効くもの（この環境では検証不能）

| #   | 内容                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------ |
| 9   | Screenshotが**DPI非対応**だった。表示スケール150%の環境では取得画像が切れる。`SetProcessDPIAware` を追加した |

### 品質

| #   | 内容                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------- |
| 10  | `DiffViewModel` がガード後にキャストしていた箇所を type predicate へ                                                       |
| 12  | `setPresets` が毎回再描画していた。global settings はProject追加のたびに書き換わるため、変化が無ければ何もしないようにした |

### レビュー自体の反省

最初に書いた再現テスト（#1）は**通ってしまった**。挿入順 `[c,a,b]` は
ソート順 `[a,b,c]` の巡回シフトなので、位置の集合が一致してしまう。
`[b,a,c]` に変え、「1ステップで表示も1つ進む」ことを検査する形に直した。
再現テストは、直す前に落ちることを確認して初めてテストになる。

---

## 12. 動作確認の準備

### Action層の共通化

11個のKey Actionが同じ30行（appear/settingsで再bind、disappearでrelease、
再描画クロージャの作り直し）を繰り返していた。この重複こそが
「settingsを掴んだまま古い値を描き続ける」不具合の温床だったので、
`RenderedKeyAction` へ寄せた。Actionが書くのは
「どのconcernで再描画するか」と「どう描くか」だけになる。

**456行減。テストは457件そのまま通る。**

この過程で、`GitAction` / `DiffAction` のリポジトリ監視を移し忘れたのを
既存テストが捕まえた。共通化を安全に進められるだけのテストが揃っていた
ということでもある。

### `npm run doctor`

Pluginは設計上、失敗しても静かに縮退する（Codex CLIが無ければキーに `CLI?`
と出るだけ）。デッキの上ではそれが正しいが、原因を追うときには役に立たない。
doctorは**失敗する順番どおりに**前提条件を確認し、何が欠けていて何が
できなくなるかを言う。

| 確認                                                   | 落ちたときの意味                                       |
| ------------------------------------------------------ | ------------------------------------------------------ |
| Node 20.5.1+                                           | Pluginが動かない                                       |
| ビルド済みバンドル2種                                  | `npm run build` 未実行                                 |
| Stream Deck の Plugins フォルダとリンク                | Pluginが認識されていない                               |
| Codex CLI + **app-server ハンドシェイク** + サインイン | `--version` が通ってもapp-serverが古い場合を分離できる |
| git                                                    | Git / Diff キーが `NO GIT`                             |
| PowerShell / System.Speech / マイク                    | Clipboard・Screenshot・Push-to-Talk                    |
| Claude bridge の書き込みと鮮度                         | Claude Usage が `SETUP` / `STALE`                      |

Codexプローブは実際に `initialize` → `initialized` → `account/read` を
往復する。3分岐（正常 / 未サインイン / 無応答）とも、fake app-serverを
`codex` としてPATHに置いて実行確認済み。

### `npm run pack`

`dist/com.agentdeck.streamdeck-plus.streamDeckPlugin`（218KB）を生成する。
ダブルクリックで入るので、チェックアウト無しの環境でも試せる。

#### ここで見つかった不具合

**パッケージに古い `bin/statusline.js` が入っていた。** `.js` → `.mjs` へ
リネームしたとき、古いファイルが出力フォルダに残り、`pack` はフォルダの中身を
そのまま詰めるため installer に同梱されていた。**まさにロードできない
ことが分かっているファイル**が、古いパスを設定したままの利用者向けに
配られる状態だった。ビルド開始時に `bin/` を消すようにした。

生成後のパッケージは、展開して**package.jsonが上位に無い場所**から
`statusline.mjs` を実行して動作確認している（以前same-repoで確認して
取り違えた検証を、今度は成果物そのもので行った）。

---

## 13. 設定を減らす

「Stream Deck 内で設定するものが多い」という指摘への対応。

### 何個設定が要るのかを数えた

Property Inspector の項目を全部数えたところ、**本当に必須なのは1つだけ**
だった。Project のパスである。それ以外は既定値で動く。

そしてその1つが、**Property Inspector の1行テキスト欄に絶対パスを打つ**という、
一番やりたくない形をしていた。

### Codex が答えを持っていた

`thread/settings/updated` 通知は `threadSettings.cwd` を返す。
つまり **Agentが今どこで作業しているかをCodex自身が知っている**。

リポジトリの中で `codex` を起動すれば、AgentDeck はそのディレクトリを
受け取ってProjectとして登録する。手入力は要らなくなった。

`ProjectService.add()` は元からパス冪等で、`#activeProjectId ??=` により
**未設定のときだけ有効化**する。つまり採用しても、ユーザーが選んだProjectを
上書きしない（設計書 §7.5 と同じ考え方）。新しいAPIは足していない。

同じ通知から `model` / `effort` も取れるので、Model ダイヤルが
「そのセッションが実際に使っているモデル」から始まるようにもなった。

### Project の指定をドロップダウンに

自由入力だった「Pin to」を、登録済みProjectの `<select>` にした。
`pi.js` に `data-options-from="<globalSettingsのキー>"` を追加してある。

### Property Inspector に初めてテストを付けた

`pi.js` は Stream Deck 内蔵ブラウザで動くため、これまで**テストが1件も
無かった**。最小のDOMスタブ上で `pi.js` を評価するテストを6件追加した。

作る過程で1つ学びがあった。最初に書いたスタブは
「存在しない値を `<select>` に代入したときの挙動」を実ブラウザと違う形で
モデル化しており、**存在しないバグを報告しかけた**。実ブラウザは未一致の値を
代入すると空に戻すので、元のコードは正しかった。スタブを実挙動に合わせ、
コード側は「optionsを見て判断する」明示的な形に変えた（挙動は同じだが、
暗黙のブラウザ規則に寄りかからずに済む）。

スタブでテストを書くときは、**スタブが実物と同じ規則で動くかを先に確かめる**。
そうでないと、テストしているのは実装ではなくスタブになる。

### 同梱プロファイルは見送り

キー配置ごと配れば設定は0になるが、`.streamDeckProfile` の**バイナリ形式が
確認できなかった**（manifest 側の `Profiles` 仕様は判明済み、
`DeviceType: 7` が Stream Deck +）。検証できないものは同梱しない。

実機で一度配置したあと Stream Deck アプリからプロファイルを書き出せば、
それを同梱する形にできる。実機検証時の宿題とする。
