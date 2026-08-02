# Model Router Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development for implementation tasks.

**Goal:** Extend the standalone OMP effort-aware model router with predictable ordered fallbacks, classifier cost controls, model-specific thinking profiles, explainable bounded state, one-shot overrides, and a first-class public-UI setup wizard without changing OMP core or the existing routing compatibility boundary.

**Architecture:** Keep the current extension entry point and split pure validation/selection from host integration. `config.ts` owns normalized layered policy, `routing.ts` owns candidate/profile/context decisions, `state.ts` owns version-2 session state and migration, and a focused setup writer owns safe JSON-layer edits. `extension.ts` orchestrates the existing public input hook, commands, state persistence, and UI wizard. All new behavior is disabled or neutral when its optional configuration is absent.

**Tech Stack:** TypeScript ESM, Bun, `@oh-my-pi/pi-coding-agent` public extension API, `@oh-my-pi/pi-ai` direct classifier, Bun test, Biome, TypeScript native preview.

## Global Constraints

- Preserve the supported surface: only ordinary interactive main-session input while idle, with no pending messages and no parent session.
- Use only public OMP APIs (`ctx.models`, `ctx.ui.select/input/confirm`, `ctx.hasUI`, `pi.setModel`, `pi.setThinkingLevel`, lifecycle/input/command hooks). Do not import or reach into OMP internals.
- Do not add a task-type classifier, RPC/ACP routing, queued/focused/subagent routing, recursive session calls, automatic npm publication, or unrelated CI work.
- Keep all untrusted JSON own-property checks and prototype-safety guarantees.
- Write tests before production changes for each observable contract; run the focused failing test, then implementation, then focused green test.
- Never lower the configured effort because a candidate failed. Try candidates in the configured order, then use the existing contained baseline fallback.
- Preserve unknown keys when the setup wizard edits an existing config file. Invalid JSON must abort the write rather than destroy user data.
- Keep persisted decision history bounded; never persist arbitrary prompt text or secrets.

---

## Phase 1: Config policy and normalization

### Task 1: Add failing config tests for the new schema

**Files:** `test/config.test.ts`, `src/config.ts` (tests first; implementation second).

1. Update legacy expectations to the normalized internal representation: threshold strings load as one-element selector arrays, while the default behavior remains equivalent.
2. Add tests that parse string and ordered-array thresholds, trim selectors, reject empty array members, ignore sparse-array inherited entries, and ignore unknown threshold names.
3. Add tests for `classifierMinPromptChars` and `classifierCooldownMs`: accept non-negative safe integers including zero; ignore negatives, fractions, non-finite values, and unsafe integers.
4. Add tests for `thinkingProfiles`: accept exact model keys, valid `default` and effort overrides, trim/validate effort strings, ignore malformed profiles and prototype/inherited fields, and preserve valid sibling profiles.
5. Add a layering test proving threshold values replace one effort's candidate list and profiles merge by exact model key with later valid fields overriding earlier fields.
6. Run `bun test test/config.test.ts`; confirm the new assertions fail against the current implementation before editing production code.

### Task 2: Implement normalized config policy

**Files:** `src/config.ts`, `test/config.test.ts`.

1. Introduce `RouterThresholds` as partial effort-to-readonly-selector-array data and `RouterThinkingProfile`/`RouterThinkingProfiles` types. Add `classifierMinPromptChars`, `classifierCooldownMs`, and `thinkingProfiles` to `RouterConfig` and layer types.
2. Keep parser input backward-compatible: a threshold accepts one trimmed selector string or a non-empty array of own, non-empty selectors. Arrays are normalized to fresh arrays.
3. Validate timing fields as non-negative safe integers. Validate thinking effort names against `minimal` plus the route efforts; accept only own `default`/effort keys, and trim only strings that remain valid.
4. Continue ignoring malformed roots, inherited properties, unknown keys, and invalid individual fields without discarding valid siblings.
5. Set defaults to the current routing behavior (`low: ["@smol"]`, `high: ["@slow"]`, zero minimum/cooldown, and an empty profile map) and clone every nested collection while loading.
6. Merge threshold candidate arrays by effort replacement and profiles by exact model key with per-field later-layer overrides. Keep classifier model arrays as whole-field replacement.
7. Run `bun test test/config.test.ts` and `bun run check:types` before continuing.

## Phase 2: Pure routing policy

### Task 3: Add failing candidate/profile routing tests

**Files:** `test/routing.test.ts`, `src/routing.ts`.

1. Add candidate-selection tests for the highest configured threshold at or below the classified effort, preserving candidate order and accepting legacy string values.
2. Add a test that malformed/inherited/empty candidates are ignored and that no implicit lower-threshold candidates are appended.
3. Add profile-resolution tests for exact effort override precedence over `default`, `default` fallback, absent profile behavior, and unsupported profile values.
4. Add clamping tests proving a profile override is clamped against target-model metadata and that non-reasoning/non-controllable models produce no thinking level.
5. Run `bun test test/routing.test.ts`; verify the new tests fail before implementation.

### Task 4: Implement candidate and thinking helpers

**Files:** `src/routing.ts`, `test/routing.test.ts`.

1. Add `selectThresholdCandidates(classified, thresholds)` returning an ordered immutable-safe array from the nearest configured threshold; normalize strings and defensively validate unknown inputs.
2. Retain `selectThresholdSelector` as a compatibility helper returning the first candidate, and update its references/tests through the new candidate helper rather than silently changing its contract.
3. Add `resolveThinkingEffort(classified, profile)` using exact effort mapping first, then profile `default`, then the classified effort. The helper must accept only the typed effort union and leave unsupported metadata handling to clamping.
4. Keep existing `formatModelSelector`, identity comparison, token estimation, context-capacity, and clamping semantics unchanged unless required by the new types.
5. Run `bun test test/routing.test.ts`, `bun run check:types`, and `bun run lint` for the focused implementation.

## Phase 3: Versioned state, migration, and explainability data

### Task 5: Add failing state tests for version 2

**Files:** `test/state.test.ts`, `src/state.ts`.

1. Add tests that new state uses version 2 with empty bounded history, no one-shot selector, and cooldown timestamps unset.
2. Add tests that version-1 state parses and upgrades in memory with empty history/new optional fields, while malformed version-1 nested values remain rejected.
3. Add tests for decision records containing timestamp, candidate list, candidate outcomes/reasons, selected candidate, profile effort, applied thinking, and fallback reason.
4. Add tests for `oneShotSelector` validation and a bounded-history helper that keeps only the newest implementation-limit entries.
5. Add tests that `encodeRouterState` returns detached plain data and rejects invalid/unbounded state.
6. Run `bun test test/state.test.ts`; confirm new assertions fail before changing state production code.

### Task 6: Implement version-2 state and migration

**Files:** `src/state.ts`, `test/state.test.ts`.

1. Set `MODEL_ROUTER_STATE_VERSION` to 2 and define a fixed history cap (for example eight entries) in one exported/internal constant used by tests.
2. Extend `RouterDecision` with timestamp, ordered candidate selectors, candidate-attempt summaries, selected candidate, profile effort, and applied thinking while preserving the existing compact fields needed by status/fallback logic.
3. Extend `RouterState` with `history`, optional `oneShotSelector`, `lastClassifiedAt`, and the last-decision metadata required by cooldown/explain output. Keep identities and warning keys strictly validated.
4. Parse version 2 strictly; parse version 1 with the old shape and upgrade to version 2 in memory. Discard malformed nested decisions/history entries instead of accepting arbitrary data. Trim/deduplicate warning keys and cap history during parse/encode.
5. Add helpers for recording a decision, arming/consuming a one-shot selector, and checking the cooldown timestamp without persisting prompt content. Ensure all helpers return detached data.
6. Run `bun test test/state.test.ts` and `bun run check:types`.

## Phase 4: Extension behavior and public UI

### Task 7: Add failing extension tests for routing behavior and commands

**Files:** `test/extension.test.ts`, `src/extension.ts`.

1. Extend the harness config defaults for normalized thresholds, timing controls, and profiles; add controllable clock support so cooldown tests are deterministic.
2. Add tests that candidates are attempted in order: unresolved/context-incompatible/auth-failing candidates continue to the next candidate, and baseline is used only after all candidates fail.
3. Add tests that minimum prompt length and classifier cooldown skip classification without changing the current route, while a one-shot override bypasses normal mode/cooldown and is consumed only after an eligible prompt is handled.
4. Add tests for model-specific thinking profiles, exact effort precedence, clamping, and no thinking call for unsupported target models.
5. Add tests for `/route explain` and `/route history` output, `/route once <selector>` validation/arming, and legacy command behavior (`auto`, `manual`, `off`, `status`, `reload`, `/model auto`).
6. Add tests restoring version-1 entries and proving new routing persists version-2 bounded history.
7. Run `bun test test/extension.test.ts`; verify the new assertions fail before modifying production code.

### Task 8: Integrate candidates, cooldown, profiles, state history, and commands

**Files:** `src/extension.ts`, `src/state.ts`, `src/routing.ts`, `test/extension.test.ts`.

1. Update extension-local default cloning and status formatting for the expanded config/state types.
2. In the eligible-prompt path, honor a pending one-shot first; otherwise require auto mode, detect external model changes as before, then apply minimum-length and cooldown skips before classification.
3. Record classification timestamps only for classification attempts and decisions. Do not emit noisy notifications for ordinary minimum/cooldown skips.
4. Classify once, resolve the selected threshold's ordered candidates, and for each candidate resolve the model, check context capacity, and attempt the model switch. Capture a compact candidate-attempt reason for explain/history. Do not alter the classified effort while trying candidates.
5. Apply `resolveThinkingEffort` and `clampEffortToModel` only after a candidate succeeds; set the public thinking level when supported. Record route or contained baseline fallback in the latest decision and bounded history, then persist a validated state entry.
6. Consume a one-shot after the eligible prompt reaches a handled outcome, including contained fallback; leave it armed when input was skipped before handling.
7. Add `/route explain` and `/route history` notifications with stable, bounded, human-readable summaries. Keep `/route status` compact. Add `/route once <selector>` and update usage text; resolve invalid selectors without mutating the armed state.
8. Keep existing transition semantics and warning deduplication. Reload config through the same loader and validate its expanded shape.
9. Run focused extension/state/routing tests and `bun run check:types`.

### Task 9: Add a focused setup/config writer with failing tests

**Files:** `test/setup.test.ts`, `src/setup.ts` (new file), `src/config.ts` if shared types are needed.

1. Add an injectable filesystem/path seam to test user and project target paths without mutating the real home directory.
2. Add tests for selecting user vs project scope, cancellation at every dialog step, and unsupported/headless contexts producing no write.
3. Add tests that a completed wizard writes enabled/classifier/timing/threshold candidate/profile fields, creates parent directories, formats valid JSON, and preserves unrelated existing JSON keys.
4. Add tests that invalid existing JSON or a failed confirmation leaves the file byte-for-byte unchanged.
5. Run `bun test test/setup.test.ts`; confirm failures before implementation.

### Task 10: Implement the public `/route setup` wizard

**Files:** `src/setup.ts`, `src/extension.ts`, `test/setup.test.ts`, `test/extension.test.ts`.

1. Implement a pure `writeRouterConfigLayer`/wizard dependency seam that reads the selected file, parses an object, merges only known router fields, writes atomically through the injected filesystem, and rejects invalid JSON rather than replacing it. Preserve unrelated keys and use user config `~/.omp/agent/model-router.json` or project config `<cwd>/.omp/model-router.json`.
2. Implement the dialog flow using only public `ctx.ui.select`, `ctx.ui.input`, `ctx.ui.confirm`, and `ctx.hasUI`: scope; enabled; minimum prompt length; a human-readable cooldown preset; classifier model boxes; each threshold's ordered candidates from available model boxes plus currently configured selectors; optional model-specific profile selected from the same boxes with default and `xhigh`/`max` overrides; final summary/confirmation. Do not provide freeform model entry in the wizard.
3. Treat cancellation as a no-op with an informational notification. Treat unavailable UI as an explicit unsupported-surface warning with no file write. Avoid custom/private UI components.
4. After a successful write, reload the validated config, update state mode only under existing reload rules, and notify the exact written path. Do not write until final confirmation.
5. Register `/route setup` without changing existing command semantics. Add it to usage and README.
6. Run `bun test test/setup.test.ts test/extension.test.ts` and `bun run check:types`.

## Phase 5: Documentation, release, and verification

### Task 11: Update package documentation and changelog

**Files:** `README.md`, `CHANGELOG.md`, `package.json`.

1. Document candidate arrays and deterministic fallback order, minimum/cooldown settings, thinking profiles, state/history behavior, `/route explain`, `/route history`, `/route once`, and `/route setup`.
2. Document the UI limitation and the unchanged interactive-only compatibility boundary. State that setup preserves unknown JSON keys and that manual JSON remains supported.
3. Update examples and default-behavior text so strings are described as accepted shorthand but arrays are the normalized advanced form.
4. Add a release entry describing the observable changes and bump the package version to the next minor feature version (`0.2.0`). Keep the GitHub install path authoritative.
5. Run `bun run fmt` and inspect the changed docs/package files.

### Task 12: Verify, review, publish the feature update

**Files:** all changed source/tests/docs.

1. Run `bun run check`, `bun test`, and `bun pm pack --dry-run` from the standalone repository. The package archive must include the extension runtime and user docs without tests or design/plan files.
2. Smoke-test a clean clone with `bun install --frozen-lockfile`, `bun run check`, and `bun test`.
3. Smoke-test OMP's actual GitHub plugin install in a temporary directory using the repository manifest, then uninstall it and verify no test install remains. Do not claim a provider-backed classification prompt unless credentials and a real prompt were exercised.
4. Invoke the required code-review pass against the implementation base/head. Fix every correctness, compatibility, security, or reliability finding that is supported by the code and rerun the affected checks.
5. Commit the design/plan and implementation as focused commits, push `main`, and verify the remote head plus clean-clone install once more.

## Acceptance Criteria

- Existing JSON string threshold configs continue to work with the same default routes.
- Every configured candidate is tried in order with resolve/context/auth evidence before contained baseline fallback.
- Minimum prompt and cooldown settings skip classification without unintended model changes; defaults are no-op.
- Exact model thinking profiles override classified effort and are clamped to target metadata.
- Version-1 state is readable and upgraded in memory; version-2 history is bounded and explainable.
- One-shot routing, explain/history commands, and legacy commands behave deterministically.
- `/route setup` uses only public UI dialogs, writes only after confirmation, preserves unknown fields, handles cancellation/headless contexts safely, and reloads the validated result.
- `bun run check`, all package tests, pack validation, clean-clone validation, and temporary OMP install/uninstall smoke tests pass.
