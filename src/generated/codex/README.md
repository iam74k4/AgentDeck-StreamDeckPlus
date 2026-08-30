# `src/generated/codex/`

Generated Codex app-server protocol types. **Do not edit by hand.**

Design §9.6: when the Codex CLI can emit its own schema, AgentDeck does not
hand-maintain a copy of the protocol.

```bash
npm run codex:generate-types            # uses `codex` from PATH
npm run codex:generate-types -- --executable "C:\\tools\\codex.exe"
```

The output is gitignored, so the repository builds and tests without the Codex
CLI installed. Until the generated types are wired in, the build depends on the
deliberately narrow read model in `src/providers/codex/protocol.ts`, which is
tolerant of unknown and null fields. `src/providers/codex/mapper.ts` is the only
module that would need to change when switching over.
