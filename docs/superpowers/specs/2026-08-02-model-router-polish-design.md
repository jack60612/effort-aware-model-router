# Effort-Aware Model Router Polish Design

## Problem

The extension already classifies eligible interactive prompts and selects a model by effort threshold, but its user experience is terse and its routing policy is intentionally narrow. Users need to understand why a route happened, configure ordered alternatives when a preferred model cannot be used, avoid unnecessary classifier work, and control the thinking level independently for each target model.

## Goals
- No OMP core changes or private host API dependencies.
- Preserve the current default behavior when the new settings are absent.
- Make routing decisions explainable without reading session internals.
- Select the first viable model from an ordered candidate list for each effort threshold.
- Reject candidates that cannot resolve, authenticate, or fit the current context before falling back to the baseline.
- Support bounded classification cooldown and minimum-input controls, disabled by default.
- Support one-shot model overrides without changing persistent routing mode.
- Support model-specific thinking profiles such as `default: low` and `xhigh: medium`.
- Persist a bounded decision history and migrate existing version-1 state safely.
- Keep routing limited to the existing idle, main-session, interactive input hook.
- Ship tests and documentation that describe the actual compatibility boundary.
- Provide an interactive `/route setup` wizard using OMP's public UI dialogs so users do not need to hand-edit JSON for common configuration.

## Non-goals

- No task-type classifier or second model call. Effort remains the only classifier dimension.
- No routing of RPC, ACP, queued, focused, subagent, or extension-initiated prompts.
- No OMP core changes or private host API dependencies.
- No automatic npm publication in this release; GitHub installation remains supported.

## Configuration

The existing JSON configuration remains valid. New fields are optional:

```json
{
  "thresholds": {
    "low": ["@smol", "@fast"],
    "high": ["@slow", "@reasoning"]
  },
  "classifierMinPromptChars": 0,
  "classifierCooldownMs": 0,
  "thinkingProfiles": {
    "openai/gpt-5.6-sol": {
      "default": "low",
      "xhigh": "medium",
      "max": "medium"
    }
  }
}
```

- A threshold value accepts either one non-empty selector or an ordered non-empty selector array. Existing string values are normalized to one-candidate arrays internally.
- `classifierMinPromptChars` is a non-negative safe integer. Prompts shorter than the value skip classification and leave the current model unchanged.
- `classifierCooldownMs` is a non-negative safe integer. After a successful or failed classification decision, eligible prompts inside the cooldown window skip classification and leave the current route unchanged. The default `0` preserves current behavior.
- `thinkingProfiles` is keyed by exact resolved `provider/model` identity. Each profile may contain `default` and any effort key (`low`, `medium`, `high`, `xhigh`, `max`) mapped to a valid thinking effort (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`). An exact effort mapping wins over `default`; without a profile, the classified effort is used. The final value is clamped against target-model metadata.
- Config layers merge threshold candidate arrays by replacing the value at that effort and merge thinking profiles by model key, with later valid fields overriding earlier fields.
- Invalid entries, inherited properties, empty arrays, unknown effort names, and invalid timing values are ignored without invalidating the rest of a layer.

## Routing algorithm

For each eligible prompt:

1. Restore or create router state.
2. Apply explicit one-shot override if present; otherwise honor mode and external-model pin detection.
3. Skip blank, slash-command, queue-shorthand, non-interactive, busy, pending, parent-session, too-short, or cooldown-gated input.
4. Classify effort through the existing direct classifier.
5. Resolve the threshold’s ordered candidate selectors.
6. For each candidate in order, resolve the model, check context capacity, and attempt the model switch. A failed candidate does not immediately force baseline fallback; the next candidate is tried.
7. For the selected candidate, resolve its thinking profile and clamp the resulting effort to supported model metadata.
8. Persist the route outcome, reason, selected candidate, applied thinking level, and bounded history.
9. If every candidate fails, return to the stored baseline using the existing contained-failure behavior.

No candidate retry changes the classifier effort or silently lowers the threshold. Candidate ordering is explicit configuration, so fallback remains predictable.

## User experience

- The status segment stays compact: mode, baseline, latest effort, target, and outcome.
- `/route status` keeps the compact status and notification.
- `/route explain` shows the latest decision, classifier/cooldown state, candidate list, selected candidate, context result, thinking profile result, and fallback reason.
- `/route history` shows the bounded recent decisions newest first.
- `/route once <selector>` arms one prompt for an explicit target and consumes the override after the prompt is handled. It does not change `auto`, `manual`, or `off` mode.
- `/route manual` remains the reliable permanent pin; `/route auto`, `/route off`, and `/route reload` retain their existing meanings.
- Notifications are emitted for explicit user commands and meaningful state transitions, not for every cooldown skip.

## First-class configuration UI

`/route setup` opens a built-in OMP dialog flow rather than a custom private component. The wizard:

1. Lets the user choose user-level or project-level configuration.
2. Shows enablement and classifier settings with current values, including human-readable cooldown presets.
3. Uses selectable model boxes for available resolved models and currently configured selectors when choosing classifier, threshold, or profile models; it does not accept freeform model entry.
4. Lets the user add ordered fallback candidates.
5. Lets the user configure a model-specific thinking profile with a default effort and optional `xhigh`/`max` overrides.
6. Displays a final summary and requires confirmation before writing JSON.

The wizard writes only the selected config layer, preserves unknown fields in that file, reloads the validated result, and reports the exact path written. If the UI surface is unavailable (RPC, ACP, print, or a headless test context), `/route setup` returns a clear unsupported-surface message without writing anything. New custom selectors remain available through manual JSON configuration.

## State and compatibility

State version 1 entries remain readable. The parser upgrades them in memory with empty history and no one-shot override. New entries use version 2 and include:

- `history`, capped at the configured implementation limit;
- optional `oneShotSelector`;
- the last decision’s candidate list and applied thinking information;
- timestamps needed for cooldown decisions.

Malformed nested data is discarded as before. Persisted history is bounded so session entries cannot grow without limit.

## Testing

- Config tests cover string-to-array normalization, candidate/profile merging, timing validation, prototype safety, and malformed input.
- Routing tests cover ordered candidate selection, context rejection, profile precedence, and clamping.
- Classifier tests cover minimum-input/cooldown seams without issuing provider calls.
- Extension tests cover skips, candidate fallback, one-shot consumption, explain/history commands, state migration, bounded history, and unchanged legacy behavior.
- Clean checkout validation runs typecheck, Biome, and all package tests.
- UI tests cover wizard cancellation, scope selection, candidate/profile writes, confirmation, preservation of unrelated JSON fields, and unsupported non-interactive contexts.
- OMP GitHub installation is smoke-tested against a temporary install and removed afterward.
