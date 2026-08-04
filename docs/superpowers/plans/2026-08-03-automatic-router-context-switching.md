# Automatic Router Context Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the router's cheap automatic baseline after each terminal high-effort turn without changing manual routing, delegation semantics, or `/parallel` workflows.

**Architecture:** Add a guarded baseline-restoration helper inside the extension factory. Automatic classification records the current session generation for the selected target; terminal main-agent completion invokes the helper, while detached delegation invokes it on child settlement unless it is replaying the original request, which is restored by that replay's terminal `agent_end`. Current-model and generation checks prevent manual changes and stale lifecycle events from being overwritten.

**Tech Stack:** TypeScript, Bun tests, OMP public `ExtensionAPI`, `AbortSignal`/generation fencing, existing router state and model helpers.

## Global Constraints

- `/parallel` behavior, concurrency, background execution, and persisted workflow schemas remain unchanged.
- Only automatic router selections are eligible for reset; `/route manual`, `/route off`, one-shot selectors, and recognized external model changes are not reset.
- A restore is allowed only when the current model still matches the last automatic target and the route generation matches the current session generation.
- No provider pricing, token accounting, or global spend ledger is added.
- Use existing model resolution, authentication, persistence, warning, and thinking-level behavior.
- Add failing behavioral tests before implementation code.

---

### Task 1: Specify failing automatic-reset behavior

**Files:**
- Modify: `test/extension.test.ts` in the main routing and delegation describe blocks
- Read: `src/extension.ts` for existing lifecycle and delegation seams

**Interfaces:**
- Consumes: `Harness.input`, `Harness.agentEnd`, `Harness.lifecycle`, `Harness.settle`, `harness.setModelCalls`, `harness.current`, and `harness.state()`.
- Produces: deterministic failing tests proving the reset boundary and its fences.

- [ ] **Step 1: Add the normal terminal-turn regression test**

Add a test that starts in `base`, classifies one prompt as `high`, and verifies the target `slow` is selected. Call `agentEnd(false)`, then assert the model-switch sequence is `slow` followed by `base`, the current model is `base`, and the router's observed/last automatic identities are the baseline. Send a short follow-up below the classifier minimum and assert it starts on `base` without an additional classifier prompt.

```ts
it("returns to the cheap baseline after a terminal automatic turn", async () => {
	const harness = new Harness();
	harness.classifications = ["high"];
	await harness.lifecycle();
	await harness.input("debug this cross-system race");
	expect(harness.setModelCalls.map(model => model.id)).toEqual(["slow"]);

	await harness.agentEnd(false);

	expect(harness.setModelCalls.map(model => model.id)).toEqual(["slow", "base"]);
	expect(harness.current).toBe(base);
	expect(harness.state()).toMatchObject({
		observedModel: { provider: "mock", id: "base" },
		lastAutoModel: { provider: "mock", id: "base" },
	});
	const classified = harness.classifierPrompts.length;
	await harness.input("ok");
	expect(harness.current).toBe(base);
	expect(harness.classifierPrompts).toHaveLength(classified);
});
```

- [ ] **Step 2: Add continuation and manual-override fence tests**

Cover two boundaries: `agentEnd(true)` must not restore the target; changing `harness.current` to another model before `agentEnd(false)` must not cause the helper to replace that manual choice. Assert no baseline switch occurs in both cases.

- [ ] **Step 3: Add detached delegation reset tests**

Extend the existing successful delegation coverage so a child completion returns from `smol` to `base`. Add a pass-through case where the planner returns `delegate: false`: after the original request is replayed, assert the routed model remains selected until `agentEnd(false)`, then assert it restores. Add a child failure or cancellation assertion that the detached workflow also returns to baseline.

- [ ] **Step 4: Add stale lifecycle fencing coverage**

Route a high-effort prompt, trigger `session_switch` before terminal completion, then call `agentEnd(false)`. Assert no stale `setModel(...base)` call occurs after the successor lifecycle. Keep existing delegated-route stale no-op assertions intact.

- [ ] **Step 5: Run the focused tests and confirm they fail for the missing restore**

Run:

```bash
bun test test/extension.test.ts
```

Expected: the new tests fail because the current implementation has no terminal baseline restore; existing tests remain the control group.

---

### Task 2: Implement guarded automatic baseline restoration

**Files:**
- Modify: `src/extension.ts` near delegation generation, route application, delegation processing, and `agent_end`
- Test: `test/extension.test.ts` from Task 1

**Interfaces:**
- Consumes: `RouterState.baseline`, `RouterState.lastAutoModel`, `identityOf`, `formatModelSelector`, `modelsEqual`, `currentModel`, `switchModel`, `ensureState`, `persist`, and `delegationGeneration`.
- Produces: an internal helper with behavior equivalent to `restoreAutomaticBaseline(ctx, generation)` and an internal automatic-route generation marker.

- [ ] **Step 1: Add the automatic-route generation marker**

Add a module-factory-local `automaticRouteGeneration: number | undefined`. Set it only when `applyRoutePrompt` selects a target through normal automatic classification (`oneShotSelector === undefined`). Clear it on session lifecycle invalidation and when routing transitions to manual/off. Do not mark one-shot selections as automatic reset candidates.

- [ ] **Step 2: Implement the guarded restoration helper**

Add `restoreAutomaticBaseline(ctx, generation)` that returns without side effects unless all of these hold:

```ts
runtime.mode === "auto"
automaticRouteGeneration === generation
runtime.baseline !== null
runtime.lastAutoModel !== null
modelsEqual(currentModel(ctx), ctx.models.resolve(formatModelSelector(runtime.lastAutoModel)))
```

Resolve the baseline identity. If it cannot resolve, use the existing baseline warning path and leave the current model unchanged. If the current model already equals the baseline, update observed/last automatic identities and persist without calling `setModel`. Otherwise call `switchModel(baselineModel)`; on success update both identities and persist, and on failure warn through the existing bounded baseline-auth path without overwriting the current model.

- [ ] **Step 3: Wire terminal main-agent completion**

In the existing `agent_end` handler, preserve the measurement settlement logic and, only when `event.willContinue !== true`, await `restoreAutomaticBaseline(ctx, delegationGeneration)`. A stale generation or manual model change must make this a no-op.

- [ ] **Step 4: Wire detached delegation settlement**

Track `replayOriginalPending` inside `processDelegation`. Set it when `replayOriginal` sends the original request; leave restoration to that replay's terminal `agent_end`. In the workflow `finally`, when replay is not pending, await `restoreAutomaticBaseline(ctx, workflow.generation)` before releasing the active delegation. This covers delegated child success, failure, cancellation, and planner failures without changing the existing messages or records.

- [ ] **Step 5: Run the focused tests and verify the new behavior passes**

Run:

```bash
bun test test/extension.test.ts
```

Expected: all routing, delegation, stale-workflow, measurement, and new reset tests pass.

---

### Task 3: Document the lifecycle correction

**Files:**
- Modify: `README.md` in the router baseline/fallback section
- Keep: `docs/superpowers/specs/2026-08-03-parallel-usage-safety-design.md` as the approved design record

**Interfaces:**
- Consumes: the implemented terminal restore and delegation settlement behavior.
- Produces: user-facing documentation stating that automatic target selection lasts for one terminal task and then returns to the stored baseline; manual mode and `/parallel` remain unchanged.

- [ ] **Step 1: Add the automatic model lifetime note**

Document that normal automatic routes remain selected during the active response, reset after terminal `agent_end`, and reset after detached delegation settles. State that `willContinue` phases do not reset and manual/external model changes are not overwritten.

- [ ] **Step 2: Review the documentation against the safety invariants**

Confirm the README does not claim that `/parallel` inherits or participates in router resets and does not promise provider cost enforcement.

---

### Task 4: Verify and deliver

**Files:**
- Test: `test/extension.test.ts`
- Test: repository test suite
- Modify: none unless verification exposes a real regression

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: verified branch commit and updated PR.

- [ ] **Step 1: Run focused validation**

```bash
bun test test/extension.test.ts
bun run check:types
bun run check
```

- [ ] **Step 2: Run the complete suite and whitespace check**

```bash
bun test
git diff --check
```

Expected: all tests pass, formatting/type checks pass, and no whitespace errors are reported.

- [ ] **Step 3: Commit the implementation**

```bash
git add src/extension.ts test/extension.test.ts README.md docs/superpowers/specs/2026-08-03-parallel-usage-safety-design.md docs/superpowers/plans/2026-08-03-automatic-router-context-switching.md
git commit -m "Restore baseline after automatic router turns"
```

- [ ] **Step 4: Push and update the existing pull request**

Push `feat/contract-first-parallel-workflows`, then comment on PR #5 with the new commit and verification results. Do not change `/parallel` behavior or create a separate pull request.
