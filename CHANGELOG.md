# Changelog

## [0.2.0] - 2026-08-02

### Added

- Added ordered fallback candidates for each effort threshold, with selector, context-capacity, and authentication attempt tracking.
- Added classifier minimum prompt length and cooldown controls to avoid unnecessary classification calls.
- Added exact model-specific thinking profiles with default and effort-specific overrides, clamped to target model metadata.
- Added bounded decision history with `/route explain` and `/route history`, plus in-memory migration from version-1 session state.
- Added `/route once <selector>` for a single explicit route that bypasses automatic-mode safeguards.
- Added the public-UI `/route setup` wizard for project or user configuration, available-model selection, fallback ordering, classifier safeguards, and thinking profiles. Writes preserve unrelated configuration fields and require final confirmation.

## [0.1.0] - 2026-08-02

### Added

- Added the standalone effort-aware model router extension with direct `@tiny`/`@smol` classification, configurable effort thresholds, baseline fallback, persistent session state, and `/route` controls for idle main-session interactive prompts.
- Documented the public API compatibility boundary: RPC, ACP, direct extension, queued, focused, and subagent prompts are not routed.
