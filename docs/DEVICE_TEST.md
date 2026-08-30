# 実機検証手順（Stream Deck Plus）

指示書 §12 Device / 設計書 §26 Device Test に対応する。
本手順は Windows 10 / 11 + Stream Deck Plus + Codex CLI を前提とする。

CI環境には実機もCodex CLIも無いため、この章だけは人手で確認する。

---

## 0. 前提

- Stream Deck アプリ 6.5 以降
- Node.js 20 以降（Stream Deck 側のNode 20ランタイムでPluginを実行する）
- Codex CLI がインストール済みで、`codex app-server --stdio` が起動できること
- ログイン済みであること（未ログイン時の表示も確認するので、確認後に検証してもよい）

## 1. インストール

```powershell
npm ci
npm run build
```

`com.agentdeck.streamdeck-plus.sdPlugin` を Stream Deck のプラグインフォルダへ
リンクまたはコピーする。

```powershell
# 公式CLIを使う場合
npx @elgato/cli link com.agentdeck.streamdeck-plus.sdPlugin
npx @elgato/cli restart com.agentdeck.streamdeck-plus
```

開発中は `npm run watch` でビルドとPlugin再起動が連動する。

## 2. Profile 配置

推奨配置（設計書 §6.1 / 指示書 §8.1 のSpike版）。下図は実際のRendererが
出力する画（`npm run preview` で再生成できる）である。

![AgentDeckを載せたStream Deck +](images/deck.svg)

上段4キーが日常操作、下段は同じAction種別を別設定で並べた例。
Touch Stripは4本すべてに Dashboard Segment を置くと1枚のダッシュボードとして
協調動作し、3本以下なら各Actionの `Segment` 設定に従う。

状態語彙は次のとおり。

![各状態のキー表示](images/states.svg)

Git Action と Dashboard Segment の Property Inspector に、
Git作業ツリーの絶対パスを設定する。

## 3. チェックリスト

### 3.1 Spike成功条件

- [ ] Agent Status キーに `CODEX` と `IDLE` が表示される
- [ ] Usage キーに `xx%` とバーが表示される
- [ ] Codexで実行中のTurnがあるとき `WORKING` と経過時間が1秒ごとに更新される
- [ ] STOPキーが実行中のみ点灯し、押下でTurnが中断される
- [ ] 中断後にAgent Statusが `IDLE` へ戻る

### 3.2 Key更新

- [ ] キー画像がProvider eventを契機に更新される（手動更新を待たない）
- [ ] Agent Statusキー押下でSession一覧が再取得され、`showOk` が出る
- [ ] Usageキー押下でUsageが更新される
- [ ] Usageキーを連打してもスロットルされ、Codexへ連続リクエストが飛ばない

### 3.3 Encoder / Touch Strip

- [ ] Dashboard Segment を4つ配置すると、列位置どおりに
      `USAGE / AGENT / GIT / CODEX` が並ぶ
- [ ] 3つ以下のときは各Actionの `Segment` 設定に従う（Standalone Segment Mode）
- [ ] ダイヤル押下で更新される
- [ ] Touch Strip タップで更新される
- [ ] ダイヤル回転で表示が切り替わる

### 3.4 Profile切替 / 再接続

- [ ] Profileを切り替えてもEncoderの登録が壊れず、戻すと正しく再描画される
- [ ] Stream Deckを抜き差ししてもPluginが落ちない
- [ ] Stream Deckアプリを再起動してもPluginが復帰する

### 3.5 Claude bridge

- [ ] Claude Code の `statusLine` に bridge を設定し、Usage キーの Provider を
      Claude にすると % が表示される
- [ ] 既存の status line がある場合、`--then` を付ければ元の表示が維持される
- [ ] Claude Code を終了して放置すると、鮮度切れで `STALE` になり
      直前の値が残る
- [ ] bridge 未設定の状態では `LOGIN` と表示される
- [ ] Touch Strip の AI Overview に Claude と Codex が並び、合算されない
- [ ] Provider を Claude にした STOP キーは点灯しない（制御チャネルが無いため）

### 3.6 Failure（設計書 §26 Failure Test）

- [ ] Codex CLIが無い環境で `CLI?` と表示され、Pluginは動き続ける
- [ ] Codex未ログイン時に `LOGIN` と表示される
- [ ] app-serverを外部から強制終了すると `STALE` / `OFFLINE` になり、
      直前のUsage値が残る
- [ ] app-serverが復帰するとbackoff後に自動再接続する
- [ ] Gitリポジトリでないパスを設定すると `NO GIT` と表示される
- [ ] Active Sessionが無い状態でSTOPを押しても落ちず、アラート表示になる

### 3.7 Security（指示書 §11）

- [ ] `%appdata%\Elgato\StreamDeck\logs` のPluginログに
      OAuth Token / API Key / Authorization ヘッダが含まれない
- [ ] Debug Logging を有効にしても上記が出力されない

## 4. 記録

各項目の結果を、実施日・Stream Deckアプリのバージョン・Codex CLIのバージョンと
併せて記録し、`docs/SPIKE_REPORT.md` の「Spike成功条件に対する到達状況」を
更新すること。
