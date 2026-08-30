# AgentDeck — Claude実装指示書

- 対象リポジトリ: `agentdeck-streamdeck-plus`
- 製品名: **AgentDeck**
- 対象デバイス: Elgato Stream Deck Plus
- MVP OS: Windows 10 / 11
- 言語/ランタイム: TypeScript / Node.js
- SDK: Elgato Stream Deck SDK 2
- 設計書: `AGENTDECK_DESIGN.md`

---

## 1. あなたの役割

あなたは本プロジェクトの **シニアTypeScriptエンジニア兼Stream Deck Pluginアーキテクト** として実装を担当してください。

本プロジェクトは、Claude / Codex等のAI Coding AgentをStream Deck Plusから監視・操作する **ローカルAI Agent Control Deck** です。

単なるUsage Monitorではありません。

中心価値は以下です。

1. Agent状態を常時確認する
2. Agentを物理キーから停止・操作する
3. Project / Sessionを切り替える
4. Git状態を確認する
5. Voice / Prompt等からAgentへ短い指示を送る
6. Claude / CodexのUsageを補助情報として表示する

---

## 2. 最重要ルール

### 2.1 設計書を正本とする

`AGENTDECK_DESIGN.md` をSingle Source of Truthとして扱ってください。

実装判断の優先順位は以下です。

```text
ユーザーからの最新指示
    ↓
AGENTDECK_DESIGN.md
    ↓
既存コード
    ↓
一般的な慣習
```

設計書と既存コードが矛盾する場合は、勝手に既存コードへ合わせず差異を報告してください。

### 2.2 勝手にスコープを広げない

最初から全機能を実装しないでください。

以下の順番を厳守してください。

```text
Technical Spike
    ↓
v0.1 Control Core
    ↓
v0.2 Multi Provider / Workflow
    ↓
v0.3 Voice / Vision
    ↓
v0.4 Advanced Agent Control
```

ユーザーから明示的な指示がない限り、v0.2以降を先行実装しないでください。

### 2.3 Provider固有仕様をCoreへ漏らさない

以下を厳守してください。

```text
Codex schema  ─┐
Claude schema ─┼→ Provider Adapter → Domain Model
Other schema  ─┘
```

Domain / Application / PresentationからCodex・Claude固有JSONを直接参照してはいけません。

### 2.4 Stream DeckをAIクライアント化しない

AgentDeckはControllerです。

以下は原則実装しません。

- 独自Chat UI
- AI回答全文表示
- Diff全文表示
- 独自AI Backend
- 独自Credential管理

長い情報はPC側のClaude / Codex / VS Code等へ委譲してください。

### 2.5 Safe by Default

Agent承認やShell実行を扱う場合、安全性を利便性より優先してください。

- `Always Approve` を実装しない
- デフォルトは `Approve Once`
- High Risk操作はHold to Approve
- Token / API Key / OAuth credentialをログ出力しない
- Full Prompt / Clipboard内容はデフォルトでログ出力しない

---

## 3. 最初に実施すること

コードを書き始める前に以下を行ってください。

### Step 1 — Repository確認

確認対象:

- ディレクトリ構成
- `package.json`
- Stream Deck Plugin scaffoldの有無
- TypeScript設定
- ESLint / Prettier / Test framework
- `.gitignore`
- manifest

不足があれば最小構成を提案・作成してください。

### Step 2 — 設計書確認

`AGENTDECK_DESIGN.md` を全体確認し、以下を把握してください。

- Domain Model
- Provider Registry
- Codex App Server接続方式
- Stream Deck Plus UI構成
- Project / Session / Providerの責務分離
- Error / Security要件
- Technical Spike成功条件

### Step 3 — Technical Spike計画

本実装の前に、以下のSpikeを優先してください。

#### Spike A — Codex

検証項目:

- `codex app-server --stdio` 起動
- JSONL read/write
- JSON-RPC request/response correlation
- `initialize`
- `initialized` notification
- `account/rateLimits/read`
- `account/rateLimits/updated`
- Turn state event
- `turn/interrupt`

#### Spike B — Stream Deck Plus

検証項目:

- Dynamic Key image
- Encoder Action
- Custom layout / `setFeedback`
- Touch Strip描画
- 4 Encoder context管理
- `willAppear` / `willDisappear`

#### Spike C — Git

検証項目:

- branch
- modified / staged / untracked
- ahead / behind
- 非Gitディレクトリ時のfailure handling

### Technical Spike成功条件

最低限、実機Stream Deck Plus上で以下が成立すること。

```text
CODEX
● WORKING / IDLE
Usage xx%
```

かつ、実行中Turnに対し `STOP` キーからInterruptできること。

---

## 4. v0.1で実装する範囲

Technical Spike成功後、以下のみをv0.1として実装してください。

### Codex

- Codex App Server lifecycle
- Usage取得
- Usage更新イベント
- Agent Status
- Session認識
- Turn Interrupt

### Project

- Project登録
- Project一覧
- Active Project
- Project切替
- Project path validation

### Git

- Branch
- Modified
- Staged
- Untracked
- Ahead / Behind

### Launcher

- VS Code
- Windows Terminal
- Codex CLI
- 任意アプリ起動の基盤

### Stream Deck Plus

- Agent Status Action
- Stop Action
- Usage Action
- Git Action
- Project Action
- App Launcher Action
- Encoder / Touch Strip対応
- Property Inspector最小版

---

## 5. v0.1で実装しないもの

以下は設計だけ保持し、コードを先行実装しないでください。

- Claude Usage
- Claude Agent control
- Push-to-Talk
- Whisper/STT
- Screenshot → AI
- Clipboard → AI
- Prompt Dial
- Approval UI
- Model / Reasoning selector
- Plan Progress
- Diff Summary
- 高度なSession Manager

ただし将来追加できるようinterface境界は維持してください。

---

## 6. 推奨アーキテクチャ

以下の依存方向を守ってください。

```text
Presentation
    ↓
Application
    ↓
Domain
    ↑
Infrastructure / Providers / Adapters
```

DomainからStream Deck SDKやCodex JSON-RPCへ依存してはいけません。

### 推奨構成

```text
src/
├─ plugin.ts
├─ domain/
├─ application/
├─ actions/
├─ providers/
│  └─ codex/
├─ adapters/
│  ├─ git/
│  └─ launcher/
├─ presentation/
├─ infrastructure/
├─ generated/
│  └─ codex/
└─ property-inspector/
```

詳細は設計書を参照してください。

---

## 7. Codex App Server実装ルール

### 7.1 Handshake

必ず以下の順番にしてください。

```text
spawn codex app-server --stdio
        ↓
initialize request
        ↓
initialize response
        ↓
initialized notification
        ↓
各API request
```

`initialized` 前にaccount/thread/turn APIを呼ばないでください。

### 7.2 Transport

stdioはJSONLとして扱います。

責務を分けてください。

```text
ProcessManager
   ↓
JsonRpcTransport
   ↓
AppServerClient
   ↓
CodexProvider
   ↓
Domain Mapper
```

### 7.3 Push Event

Pollingだけで実装しないでください。

利用可能なCodex notificationはProvider Eventへ変換してApplication Layerへpushします。

例:

```text
account/rateLimits/updated
        ↓
CodexProvider
        ↓
usage-updated
        ↓
UsageService
        ↓
Affected UI only redraw
```

### 7.4 Sparse Update

Rate Limit更新はfull snapshotとは限らないため、既存Snapshotにmergeしてください。

部分更新の欠落フィールドで既存値を消さないでください。

### 7.5 Lifecycle

最低限以下を管理してください。

```text
STOPPED
STARTING
INITIALIZING
READY
BACKOFF
STOPPING
```

Process crash時にPlugin全体を落とさないでください。

---

## 8. Stream Deck Plus実装ルール

### 8.1 Keys = 操作

8 Keysは原則としてActionに使用します。

例:

```text
┌────────┬────────┬────────┬────────┐
│ Agent  │ STOP   │Launch  │Refresh │
├────────┼────────┼────────┼────────┤
│Project │  Git   │ Usage  │Status  │
└────────┴────────┴────────┴────────┘
```

### 8.2 Touch Strip = 状態

長文を表示しないでください。

例:

```text
┌──────────┬──────────┬──────────┬──────────┐
│ USAGE    │ AGENT    │ GIT      │ PROJECT  │
│ 41%      │ WORKING  │ main M:4 │ Game     │
└──────────┴──────────┴──────────┴──────────┘
```

### 8.3 4 Encoder管理

Encoder Contextはdevice単位で管理してください。

```ts
Map<DeviceId, Map<Column, EncoderContext>>
```

- `willAppear` → register
- `willDisappear` → unregister

4つ揃わない場合はStandalone Segment Modeへfallbackしてください。

---

## 9. State管理

UI Action自身にProvider stateを持たせないでください。

```text
Provider
   ↓
Application Service
   ↓
Store / Cache
   ↓
Action ViewModel
   ↓
Renderer
```

### Usage

- shared cache
- single-flight refresh
- stale snapshot保持

### Session

Active SessionとProjectを分離してください。

### UI

Provider Event受信時に全Actionを再描画せず、影響するActionだけ更新してください。

---

## 10. Error Handling

ユーザー向け表示は短くします。

```text
LOGIN
CLI?
STALE
ERROR
OFFLINE
```

内部ではtyped errorを使ってください。

例:

```ts
type AgentDeckErrorCode =
  | "CLI_NOT_FOUND"
  | "PROVIDER_OFFLINE"
  | "INITIALIZATION_FAILED"
  | "NOT_AUTHENTICATED"
  | "RATE_LIMITED"
  | "INVALID_PROJECT"
  | "GIT_NOT_REPOSITORY";
```

文字列比較によるエラー分岐を増やさないでください。

---

## 11. Logging / Security

ログに含めてはいけないもの:

- OAuth Token
- API Key
- Authorization Header
- Full Prompt
- Full Clipboard content
- Voice raw data
- Screenshot内容

Debug loggingでもcredentialは必ずredactしてください。

MVPではTelemetryを追加しないでください。

---

## 12. Testing

### Unit

最低限:

- Usage mapper
- Usage Window selection
- Sparse update merge
- Session reducer
- Project validation
- Git parser
- Error mapping

### Integration

- Codex process lifecycle
- JSON-RPC handshake
- request/response correlation
- notification handling
- process crash recovery
- Git Adapter

### Device

Stream Deck Plus実機で:

- Key update
- Encoder rotate / press
- Touch Strip
- Profile切替
- Device reconnect
- Plugin restart

---

## 13. 実装時の進め方

各作業単位で以下の順序を守ってください。

```text
1. 対象仕様を確認
2. 変更対象を特定
3. 最小実装
4. Unit Test
5. Build / Lint
6. 必要なら実機検証
7. 結果を報告
```

大規模な一括変更より、小さく検証可能な変更を優先してください。

---

## 14. 設計変更が必要な場合

以下の場合は勝手に設計変更せず報告してください。

- Codex App Server仕様と設計書が矛盾
- Stream Deck SDK制約により設計不能
- Security上の問題
- v0.1要件を満たすためにDomain変更が必要
- 既存コードとの重大な不整合

報告フォーマット:

```markdown
## 設計差異

### 現行設計
...

### 実際の制約
...

### 推奨変更
...

### 影響範囲
...
```

軽微な内部実装詳細はClaude側で合理的に判断して構いません。

---

## 15. 完了条件 — v0.1

以下をすべて満たしたらv0.1実装完了です。

- [ ] Stream Deck Pluginとして起動する
- [ ] Stream Deck Plusが認識される
- [ ] Codex App Serverへ接続できる
- [ ] initialize handshakeが正常
- [ ] Codex Usageが表示される
- [ ] Agent状態が表示される
- [ ] 実行中TurnをSTOPできる
- [ ] Projectを登録・切替できる
- [ ] Git branch/statusが表示される
- [ ] App Launcherが動作する
- [ ] Provider停止時もPluginが落ちない
- [ ] Credentialがログに出ない
- [ ] Unit / Integration Testが通る
- [ ] TypeScript buildが通る

---

## 16. 最初の依頼

まずコード実装を大量に始めず、以下を行ってください。

1. リポジトリ全体を確認する
2. `AGENTDECK_DESIGN.md` を読む
3. 現状構成と設計書との差分を整理する
4. Technical Spikeに必要な最小実装計画を作る
5. **Spike A: Codex App Server接続** から着手する
6. 各変更後に検証結果を報告する

最初のゴールは、**Stream Deck Plus実機上にCodexのUsage / Agent Statusを表示し、STOPキーで実行中Turnを中断できること**です。

それが成立するまでは、Voice / Claude / Approval等へスコープを広げないでください。
