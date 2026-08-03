# Cache-Aware Delegation Measurement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, sampled planner shadow and provider-usage ledger that measures standalone delegation and main-session costs without forwarding parent conversation context.

**Architecture:** Keep configuration validation in `src/config.ts`, pure usage/sampling logic in a new `src/measurement.ts`, and direct planner usage capture in `src/delegation.ts`. Extend `src/extension.ts` with a detached, one-at-a-time shadow lifecycle and safe parent correlation using `message_end` confirmation plus `agent_end` aggregation; preserve the existing delegation ownership, replay, cancellation, and slash-command paths.

**Tech Stack:** TypeScript, Bun test, Biome, tsgo, `@oh-my-pi/pi-ai` `Usage`/`AssistantMessage`, `@oh-my-pi/pi-coding-agent` extension lifecycle hooks and task executor.

## Global Constraints

- `delegation.measurement.enabled` defaults to `false`; `sampleRate` defaults to `0.1` and accepts only finite values in `0..1`.
- Measurement never forwards the parent transcript, planner reasoning, child task text, or result output as new measurement payload.
- Missing usage or measurement errors are fail-open and never alter routing, child execution, cancellation, replay, or `/usage`.
- A shadow planner never calls `runSubprocess`, `sendMessage`, or `sendUserMessage`, and never changes model or thinking state.
- Parent correlation matches a confirmed `message_end` user message, aggregates assistant `message_end` usage, and finalizes only at `agent_end` with `willContinue !== true`; it never relies on the first `turn_end` event.
- Use only public OMP imports: `@oh-my-pi/pi-coding-agent/task`, `@oh-my-pi/pi-coding-agent/task/executor`, and public extension event types.
- Preserve current config layering, setup preservation, session state compatibility, delegation default-off behavior, and slash-command bypasses.
- Keep all tests deterministic and independent of live credentials.

---

### Task 1: Add measurement configuration and pure usage helpers

**Files:**
- Create: `src/measurement.ts`
- Create: `test/measurement.test.ts`
- Modify: `src/config.ts` (`RouterDelegationConfig`, `RouterConfigLayer`, defaults, parser, `mergeConfig`, cloned loader config)
- Modify: `test/config.test.ts` (delegation defaults, nested overrides, invalid rates)

**Interfaces:**
- Consumes: OMP `Usage` from `@oh-my-pi/pi-ai`; existing layered config parser and `RouterDelegationConfig`.
- Produces:
  ```ts
  export interface RouterDelegationMeasurementConfig {
    enabled: boolean;
    sampleRate: number;
  }

  export interface UsageSnapshot {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    totalTokens: number | null;
    cost: number | null;
  }

  export function snapshotUsage(usage: Usage | undefined): UsageSnapshot | null;
  export function aggregateUsage(snapshots: readonly (UsageSnapshot | null)[]): UsageSnapshot | null;
  export function shouldSampleShadow(sampleRate: number, randomValue: number): boolean;
  ```
  `aggregateUsage` returns `null` for an empty list and leaves a field `null` when any contributing snapshot lacks that field; it never treats missing data as zero. `snapshotUsage` accepts only finite non-negative numeric fields and copies `usage.cost.total` when finite, otherwise returns `null` for that field.

- [ ] **Step 1: Write failing pure-helper tests**

  In `test/measurement.test.ts`, add deterministic cases for:
  - a complete OMP usage object producing all six numeric snapshot fields;
  - absent usage producing `null`;
  - partial usage preserving `null` fields and ignoring `NaN`, infinities, and negative values;
  - aggregation summing two complete snapshots and returning `null` for a field missing from either input;
  - empty/all-null aggregation returning `null`;
  - sampling at rate `0`, rate `1`, exact lower/upper boundaries, and out-of-range random values.

  In `test/config.test.ts`, update exact default expectations to include `measurement: { enabled: false, sampleRate: 0.1 }`. Add tests proving a project layer can set only `delegation.measurement.enabled`, a later layer can set only `sampleRate`, and invalid nested values do not erase earlier valid values.

- [ ] **Step 2: Run focused tests and confirm the new contracts fail**

  Run:
  ```bash
  bun test test/measurement.test.ts test/config.test.ts
  ```
  Expected: failures for the missing module, missing config field, and missing nested parser behavior.

- [ ] **Step 3: Implement the pure helpers and config layer**

  In `src/measurement.ts`, normalize every field with a finite-number helper, preserve `null` for missing data, and aggregate each field only when all snapshots contain finite values. Implement sampling as `randomValue >= 0 && randomValue < sampleRate` after the config parser has validated the rate.

  In `src/config.ts`:
  - add `RouterDelegationMeasurementConfig` and make it required in the resolved `RouterDelegationConfig`;
  - define a nested delegation layer type so `measurement` itself is partial while `enabled`, `plannerTimeoutMs`, and `agents` retain their existing shallow semantics;
  - parse only own `measurement.enabled` booleans and finite `measurement.sampleRate` values in `0..1`;
  - add the default object and clone it in `loadRouterConfig` and every merge path;
  - merge measurement fields independently without replacing sibling delegation fields.

- [ ] **Step 4: Run the focused tests and commit the self-contained config/helper change**

  Run:
  ```bash
  bun test test/measurement.test.ts test/config.test.ts
  ```
  Expected: PASS. Commit with:
  ```bash
  git add src/measurement.ts test/measurement.test.ts src/config.ts test/config.test.ts
  git commit -m "feat: add delegation measurement config helpers"
  ```

---

### Task 2: Preserve planner compatibility while exposing provider usage

**Files:**
- Modify: `src/delegation.ts` (`DelegationPlan`, `planDelegation`)
- Modify: `test/delegation.test.ts` (planner usage assertions)

**Interfaces:**
- Consumes: `AssistantMessage.usage` from the direct `complete` call.
- Produces: `DelegationPlan` variants gain an optional non-persisted `usage?: Usage` property. `parseDelegationPlan` continues returning a bare plan; `planDelegation` returns the parsed plan plus `response.usage`.

- [ ] **Step 1: Add a failing planner usage assertion**

  Extend the existing direct-completion test response with a complete usage object and assert that `planDelegation(...)` returns the same parsed plan fields plus that usage object. Update the existing exact-return assertion to include the usage field. Keep parser tests asserting that strict JSON parsing returns no provider metadata.

- [ ] **Step 2: Run the focused planner test and confirm it fails**

  Run:
  ```bash
  bun test test/delegation.test.ts
  ```
  Expected: the new usage assertion fails because `planDelegation` currently discards `AssistantMessage.usage`.

- [ ] **Step 3: Return final planner usage without changing parsing or error paths**

  Import `Usage` as a type, add the optional field to both `DelegationPlan` variants, and return `{ ...plan, usage: response.usage }` only after the existing stop-reason and strict-parser checks succeed. Do not include usage in the planner JSON contract or diagnostics.

- [ ] **Step 4: Run planner tests and commit**

  Run:
  ```bash
  bun test test/delegation.test.ts
  ```
  Expected: PASS. Commit with:
  ```bash
  git add src/delegation.ts test/delegation.test.ts
  git commit -m "feat: expose delegation planner usage"
  ```

---

### Task 3: Add shadow lifecycle, delegation usage records, and safe parent correlation

**Files:**
- Modify: `src/extension.ts` (`createModelRouterExtension`, input handler, delegation workflow, lifecycle handlers)
- Modify: `test/extension.test.ts` (harness event emitters and behavior contracts)

**Interfaces:**
- Consumes: `RouterDelegationMeasurementConfig`, `UsageSnapshot`, `snapshotUsage`, `aggregateUsage`, `shouldSampleShadow`, optional planner usage, `SingleResult.usage`, and public OMP `message_end`/`agent_end` events.
- Produces: compact measurement metadata in `model-router-delegation` state entries, a `shadow` status for completed shadow records, and status-bar text containing measurement state/rate. The public extension dependency seam gains `random?: () => number` so sampling tests do not use `Math.random()`.

- [ ] **Step 1: Extend the test harness and write failing lifecycle tests**

  In `test/extension.test.ts`:
  - add measurement defaults to `routerConfig` and `delegationConfig`;
  - extend `PlanOutcome` to allow optional planner usage while retaining bare fake plans for existing tests;
  - add `Harness.randomValue`, inject it through `createModelRouterExtension`, and add `messageEnd(message)` and `agentEnd(willContinue, messages?)` helpers that invoke the registered public handlers;
  - add failing tests for:
    1. a sampled main-path prompt starting a planner shadow with no executor/custom-message/user-message call;
    2. a rejected sample making no planner call;
    3. an empty discovered allowlist recording a skip without a planner call;
    4. planner and child usage snapshots appearing in delegated records;
    5. matching a user `message_end`, aggregating assistant `message_end` usage, and finalizing on `agent_end` only when `willContinue` is false;
    6. a replay whose `sendUserMessage` is never confirmed not being attributed to a later matching turn after lifecycle reset;
    7. `/usage` and existing slash/command bypass behavior remaining unchanged.

- [ ] **Step 2: Run the focused extension tests and confirm the new contracts fail**

  Run:
  ```bash
  bun test test/extension.test.ts
  ```
  Expected: failures for missing measurement config fields, absent event handlers, missing shadow planner calls, and missing usage metadata; existing delegation tests should identify any required fixture updates.

- [ ] **Step 3: Add measurement runtime state and status reporting**

  In `createModelRouterExtension`:
  - add `random`, `shadowRunSequence`, one `shadowController`, and pending parent-correlation records;
  - extend `defaultConfig()` to clone the measurement object;
  - make `delegationStatus()` append `measurement on (<percentage>)` or `measurement off` while preserving existing `delegation on/off`, `active/idle` substrings;
  - add a concise measurement-entry helper that records only model identity, parent context tokens, sample rate, outcome, durations, usage snapshots, selected agent name, and task character count; never copy shadow task/request/result text into the new metadata;
  - add lifecycle cleanup that aborts the shadow controller, clears pending timers/correlations, and prevents a prior session from consuming later `message_end`/`agent_end` events.

- [ ] **Step 4: Implement safe parent correlation using message lifecycle events**

  Add an in-memory correlation record:
  ```ts
  type PendingParentMeasurement = {
    runId: string;
    expectedPrefix: string;
    phase: "awaiting-user" | "collecting-assistant";
    assistantUsage: UsageSnapshot[];
    timer: ReturnType<typeof setTimeout>;
    onComplete: (usage: UsageSnapshot | null) => void;
  };
  ```

  Register public `message_end` and `agent_end` handlers. Before a sampled main turn or replay, arm a five-minute timer. While awaiting confirmation, accept only a user `message_end` whose text exactly equals the sampled prompt or starts with the replayed original request. After confirmation, collect only assistant `message_end` usage snapshots. At `agent_end`, retain the record when `willContinue === true`; otherwise aggregate the collected usage, call `onComplete`, clear the timer, and remove the record. Clear all records on session branch/tree/switch/shutdown. Never correlate on `turn_end` alone.

- [ ] **Step 5: Implement sampled main-path shadow execution**

  In the input handler, preserve the existing delegation claim before the shadow branch. For unclaimed eligible interactive text-only input, after `routePrompt` resolves:
  - select the routed model or current model;
  - capture `ctx.getContextUsage()?.tokens ?? null`;
  - apply `shouldSampleShadow(config.delegation.measurement.sampleRate, random())`;
  - if sampled and no shadow is active, arm parent correlation and start a detached shadow promise; if the sample is rejected, make no planner call or state entry; if a sample is accepted while another shadow is active, record a `skipped` shadow entry with reason `shadow active` and make no provider call.

  The detached shadow reuses discovery, allowlist intersection, repository index loading, and `planWorkflow`. If no eligible agent exists, record `skipped` without planning. Otherwise record planner usage and a `delegate`/`decline` outcome; on a delegate decision store only agent name and task length. Catch timeout/provider/discovery/index errors, record a concise shadow failure, log it, and never reject or delay the original main input. Abort and finalize as cancelled on session lifecycle shutdown.

- [ ] **Step 6: Capture actual delegated planner/child usage and replay correlation**

  Add the parent context estimate to the workflow's measurement metadata at claim time. After `planWorkflow`, normalize optional `plan.usage` into the planner snapshot. After `execute`, normalize `result.usage` into the child snapshot. Preserve every existing lifecycle status, result rendering, guarded failure replay, cancellation, and `finally` release behavior.

  Before each existing `sendUserMessage` replay, arm a parent correlation with the original request as the expected prefix. When its callback fires, append a compact same-run measurement entry containing the aggregate parent usage. If the request is never confirmed or a session lifecycle resets, expire/clear the callback without replaying or attributing a later turn.

- [ ] **Step 7: Run focused extension tests and commit the integrated behavior**

  Run:
  ```bash
  bun test test/extension.test.ts
  ```
  Expected: PASS, including all existing delegation behavior and the new shadow/usage/correlation tests. Commit with:
  ```bash
  git add src/extension.ts test/extension.test.ts
  git commit -m "feat: measure sampled delegation costs"
  ```

---

### Task 4: Preserve setup behavior and document opt-in measurement

**Files:**
- Modify: `src/setup.ts` (`RouterSetupValues`, config writer)
- Modify: `test/setup.test.ts` (measurement preservation)
- Modify: `README.md` (complete config, field table, delegation section, status behavior)

**Interfaces:**
- Consumes: resolved `RouterDelegationConfig` with measurement fields and existing setup writer behavior.
- Produces: setup writes existing owned delegation keys while preserving an existing `delegation.measurement` object; README gives the exact JSON and sampling semantics.

- [ ] **Step 1: Add a failing setup preservation test**

  Seed a project config with `delegation.measurement: { enabled: true, sampleRate: 0.5 }`, run the existing setup harness, and assert the written config keeps that nested object while changing only the setup-owned delegation fields. Add the complete measurement object to the fixture config used by setup tests.

- [ ] **Step 2: Run the focused setup test and confirm it fails**

  Run:
  ```bash
  bun test test/setup.test.ts
  ```
  Expected: the test fails because the current setup value type and writer do not carry the new resolved measurement fields.

- [ ] **Step 3: Preserve measurement through setup and update README**

  Keep `RouterSetupValues.delegation` limited to the setup-owned `enabled`, `plannerTimeoutMs`, and `agents` fields, and continue spreading the existing raw delegation object before replacing those keys. This preserves measurement and unknown nested delegation fields without adding a UI control.

  Update README configuration JSON/table and delegation docs to state:
  - measurement defaults off with a `0.1` sample rate;
  - samples cover unclaimed, sufficiently long, text-only interactive main-path prompts;
  - the shadow planner never executes a child or forwards parent context;
  - planner/child/parent usage fields include cache-read/cache-write and provider cost when reported;
  - `/route status` reports measurement state and rate, `/route reload` reloads JSON only, and `/usage` remains outside the router.

- [ ] **Step 4: Run focused setup tests and commit documentation**

  Run:
  ```bash
  bun test test/setup.test.ts
  ```
  Expected: PASS. Commit with:
  ```bash
  git add src/setup.ts test/setup.test.ts README.md
  git commit -m "docs: describe delegation measurement"
  ```

---

### Task 5: Run repository verification and smoke checks

**Files:**
- Modify: none unless a verified test/check failure exposes an implementation defect.

**Interfaces:**
- Consumes: all preceding committed changes.
- Produces: verified branch pushed to PR #4 with no unverified completion claim.

- [ ] **Step 1: Run focused regression suites**

  Run:
  ```bash
  bun test test/config.test.ts test/measurement.test.ts test/delegation.test.ts test/extension.test.ts test/setup.test.ts
  ```
  Expected: PASS with existing router/delegation behavior intact.

- [ ] **Step 2: Run the complete test and static checks**

  Run:
  ```bash
  bun test
  bun run check
  ```
  Expected: all tests pass and Biome/tsgo report no errors.

- [ ] **Step 3: Smoke-test the opt-in path**

  In a fresh OMP process using the project config, enable measurement with `sampleRate: 1`, submit a sufficiently long ordinary prompt, and verify a `model-router-delegation` shadow entry appears while the normal main turn still runs. Confirm a delegate shadow produces no child result message. Enable standalone delegation separately and verify planner/child usage metadata appears. Run `/usage` and confirm it opens without a shadow/planner call.

- [ ] **Step 4: Review diff, push, and update PR #4**

  Inspect the final diff for accidental prompt/task/result leakage in new measurement metadata. Push `feat/subagent-dispatch` and update PR #4 with the focused/full verification results and the fact that contextual transcript forwarding remains intentionally unimplemented.
