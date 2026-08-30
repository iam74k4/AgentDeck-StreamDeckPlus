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
  ├─ vitest run         10 files / 160 tests passed
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

## 5. 次段階（v0.1 Control Core）で残っている作業

指示書 §4 に対する残タスク。指示書 §2.2 に従い、本Spikeでは着手していない。

- [ ] Project登録 / 一覧 / Active Project / 切替 / path validation
      （Domain `Project` と `validateProjectPath` は実装済・テスト済。
      `application/project-service.ts` と Project Action が未実装）
- [ ] Git ActionのリポジトリをActive Projectから解決する（現在はAction設定）
- [ ] Touch Strip 第4列を `PROJECT` へ差し替え
- [ ] App Launcher（VS Code / Windows Terminal / Codex CLI / 任意アプリ）
- [ ] Property Inspector から Project を選択できるようにする
- [ ] 実機Device Test（[`DEVICE_TEST.md`](./DEVICE_TEST.md)）

v0.2以降（Claude Usage / Push-to-Talk / Screenshot / Prompt Dial / Approval UI /
Model Selector）はinterface境界のみ用意し、実装していない。
