# Automatic Router Context Switching Design

## Problem

Automatic routing can move a session from its cheap baseline to a high-effort
model, but it does not restore the baseline after the turn finishes. The next
prompt therefore starts on the expensive model. Short follow-ups can be below
`classifierMinPromptChars`, so they do not trigger a new classification and
leave that expensive model active indefinitely.

The detached delegation path has the same lifecycle gap: a delegated child can
finish without a main-session `agent_end` event, leaving the routed model
selected for the next user prompt.

This is separate from `/parallel`; parallel workflow behavior and command
semantics remain unchanged.

## Goals

1. Use the router-selected high-effort model for the complete current task.
2. Restore the session's cheap automatic baseline after the task is terminal.
3. Never override a model selected manually while the task is running.
4. Handle both ordinary turns and detached delegation completion.
5. Preserve existing routing, delegation, persistence, and session-lifecycle
   behavior outside the automatic reset.

## Non-goals

- Changing `/parallel` behavior, concurrency, or background execution.
- Adding provider pricing, token accounting, or a global spend ledger.
- Resetting a model selected through `/route manual`, `/route off`, or an
  external model change that the router has recognized as manual.
- Reclassifying prompts or changing threshold candidates.

## Design

### Automatic baseline restoration

Add one guarded restoration helper that runs only when:

- router mode is `auto`;
- a baseline model exists;
- the current model still matches `lastAutoModel`; and
- the captured route generation still matches the current session generation.

The current-model check is the manual override fence. If the user changes
models during the turn, restoration is skipped and the existing next-input
logic can pin that model as manual. If a session switch, branch, or tree event
invalidates the turn, the generation check makes the stale completion a no-op.

On a successful restore, resolve and switch to `state.baseline`, update
`observedModel` and `lastAutoModel` to the baseline identity, and persist the
state. The existing model-switch behavior reapplies the baseline model's
thinking defaults. Authentication or resolution failures use the existing
bounded baseline warning path and do not overwrite a manual current model.

### Ordinary turns

When automatic routing successfully selects a target, capture the current
delegation/session generation alongside the in-flight automatic route.

At terminal `agent_end` (`willContinue !== true`), restore the baseline after
the current turn's completion bookkeeping. Nonterminal `agent_end` events do
not restore it, so tool/continuation phases keep the selected model.

### Detached delegation

The delegated child runs on the routed model as today. On child completion,
failure, cancellation, or planner failure, restore the baseline in the
workflow's `finally` path when no original request is being replayed.

When planning decides to pass through, the original request is replayed on the
selected model. The workflow marks that replay as pending and defers
restoration to the resulting terminal `agent_end`, so pass-through requests
still receive the effort selected for them.

## Safety invariants

- A high-effort automatic route may affect only its own active turn.
- A stale completion cannot change a successor session.
- A manual model change is never replaced by an automatic baseline restore.
- A route failure continues to use the existing baseline fallback behavior.
- `/parallel` remains untouched; this fix affects only router lifecycle state.

## Testing

- A normal high-effort route switches to the target, then terminal
  `agent_end` switches back to baseline.
- `agent_end` with `willContinue: true` leaves the target selected.
- A short follow-up after a terminal turn starts on the baseline without a
  second classifier call.
- Manual model changes prevent automatic restoration.
- Session switch/branch/tree invalidation prevents stale restoration.
- Delegated child success, failure, and cancellation restore the baseline.
- Delegation pass-through restores only after the replayed main turn ends.
- Existing routing, delegation, measurement, and full-suite behavior remains
  intact.

## Rollout

This is a lifecycle correction within automatic routing. No new command flags,
manifest fields, or parallel workflow migrations are required.
