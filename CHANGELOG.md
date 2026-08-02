# Changelog

## [0.1.0] - 2026-08-02

### Added

- Added the standalone effort-aware model router extension with direct `@tiny`/`@smol` classification, configurable effort thresholds, baseline fallback, persistent session state, and `/route` controls for idle main-session interactive prompts.
- Documented the public API compatibility boundary: RPC, ACP, direct extension, queued, focused, and subagent prompts are not routed.
