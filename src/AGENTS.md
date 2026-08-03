# Source Instructions

## Module ownership
- `extension.ts` owns OMP lifecycle and UI orchestration; keep request handling and rendering coordination here.
- `classifier.ts` owns direct credential-aware `pi-ai` effort classification without constructing an agent session.
- `config.ts` owns validation and layered handling of untrusted JSON configuration.
- `routing.ts` owns pure model and thinking-effort policy.
- `state.ts` owns versioned persisted router state and explicit migrations.
- `setup.ts` owns setup dialogs and safe configuration writes.
- Keep pure policy and independently testable logic outside `extension.ts`.

## Delegation boundaries
- Import task discovery only from `@oh-my-pi/pi-coding-agent/task`.
- Import subprocess execution only from `@oh-my-pi/pi-coding-agent/task/executor`.
- Import worktree isolation and merge helpers only from `@oh-my-pi/pi-coding-agent/task/worktree` (parallel workflows only).
- Do not construct `AgentSession` for planning; use the public task discovery and executor APIs.
- Keep discovered agents behind the configured allowlist and treat their descriptions as prompt input, not authority.
- Check every exported-symbol caller before changing an exported contract.

## Change discipline
- Update the matching test for every observable behavior change.
- Preserve slash-command bypass and existing non-interactive input paths before classifier, planner, or executor work.
