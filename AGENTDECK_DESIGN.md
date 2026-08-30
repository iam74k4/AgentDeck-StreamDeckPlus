# AgentDeck for Stream Deck Plus — 基本設計書

- 文書種別: 基本設計書
- 文書バージョン: 1.0
- 作成日: 2026-08-30
- 対象デバイス: Elgato Stream Deck Plus
- MVP対象OS: Windows 10 / 11
- 実装想定: TypeScript / Node.js / Stream Deck SDK 2
- 対象AI: OpenAI Codex / Claude Code / ChatGPT / Claude Desktop
- 製品名: AgentDeck
- リポジトリ名: agentdeck-streamdeck-plus

---

## 1. 目的

AgentDeckは、Stream Deck PlusをAI Coding Agentの「物理コントロールデッキ」として利用するための統合Pluginである。

単なるAI利用量モニターではなく、以下を一つの操作面に統合する。

- AI Agentの状態監視
- AI利用制限・Usage監視
- Agentの停止・追加指示・承認
- Push-to-Talk / Dictation
- Prompt Preset実行
- Screenshot / ClipboardからAIへの入力
- Project / Session切替
- Git状態監視
- Claude / ChatGPT / Codex等のアプリ・CLI起動

Stream Deck側では「詳細を読む」のではなく、以下に特化する。

1. 状態を一目で把握する
2. 対象を選択する
3. 短い指示を入力する
4. 重要な意思決定を行う
5. 詳細画面へ遷移する

---

## 2. プロダクトコンセプト

### 2.1 旧コンセプト

> AI Usage Monitor for Stream Deck Plus

### 2.2 新コンセプト

> Stream Deck PlusからAI Coding Agentを監視・操作するローカルコントロールデッキ

### 2.3 中心価値

本Pluginの中心価値は「Usage表示」ではなく、AI AgentとStream Deck間の双方向操作にある。

```text
AI Agent
   ↑ ↓
AgentDeck
   ↑ ↓
Developer
```

Usageは常時表示されるDashboard情報の一つとして扱う。

---

## 3. 設計原則

### 3.1 Controller First

Stream Deck自体を独自AIクライアントにはしない。

Claude / Codex / ChatGPTなど既存Client・Agentを操作するControllerに徹する。

### 3.2 Local First

Git状態、Project情報、Process状態、CLI状態などローカルで取得可能な情報はローカル処理を優先する。

Plugin独自クラウドサーバーはMVPでは持たない。

### 3.3 Provider Isolation

AI Provider固有API・CLI仕様はProvider Adapter内部へ隔離する。

UI / Core DomainからClaude / Codex固有schemaを参照しない。

### 3.4 Project / Session / Providerを分離

```text
Project
   │
   ├── AgentSession A ── CodexProvider
   ├── AgentSession B ── ClaudeProvider
   └── GitContext
```

「どのリポジトリか」「どのAgentセッションか」「どのAI Providerか」を別概念として管理する。

### 3.5 Stream Deckは要約と意思決定に使う

表示する情報は短くする。

例:

```text
CODEX
● WORKING
Plan 2/4
+142 -38
```

コード全文、Diff全文、長文回答などはPC側UIへ遷移して確認する。

### 3.6 Safe by Default

Approve / Deny、Shell実行、ファイル変更等は誤操作を前提に安全設計する。

- 危険操作のApproveは長押し
- MVPはApprove Onceのみ
- Always ApproveはStream Deckから提供しない
- Token / Credentialは画面・ログに出さない

---

## 4. 機能カテゴリ

```text
AgentDeck
│
├─ Monitor
│  ├─ Usage
│  ├─ Agent Status
│  ├─ Session Token Usage
│  ├─ Plan Progress
│  ├─ Diff Summary
│  └─ Git Status
│
├─ Control
│  ├─ Stop / Interrupt
│  ├─ Approve / Deny
│  ├─ Steer
│  └─ Model / Reasoning Selection
│
├─ Input
│  ├─ Push-to-Talk
│  ├─ Dictation
│  ├─ Screenshot
│  └─ Clipboard / Selection
│
├─ Workflow
│  ├─ Prompt Preset
│  ├─ Review
│  ├─ Explain
│  ├─ Refactor
│  └─ Test Generation
│
└─ Environment
   ├─ Project Launcher
   ├─ Session Selector
   ├─ App Launcher
   └─ Git Context
```

---

## 5. MVPスコープ

### 5.1 v0.1

最初の公開可能ライン。

#### Codex

- Codex App Server接続
- Account / Usage取得
- Agent Running / Idle / Done / Error表示
- Turn停止
- Session認識

#### Local

- Project登録
- Project切替
- Git Branch
- Modified / Staged件数
- Ahead / Behind
- App Launcher
- Manual Refresh

#### Stream Deck Plus

- 8 LCD Keys
- 4 Encoder
- Touch Strip
- Property Inspector

### 5.2 v0.2

- Claude Usage Provider
- Claude / Codex統合Overview
- Prompt Dial
- Clipboard → AI
- Provider Summary

### 5.3 v0.3

- Push-to-Talk
- Dictation
- Voice Steer
- Screenshot → AI

### 5.4 v0.4

- Approval UI
- Model / Reasoning selector
- Plan Progress
- Diff Summary
- Session Manager強化

### 5.5 MVP対象外

- 独自Chat UI
- AI回答本文表示
- Diff全文表示
- 自動Approve
- Always Approve
- 独自クラウド同期
- 複数PC同期
- 独自課金
- Provider API Keyの独自管理
- Realtime Voiceの常時ストリーミング

---

## 6. Stream Deck Plus UI設計

### 6.1 推奨デフォルトProfile

#### LCD Keys

```text
┌────────┬────────┬────────┬────────┐
│ Agent  │ STOP   │ Voice  │Approve │
│● Codex │        │  MIC   │   OK   │
├────────┼────────┼────────┼────────┤
│ Screen │ Prompt │  Git   │Project │
│  Ask   │ Review │ M: 4   │ Game   │
└────────┴────────┴────────┴────────┘
```

#### Touch Strip

```text
┌──────────┬──────────┬──────────┬──────────┐
│ USAGE    │ AGENT    │ MODEL    │ PROJECT  │
│ C 42%    │ WORKING  │ HIGH     │ Game     │
│ X 61%    │ Plan 2/4 │ GPT-x    │ main M:4 │
└──────────┴──────────┴──────────┴──────────┘
```

#### Dials

| Dial | 既定用途 | 回転 | 押下 |
|---|---|---|---|
| 1 | Usage / Monitor | Window / View切替 | Refresh |
| 2 | Session | Session切替 | Active Session選択 |
| 3 | Prompt / Model | PromptまたはModel切替 | 実行 / 確定 |
| 4 | Project | Project切替 | Project Activate |

### 6.2 Encoder描画

Stream Deck PlusのEncoderは1つにつき200x100のTouch Strip領域を持つ。

4 Encoderを本Pluginで占有する場合は `PlusDashboardCoordinator` が各領域を協調更新し、視覚的に1枚のDashboardとして見せる。

```text
Device
 └─ Encoder Contexts
    ├─ Col 0
    ├─ Col 1
    ├─ Col 2
    └─ Col 3
```

管理キー:

```ts
type DeviceId = string;
type Column = 0 | 1 | 2 | 3;

Map<DeviceId, Map<Column, EncoderContext>>
```

`willAppear`で登録し、`willDisappear`で解除する。

4枠すべて揃っていない場合はStandalone Segment Modeへフォールバックする。

---

## 7. Core Domain Model

### 7.1 Project

```ts
interface Project {
  id: string;
  name: string;
  path: string;

  preferredProviderId?: string;
  preferredModelId?: string;

  commands?: {
    start?: string;
    build?: string;
    test?: string;
  };
}
```

ProjectはローカルディレクトリとAI作業コンテキストを結びつける中心概念とする。

### 7.2 AgentSession

```ts
type AgentSessionState =
  | "idle"
  | "starting"
  | "working"
  | "waiting-approval"
  | "completed"
  | "error"
  | "disconnected";

interface AgentSession {
  id: string;
  providerId: string;
  projectId?: string;

  state: AgentSessionState;
  startedAt?: Date;
  updatedAt: Date;

  currentTurnId?: string;
  modelId?: string;
  reasoningLevel?: string;

  plan?: PlanSummary;
  diff?: DiffSummary;
  tokenUsage?: SessionTokenUsage;
}
```

### 7.3 UsageWindow

制限枠は5h / 7dへ固定しない。

```ts
interface UsageWindow {
  id: string;
  label: string;
  usedPercent: number;
  windowDurationMinutes?: number;
  resetsAt?: Date;
}
```

Remainingは保持せず、描画時に計算する。

```ts
remainingPercent = Math.max(0, 100 - usedPercent);
```

表示barのみ0-100へclampし、raw usedPercentは保持可能とする。

### 7.4 UsageSnapshot

```ts
type ProviderStatus =
  | "ready"
  | "loading"
  | "stale"
  | "login-required"
  | "cli-not-found"
  | "rate-limited"
  | "error";

interface UsageSnapshot {
  providerId: string;
  status: ProviderStatus;
  fetchedAt: Date;
  lastSuccessAt?: Date;
  windows: UsageWindow[];
  error?: UsageError;
}
```

### 7.5 Window Selection

```ts
type WindowSelection =
  | { mode: "auto" }
  | { mode: "pinned"; windowId: string };
```

Auto:
- 利用可能なWindowへ追従
- Overviewでは原則「最も逼迫しているWindow」を採用

Pinned:
- 指定Windowが消えた場合は `--` 表示
- 自動差替えしない

---

## 8. アーキテクチャ

```text
Stream Deck SDK
      │
      ├─ Key Actions
      ├─ Encoder Actions
      ├─ Touch Strip
      └─ Property Inspector
            │
            ▼
      Presentation Layer
            │
            ▼
       Application Layer
      ┌─────┼──────────────┐
      │     │              │
Session  Project        Usage
Service  Service        Service
      │     │              │
      └─────┼──────────────┘
            ▼
        Domain Layer
      Project / Session
      Usage / Approval
            │
            ▼
     Infrastructure Layer
 ┌────────┬────────┬────────┬────────┐
 │ Codex  │ Claude │  Git   │ Voice  │
 │Provider│Provider│Adapter │Adapter │
 └────────┴────────┴────────┴────────┘
```

### 8.1 Provider Registry

ProviderIdはunion型へ固定しない。

```ts
type ProviderId = string;

interface AgentProvider {
  readonly id: ProviderId;
  readonly displayName: string;

  isAvailable(): Promise<boolean>;
  start(): Promise<void>;
  stop(): Promise<void>;

  listSessions?(): Promise<AgentSession[]>;
  interrupt?(sessionId: string): Promise<void>;
  steer?(sessionId: string, text: string): Promise<void>;
  getModels?(): Promise<ModelDescriptor[]>;

  subscribe(listener: ProviderEventListener): () => void;
}
```

```ts
ProviderRegistry.register(new CodexProvider());
ProviderRegistry.register(new ClaudeProvider());
```

---

## 9. Codex Provider設計

### 9.1 接続方式

MVPは `codex app-server --stdio` を利用する。

stdio上のJSON-RPCとして接続する。

### 9.2 初期化フロー

```text
spawn codex app-server --stdio
        ↓
initialize request
        ↓
initialize response
        ↓
initialized notification
        ↓
account/read
account/rateLimits/read
        ↓
READY
```

初期化前リクエストは送らない。

### 9.3 使用API

安定APIを優先する。

- account/read
- account/rateLimits/read
- account/rateLimits/updated
- account/usage/read（利用可能時）
- thread/start / thread/read / thread/list
- turn/start
- turn/interrupt
- turn/steer
- model/list
- turn/started
- turn/completed
- item/started
- item/completed

Experimental APIはMVPの必須要件にしない。

### 9.4 Sparse Update

`account/rateLimits/updated` は部分更新として扱う。

```text
Last Full Snapshot
        +
Sparse Update
        ↓
Merged Snapshot
```

不明値で既存値を消さない。

### 9.5 Lifecycle

```text
STOPPED
   ↓
STARTING
   ↓
INITIALIZING
   ↓
READY
   ↓ error
BACKOFF
   ↓
STARTING
```

終了時:

```text
Plugin Shutdown
  ↓
stdin close
  ↓
process terminate
  ↓ timeout
force kill
```

### 9.6 型生成

Codex App Serverが提供するschema generationを利用可能な場合、Codex protocol型を手書きしない。

```text
codex app-server generate-ts
        ↓
src/generated/codex/
```

Provider側でDomain Modelへ変換する。

---

## 10. Claude Provider設計

### 10.1 方針

Claude側は公開・安定したUsage APIが保証されない可能性を前提にする。

Claude固有のUsage取得処理はProvider内部へ完全隔離する。

```text
Claude Raw Response
      ↓
ClaudeUsageParser
      ↓
UsageSnapshot
```

### 10.2 Parser

```ts
interface ClaudeUsageParser {
  parse(raw: unknown): UsageWindow[];
}
```

Schema変更に備えfixtureベースのunit testを用意する。

### 10.3 Credential

- 読み取り専用
- TokenをPlugin設定へコピー保存しない
- Tokenをログへ出さない
- Credential更新はClaude公式Clientへ任せる

### 10.4 Claude Desktop Launcher

Claude Desktopの公式 `claude://` deep linkを利用可能な場合はOS shell経由で起動する。

用途:

- New Chat
- Cowork
- Code

フォルダ・ファイルを渡す場合はClaude側の確認UIを尊重する。

---

## 11. ChatGPT / App Launcher設計

App Launcherは差別化機能ではなくEnvironment Utilityとして提供する。

対象例:

- ChatGPT Desktop
- Claude Desktop
- VS Code
- Windows Terminal
- Codex CLI
- Claude Code

```ts
interface AppLauncher {
  id: string;
  displayName: string;
  isInstalled(): Promise<boolean>;
  launch(context?: LaunchContext): Promise<void>;
}
```

Project Launcherから一括起動できる構成を優先する。

例:

```text
Project Activate
   ↓
VS Code(project)
Terminal(project)
Preferred Agent(project)
Git Context load
```

---

## 12. Agent Status / Control

### 12.1 Status

キー表示例:

```text
CODEX
● WORKING
02:18
```

状態:

- IDLE
- STARTING
- WORKING
- WAITING APPROVAL
- DONE
- ERROR
- DISCONNECTED

### 12.2 Stop / Interrupt

実行中のAgentへInterruptを送る。

```text
[ STOP ]
   ↓
Active Session
   ↓
Provider.interrupt()
```

対象Sessionが存在しない場合はdisabled表示。

### 12.3 Steer

実行中Agentへ追加指示を送る。

入力元:

- Voice
- Clipboard
- Prompt Preset
- Property Inspector text

### 12.4 Approval

承認要求をSessionへ紐付ける。

```ts
interface ApprovalRequest {
  id: string;
  sessionId: string;
  type: "command" | "file-change" | "other";
  title: string;
  summary: string;
  risk: "low" | "medium" | "high";
}
```

UI:

```text
┌────────┬────────┐
│ HOLD   │  DENY  │
│APPROVE │        │
└────────┴────────┘
```

High riskはApproveキー長押し必須。

MVPでは:

- Approve Once
- Deny

のみ対応する。

---

## 13. Voice Input設計

### 13.1 抽象化

```ts
interface VoiceInputProvider {
  start(): Promise<void>;
  stop(): Promise<VoiceResult>;
}

interface VoiceResult {
  text: string;
  durationMs: number;
}
```

### 13.2 Provider候補

```text
VoiceInputProvider
├─ WindowsDictationProvider
├─ LocalWhisperProvider
└─ RemoteSttProvider
```

### 13.3 MVP

v0.1/v0.2ではWindows Dictation起動を簡易導線として利用可能。

本格Push-to-Talkはv0.3。

### 13.4 Push-to-Talk UX

```text
Key Down
  ↓
Recording
  ↓
Touch Strip: LISTENING
  ↓
Key Up
  ↓
Transcribe
  ↓
Target Action
```

Target Action:

- Clipboardへコピー
- Active AgentへSteer
- New Promptとして送信

---

## 14. Prompt Preset

Promptは固定キーを大量に作らない。

Dial Selectorを基本とする。

例:

```text
Explain
Review
Refactor
Test
Security
Performance
Custom
```

```ts
interface PromptPreset {
  id: string;
  name: string;
  template: string;
  inputSource: "clipboard" | "selection" | "screenshot" | "none";
  target: "active-session" | "new-session" | "clipboard";
}
```

PresetはProperty Inspectorで編集可能とする。

---

## 15. Screenshot / Clipboard Input

### 15.1 Screenshot

Capture mode:

- Active Window
- Full Screen
- Selected Region（将来）

Preset例:

- Explain Screen
- Debug Screen
- Review UI

Stream Deckにはスクリーンショット自体を常時保持しない。

一時ファイルは処理終了後削除可能な設計とする。

### 15.2 Clipboard

```text
Selection
  ↓ copy
Clipboard
  ↓
Prompt Template
  ↓
Target Agent
```

Clipboardの内容が巨大な場合は上限を設ける。

---

## 16. Git Integration

GitはAI Provider非依存のCore機能とする。

### 16.1 表示

- Branch
- Modified
- Staged
- Untracked
- Ahead
- Behind

Touch Strip例:

```text
main | M:4 | S:2 | U:1 | ↑1 ↓0
```

### 16.2 Diff Summary

Stream Deckには要約のみ表示する。

```text
+183
-42
7 files
```

詳細はVS Code等のDiff画面を開く。

### 16.3 Polling

Project active時のみ低頻度pollingする。

Agentが更新イベントを返せる場合は、そのイベントを契機にGit refreshする。

---

## 17. Usage Service

### 17.1 Shared Cache

複数ActionからProviderへ同時アクセスしない。

```text
Provider
   ↓
UsageService
   ↓
Snapshot Cache
 ┌─┼─────────────┐
Key Dial Overview
```

### 17.2 Single-flight

同じProviderへの同時refresh要求は1リクエストへ統合する。

### 17.3 状態遷移

```text
fetch success
  → READY

fetch failure + cacheあり
  → STALE

fetch failure + cacheなし
  → ERROR

credential invalid
  → LOGIN_REQUIRED

CLI missing
  → CLI_NOT_FOUND
```

### 17.4 Refresh設定

通信設定はAction単位ではなくProvider / Global設定で管理する。

#### Provider Settings

- Claude Refresh Interval
- Codex Health Check Interval
- Executable override

#### Action Settings

- Provider
- Window Selection
- Display Mode
- Threshold
- Reset Display

---

## 18. Overview表示

Claude / Codexを単純合算しない。

`AI Total`という概念は使わず `AI Overview` とする。

Autoモードでは各Providerの「最も逼迫しているWindow」を代表値として表示する。

例:

```text
AI OVERVIEW
Claude 96% 7d
Codex  41% 5h
```

---

## 19. Model / Reasoning Selector

モデル一覧をハードコードしない。

```ts
interface ModelDescriptor {
  id: string;
  label: string;
  capabilities?: string[];
  reasoningLevels?: string[];
}
```

Providerが`getModels()`を提供する場合は動的取得する。

Dial:

```text
Rotate → Model / Effort
Press  → Apply
```

Providerが未対応の場合はActionをdisabledにする。

---

## 20. Event Model

### 20.1 Provider Event

```ts
type ProviderEvent =
  | { type: "usage-updated"; snapshot: UsageSnapshot }
  | { type: "session-updated"; session: AgentSession }
  | { type: "approval-requested"; request: ApprovalRequest }
  | { type: "approval-resolved"; approvalId: string }
  | { type: "provider-status"; status: ProviderStatus };
```

ProviderはEventをApplication Layerへpushする。

### 20.2 UI更新

```text
Provider Event
    ↓
Session / Usage Store
    ↓
UI Update Coordinator
    ↓
Affected Actions only
```

全Actionを毎回再描画しない。

---

## 21. Error Handling

### 21.1 表示

キー上で理解できる短い状態を優先する。

```text
LOGIN
CLI?
STALE
ERROR
OFFLINE
```

### 21.2 ログ

ログレベル:

- error
- warn
- info
- debug

以下は絶対にログ出力しない。

- OAuth Token
- API Key
- Authorization Header
- Full Prompt（デフォルト）
- Full Clipboard Content
- Full Screenshot Path + sensitive metadata

### 21.3 Backoff

Provider connection / HTTP errorはexponential backoff + jitterを基本とする。

Manual Refreshはbackoff状態でもユーザー操作として許可するが、短時間連打はthrottleする。

---

## 22. Security / Privacy

### 22.1 Credential

- Provider公式Credential Storeを利用
- Plugin独自保存を避ける
- 読み取り専用
- Plaintext保存禁止

### 22.2 Approval

- High risk: Hold to Approve
- Default: Approve Once
- Always Approveなし
- Denyは即時押下可

### 22.3 Voice

- 録音中状態を明確表示
- 録音停止状態を常に確認可能
- Local STT利用時は外部送信しない
- Remote STT時は設定画面で明示する

### 22.4 Screenshot / Clipboard

- 自動送信しない
- ユーザーアクションを起点とする
- 一時データの保持期間を最小化する

### 22.5 Telemetry

MVPでは独自Telemetryなし。

---

## 23. Property Inspector

### 23.1 Global Settings

- Default Project
- Default Provider
- Claude Refresh Interval
- Codex Health Check
- Voice Provider
- Privacy options
- Debug Logging

### 23.2 Action Settings

#### Usage Action

- Provider
- Auto / Pinned Window
- Used / Remaining
- Warning threshold

#### Agent Action

- Active / Fixed Session
- Status format

#### Prompt Action

- Preset
- Input Source
- Target

#### Launcher Action

- App / Project
- Start commands

---

## 24. ディレクトリ構成

```text
src/
├─ plugin.ts
│
├─ domain/
│  ├─ project.ts
│  ├─ session.ts
│  ├─ usage.ts
│  ├─ approval.ts
│  └─ model.ts
│
├─ application/
│  ├─ usage-service.ts
│  ├─ session-service.ts
│  ├─ project-service.ts
│  ├─ approval-service.ts
│  └─ provider-registry.ts
│
├─ actions/
│  ├─ agent-status-action.ts
│  ├─ stop-action.ts
│  ├─ approval-action.ts
│  ├─ voice-action.ts
│  ├─ screenshot-action.ts
│  ├─ prompt-action.ts
│  ├─ git-action.ts
│  ├─ project-action.ts
│  └─ usage-action.ts
│
├─ providers/
│  ├─ provider.ts
│  ├─ codex/
│  │  ├─ codex-provider.ts
│  │  ├─ app-server-client.ts
│  │  ├─ json-rpc.ts
│  │  └─ mapper.ts
│  └─ claude/
│     ├─ claude-provider.ts
│     ├─ claude-client.ts
│     ├─ claude-usage-parser.ts
│     └─ claude-launcher.ts
│
├─ adapters/
│  ├─ git/
│  │  └─ git-adapter.ts
│  ├─ voice/
│  │  ├─ voice-provider.ts
│  │  ├─ windows-dictation.ts
│  │  └─ local-whisper.ts
│  ├─ launcher/
│  │  └─ app-launcher.ts
│  └─ capture/
│     └─ screenshot-adapter.ts
│
├─ presentation/
│  ├─ renderers/
│  │  ├─ key-renderer.ts
│  │  └─ encoder-renderer.ts
│  ├─ plus-dashboard-coordinator.ts
│  └─ view-models/
│
├─ infrastructure/
│  ├─ cache.ts
│  ├─ process-manager.ts
│  ├─ scheduler.ts
│  └─ logger.ts
│
├─ generated/
│  └─ codex/
│
└─ property-inspector/
```

---

## 25. Technical Spike

本実装前に以下の技術検証を行う。

### Spike A: Codex

- app-server spawn
- initialize / initialized
- account/rateLimits/read
- account/rateLimits/updated
- turn state event
- turn/interrupt

成功条件:

> 実機Stream Deck PlusにCodex UsageとWORKING / IDLEが表示され、STOPキーで実行中Turnを停止できる。

### Spike B: Stream Deck Plus

- Key dynamic image
- Encoder custom layout
- setFeedback
- 4 Encoder Coordinator
- Profile変更時のwillAppear / willDisappear

### Spike C: Git

- Project path検出
- branch / status / ahead / behind
- Agent変更後refresh

### Spike D: Claude

- Usage取得可否
- Credential discovery
- Parser fixture
- Claude Desktop deep link

---

## 26. テスト方針

### Unit Test

- Usage normalization
- Window selection
- Claude parser
- Codex mapper
- State reducer
- Approval risk handling
- Project config

### Integration Test

- Codex App Server lifecycle
- JSON-RPC handshake
- Event merge
- Git adapter
- Launcher

### Device Test

- Stream Deck Plus実機
- Encoder操作
- Touch Strip描画
- Profile切替
- Plugin restart
- Device reconnect

### Failure Test

- Codex CLI未インストール
- Claude未ログイン
- Provider schema変更
- Rate Limit
- Process crash
- Git repositoryではないProject
- Active Session消失

---

## 27. 非機能要件

### Performance

- UI操作に対するローカル反応: 100ms以内を目標
- Provider通信はUI threadをブロックしない
- 同一Provider refreshはsingle-flight

### Stability

- Provider障害でPlugin全体を停止しない
- ProviderごとにCircuit / Backoffを持つ
- 最後の成功Snapshotを保持してSTALE表示可能

### Compatibility

- Windows 10 / 11をMVP
- Stream Deck Plusを最優先
- 通常Stream DeckはKey Actionのみ将来対応可能な構造とする

### Maintainability

- Provider固有schemaをDomainへ漏らさない
- Generated Codex typeと手書きDomain typeを分離
- UI rendererとbusiness logicを分離

---

## 28. リリースロードマップ

### v0.1 — Control Core

```text
Codex Usage
Agent Status
Stop
Project
Git Status
App Launcher
```

### v0.2 — Multi Provider / Workflow

```text
Claude Usage
AI Overview
Prompt Dial
Clipboard → AI
```

### v0.3 — Voice / Vision

```text
Push-to-Talk
Voice Steer
Screenshot → AI
```

### v0.4 — Advanced Agent Control

```text
Approve / Deny
Model / Reasoning
Plan Progress
Diff Summary
Session Manager
```

### v1.0

安定したProvider抽象化、設定Migration、Installer / Marketplace配布、主要Failure recoveryが揃った時点を1.0とする。

---

## 29. 今後検討する追加機能

初期設計には含めるが、実装優先度は後段とする。

- Build / Test status表示
- GitHub PR / CI status
- Terminal command presets
- Notification Center
- Agent completion sound / Stream Deck alert
- Cost / credit表示（Providerが安定提供する場合）
- MCP Server状態表示
- Agent session history
- Project-specific Prompt Presets
- Project-specific startup recipe
- Multi-agent comparison
- Remote machine status

---

## 30. 採用判断

本PluginはUsage Monitorではなく、以下の6機能を中核とする。

1. Agent Status
2. Stop / Control
3. Project / Session
4. Git Context
5. Voice / Prompt Input
6. Usage Monitoring

差別化の中心は「Claude / Codexに対応していること」ではなく、Stream Deck PlusをAI Coding Agentの物理操作面として成立させることに置く。

---

## 31. 参考仕様

- Elgato Stream Deck SDK 2 — Dials & Touch Strip
  - https://docs.elgato.com/streamdeck/sdk/guides/dials/
- Elgato Stream Deck SDK — Touch Strip Layout
  - https://docs.elgato.com/streamdeck/sdk/references/touch-strip-layout/
- OpenAI Codex — App Server README
  - https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- OpenAI Codex — MCP Server Interface
  - https://github.com/openai/codex/blob/main/codex-rs/docs/codex_mcp_interface.md
- Anthropic — Claude Desktop Deep Links
  - https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link

