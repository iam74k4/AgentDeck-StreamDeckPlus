# AgentDeck for Stream Deck Plus

Monitor and control local AI coding agents from an Elgato Stream Deck +.

AgentDeck is a **controller**, not another AI client. It drives the agents you
already run — Codex today, others behind the same provider interface — so the
deck answers four questions without a context switch: what is the agent doing,
how much quota is left, what does the working tree look like, and how do I stop
it right now.

```text
┌──────────┬──────────┬──────────┬──────────┐
│ Agent    │  STOP    │  Usage   │   Git    │
│ ● WORKING│          │   41%    │  main    │
│  02:18   │          │   5h     │  M:4     │
└──────────┴──────────┴──────────┴──────────┘
┌──────────┬──────────┬──────────┬──────────┐
│ USAGE    │ AGENT    │ GIT      │ CODEX    │
│ 41%      │ WORKING  │ main M:4 │ READY    │
│ 5h       │ 02:18    │ ↑1 ↓0    │          │
└──────────┴──────────┴──────────┴──────────┘
```

- **Design document (source of truth):** [`AGENTDECK_DESIGN.md`](./AGENTDECK_DESIGN.md)
- **Implementation brief:** [`docs/AGENTDECK_CLAUDE_INSTRUCTIONS.md`](./docs/AGENTDECK_CLAUDE_INSTRUCTIONS.md)
- **Current status:** [`docs/SPIKE_REPORT.md`](./docs/SPIKE_REPORT.md)

## Status

Technical Spike complete; v0.1 Control Core in progress.

| Spike             | Scope                                                           | State                |
| ----------------- | --------------------------------------------------------------- | -------------------- |
| A — Codex         | app-server lifecycle, JSON-RPC handshake, usage, turn interrupt | Verified in software |
| B — Stream Deck + | dynamic key images, encoder layout, 4-encoder coordination      | Verified in software |
| C — Git           | branch, working-tree counts, ahead/behind, non-repo handling    | Verified in software |

Device verification on real hardware is the one outstanding item — see
[`docs/DEVICE_TEST.md`](./docs/DEVICE_TEST.md).

## Requirements

- Windows 10 / 11 (MVP target)
- Stream Deck app 6.5+ with a Stream Deck +
- Node.js 20.5.1+
- [Codex CLI](https://github.com/openai/codex) on `PATH` (or set an override in the
  Property Inspector)

## Getting started

```bash
npm ci
npm run build

npx @elgato/cli link com.agentdeck.streamdeck-plus.sdPlugin
npx @elgato/cli restart com.agentdeck.streamdeck-plus
```

`npm run watch` rebuilds and restarts the plugin as you edit.

## Scripts

| Script                         | Purpose                                                         |
| ------------------------------ | --------------------------------------------------------------- |
| `npm run verify`               | format check → lint → typecheck → tests → build                 |
| `npm run build`                | bundle `src/plugin.ts` into the `.sdPlugin` folder              |
| `npm run watch`                | rebuild and restart the plugin on change                        |
| `npm test`                     | unit and integration tests                                      |
| `npm run icons`                | regenerate the manifest PNG assets                              |
| `npm run codex:generate-types` | write official Codex protocol types into `src/generated/codex/` |

## Actions

| Action            | Controller | Behaviour                                                            |
| ----------------- | ---------- | -------------------------------------------------------------------- |
| Agent Status      | Key        | Provider, session state, elapsed turn time. Press re-reads sessions. |
| Stop Agent        | Key        | Interrupts the active turn. Dimmed when nothing is running.          |
| Usage             | Key        | One rate-limit window, auto or pinned. Press refreshes.              |
| Git Status        | Key        | Branch and working-tree counts. Press refreshes.                     |
| Dashboard Segment | Encoder    | One touch-strip segment; four of them form a single dashboard.       |

## Architecture

```text
Presentation  actions/ · presentation/
     ↓
Application   usage-service · session-service · git-service · provider-registry
     ↓
Domain        project · session · usage · approval · model · errors
     ↑
Infrastructure / Providers / Adapters
```

Two rules hold everywhere and are enforced by lint, not just by convention:

- **Provider isolation.** Codex and Claude wire shapes exist only inside their
  provider adapter. `providers/codex/protocol.ts` is the boundary;
  `providers/codex/mapper.ts` is the only translation point.
- **Dependency direction.** `domain/` and `application/` may reference a port as a
  type, but never import a concrete adapter — or the Stream Deck SDK — at runtime.

## Safety

- No `Always Approve`; approval is once-only by design, and high-risk requests
  require hold-to-approve.
- Credentials are read through the provider's own store; the plugin never copies
  or persists them.
- Every log line passes through a redactor. OAuth tokens, API keys, `Authorization`
  headers, full prompts and clipboard contents never reach a log file, at any
  level — including debug.
- No telemetry.

## Licence

MIT — see [`LICENSE`](./LICENSE).
