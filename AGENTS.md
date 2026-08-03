# Effort-Aware Model Router

## Architecture
- `src/extension.ts` is the OMP extension entry point and owns lifecycle/UI orchestration.
- `src/classifier.ts` performs direct credential-aware `pi-ai` effort classification.
- `src/routing.ts` contains pure model/thinking policy.
- `src/config.ts` validates and layers untrusted JSON configuration.
- `src/state.ts` owns versioned persisted router state.
- `src/setup.ts` owns setup dialogs and safe configuration writes.

## Commands
- Full tests: `bun test`
- Type and style checks: `bun run check`
- Focused test: `bun test test/<module>.test.ts`

## Invariants
- Preserve slash-command bypass before classifier or planner work.
- Use exported OMP APIs; do not reach into private session internals.
- Keep configuration backward compatible and validate all JSON as untrusted input.
- Migrate versioned persisted state explicitly.
- Check every caller before changing an exported contract.

Directory-specific rules live in `src/AGENTS.md` and `test/AGENTS.md`.
