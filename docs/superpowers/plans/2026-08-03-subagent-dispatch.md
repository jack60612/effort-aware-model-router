# Subagent Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add scoped repository instructions and opt-in selected-model planning that dispatches self-contained interactive requests directly to an appropriate OMP subagent without a main-agent inference turn.

**Architecture:** Keep effort classification and route selection intact, add a pure/testable delegation planner module, then let `extension.ts` own one asynchronous delegation workflow per session. Eligible input is durably copied and handled immediately; planner pass-throughs and failures replay as ordered main-session follow-ups, while successful subagent results are rendered and retained as main-session context.

**Tech Stack:** TypeScript, Bun test, `@oh-my-pi/pi-ai` direct completions, public `@oh-my-pi/pi-coding-agent/task` discovery, public `@oh-my-pi/pi-coding-agent/task/executor`, and `@oh-my-pi/pi-tui` rendering.

## Global Constraints

- Delegation defaults to disabled.
- The only allowed agents by default are `scout`, `sonic`, `task`, `designer`, `reviewer`, and `security-reviewer`.
- `plannerTimeoutMs` defaults to 20,000 and accepts positive safe integers no greater than 120,000.
- Slash commands and inputs beginning with `->` or `=>` bypass classification, planning, and execution.
- Images, prompts shorter than `classifierMinPromptChars`, non-interactive sources, and inputs received during an active workflow stay on the main path.
- Use only `@oh-my-pi/pi-coding-agent/task` for discovery and `@oh-my-pi/pi-coding-agent/task/executor` for direct execution; do not construct `TaskTool`.
- A successful delegated result must not trigger a main-model turn.
- Explicit cancellation and session shutdown never replay the request.
- Tests must not require live model credentials.

---

## File Structure

- Create `AGENTS.md`: repository map, commands, compatibility invariants.
- Create `src/AGENTS.md`: source-module ownership and public API boundaries.
- Create `test/AGENTS.md`: source/test mapping and behavior-test rules.
- Modify `src/config.ts`: delegation config type, defaults, untrusted parsing, and layered merge.
- Modify `src/setup.ts`: opt-in prompt and preservation of advanced delegation values.
- Modify `test/config.test.ts`: delegation default/validation/layer tests.
- Modify `test/setup.test.ts`: delegation setup/write preservation tests.
- Create `src/delegation.ts`: prompt construction, strict plan parsing, repository index loading, and selected-model planning call.
- Create `test/delegation.test.ts`: deterministic planner/parser/index tests.
- Modify `src/extension.ts`: workflow ownership, routing result, discovery/execution, replay, cancellation, state, and rendering.
- Modify `test/extension.test.ts`: immediate handling, bypass, lifecycle, replay, cancellation, and result-context tests.
- Modify `package.json` and `bun.lock`: direct TUI peer/dev dependency for the renderer.
- Modify `README.md`: config, behavior, limitations, cancel command, and restart note for source updates.

---

### Task 1: Scoped Repository Instruction Index

**Files:**
- Create: `AGENTS.md`
- Create: `src/AGENTS.md`
- Create: `test/AGENTS.md`

**Interfaces:**
- Consumes: the current six-module source layout and Bun scripts from `package.json`.
- Produces: OMP directory-scoped instructions inherited by root, source, and test work.

- [ ] **Step 1: Write the root repository contract**

Create `AGENTS.md` with these exact sections and facts:

```markdown
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
```

- [ ] **Step 2: Write source ownership rules**

Create `src/AGENTS.md` with module ownership, the requirement to keep pure policy outside `extension.ts`, the exact public task import paths, no `AgentSession` construction for planning, and a requirement to update the matching test for observable behavior.

- [ ] **Step 3: Write test ownership rules**

Create `test/AGENTS.md` mapping each `src/*.ts` module to `test/<module>.test.ts`, including the new `delegation.ts` mapping. Require deterministic seams instead of live credentials, focused tests while iterating, and `bun test && bun run check` before delivery.

- [ ] **Step 4: Verify scope and commit**

Run:

```bash
bun test
```

Expected: 89 existing tests pass. Then commit:

```bash
git add AGENTS.md src/AGENTS.md test/AGENTS.md
git commit -m "docs: index router architecture for agents"
```

---

### Task 2: Delegation Configuration and Setup

**Files:**
- Modify: `src/config.ts`
- Modify: `src/setup.ts`
- Modify: `test/config.test.ts`
- Modify: `test/setup.test.ts`

**Interfaces:**
- Produces: `RouterDelegationConfig`, `DEFAULT_DELEGATION_AGENTS`, and `RouterConfig.delegation`.
- Produces: setup output that edits `delegation.enabled` while preserving `plannerTimeoutMs` and `agents`.
- Consumed by: Tasks 3 and 4.

- [ ] **Step 1: Write failing config tests**

Add tests asserting:

```ts
expect(DEFAULT_ROUTER_CONFIG.delegation).toEqual({
  enabled: false,
  plannerTimeoutMs: 20_000,
  agents: ["scout", "sonic", "task", "designer", "reviewer", "security-reviewer"],
});

expect(parseRouterConfigLayer({
  delegation: { enabled: true, plannerTimeoutMs: 45_000, agents: [" scout ", "task"] },
})).toEqual({
  delegation: { enabled: true, plannerTimeoutMs: 45_000, agents: ["scout", "task"] },
});
```

Cover partial nested layers, invalid roots, inherited properties, empty arrays, zero/negative/non-integer values, and `120_001`. Assert later files override individual delegation fields without erasing unchanged fields.

- [ ] **Step 2: Run config tests and observe failure**

Run:

```bash
bun test test/config.test.ts
```

Expected: failures because `RouterConfig.delegation` does not exist.

- [ ] **Step 3: Implement delegation config parsing and merging**

Add these contracts to `src/config.ts`:

```ts
export const DEFAULT_DELEGATION_AGENTS = [
  "scout",
  "sonic",
  "task",
  "designer",
  "reviewer",
  "security-reviewer",
] as const;

export interface RouterDelegationConfig {
  enabled: boolean;
  plannerTimeoutMs: number;
  agents: readonly string[];
}
```

Add `delegation: RouterDelegationConfig` to `RouterConfig` and `delegation?: Partial<RouterDelegationConfig>` to `RouterConfigLayer`. Parse only own nested properties. Reuse selector cleaning for `agents`; reject an empty normalized list. Merge nested fields independently and clone arrays at each default/load/merge boundary.

- [ ] **Step 4: Run config tests**

Run `bun test test/config.test.ts`.

Expected: all config tests pass.

- [ ] **Step 5: Write failing setup tests**

Add tests proving the setup flow asks whether to enable self-contained delegation and that `writeRouterConfigLayer` writes:

```json
"delegation": {
  "enabled": true,
  "plannerTimeoutMs": 20000,
  "agents": ["scout", "sonic", "task", "designer", "reviewer", "security-reviewer"]
}
```

Also prove unrelated JSON and current advanced delegation values survive a setup run that only changes `enabled`.

- [ ] **Step 6: Run setup tests and observe failure**

Run `bun test test/setup.test.ts`.

Expected: failure because setup has no delegation value or prompt.

- [ ] **Step 7: Implement setup support**

Extend `RouterSetupValues` with `delegation: RouterDelegationConfig`. Add one `confirm` step labeled `Enable self-contained subagent delegation?`, initialized from `config.delegation.enabled`. Copy the current timeout/agent values into the values object; do not ask advanced questions. Make `writeRouterConfigLayer` replace only the owned `delegation` keys and preserve unrelated root data.

- [ ] **Step 8: Run focused tests and commit**

Run:

```bash
bun test test/config.test.ts test/setup.test.ts
```

Expected: both files pass. Then commit:

```bash
git add src/config.ts src/setup.ts test/config.test.ts test/setup.test.ts
git commit -m "feat: configure opt-in subagent delegation"
```

---

### Task 3: Selected-Model Delegation Planner

**Files:**
- Create: `src/delegation.ts`
- Create: `test/delegation.test.ts`

**Interfaces:**
- Consumes: `RouterDelegationConfig`, selected `Model`, model registry/query-compatible credential surfaces.
- Produces:

```ts
export interface DelegationAgentOption { name: string; description?: string }
export type DelegationPlan =
  | { delegate: false; reason: string }
  | { delegate: true; agent: string; task: string };
export function parseDelegationPlan(text: string, allowedAgents: ReadonlySet<string>): DelegationPlan | undefined;
export function buildDelegationSystemPrompt(agents: readonly DelegationAgentOption[], repositoryIndex: string): string;
export async function loadRepositoryAgentIndex(cwd: string): Promise<string>;
export async function planDelegation(...): Promise<DelegationPlan>;
```

- Consumed by: Task 4.

- [ ] **Step 1: Write failing parser and prompt tests**

Test exact valid objects and reject code fences, leading prose, arrays, extra keys, wrong field types, blank `reason`, blank `task`, and agents outside the supplied set. Assert the system prompt lists only supplied names/descriptions and says prior conversation is unavailable.

- [ ] **Step 2: Write failing repository-index tests**

Create a temporary nested directory with root and nested `AGENTS.md` files. Assert `loadRepositoryAgentIndex` walks ancestors in root-to-leaf order, includes only `AGENTS.md`, applies a fixed character cap, and returns an empty string when no file is readable.

- [ ] **Step 3: Write failing planner-call tests**

Inject a fake completion and model registry. Assert `planDelegation`:

- authenticates the selected model;
- sends one user message containing the current prompt only;
- sets a bounded `maxTokens` and the planner abort signal;
- extracts text content and applies strict parsing;
- throws on missing credentials, provider error/abort, malformed output, or caller cancellation.

- [ ] **Step 4: Run planner tests and observe failure**

Run `bun test test/delegation.test.ts`.

Expected: module-not-found failure.

- [ ] **Step 5: Implement the pure planner module**

Use `completeSimple` directly, following `classifier.ts` credential and dependency-injection patterns. Use a strict JSON-only system prompt with this decision rule:

```text
Delegate only when the current request is independently executable without prior conversation.
Choose exactly one listed agent. Return one JSON object and no code fence:
{"delegate":true,"agent":"name","task":"complete standalone assignment"}
or
{"delegate":false,"reason":"short reason"}
```

Normalize the current request with the classifier's bounded preprocessing. Do not instantiate a coding-agent session. Use `AbortSignal.any` to combine caller cancellation and `AbortSignal.timeout(config.plannerTimeoutMs)`.

- [ ] **Step 6: Run focused tests and commit**

Run `bun test test/delegation.test.ts`.

Expected: all planner tests pass. Then commit:

```bash
git add src/delegation.ts test/delegation.test.ts
git commit -m "feat: plan selected-model subagent delegation"
```

---

### Task 4: Extension Delegation Lifecycle

**Files:**
- Modify: `src/extension.ts`
- Modify: `test/extension.test.ts`
- Modify: `package.json`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: `planDelegation`, `loadRepositoryAgentIndex`, `RouterConfig.delegation`, `discoverAgents`, and `runSubprocess`.
- Produces: one-workflow ownership, `/route cancel`, delegation custom state entries, rendered result messages, and ordered replay.

- [ ] **Step 1: Add renderer dependencies**

Add `@oh-my-pi/pi-tui: ^17.2.4` to `devDependencies` and `peerDependencies`, then run `bun install` to update `bun.lock`. Import `Text` for the custom delegated-result renderer.

- [ ] **Step 2: Extend the test harness before behavior tests**

Capture `registerMessageRenderer`, `sendMessage`, `sendUserMessage`, and `session_shutdown`. Represent sent user messages with their `deliverAs` option and sent custom messages with `triggerTurn`, `display`, `content`, and details. Inject deterministic planner/discovery/executor functions through `ModelRouterExtensionDependencies`.

- [ ] **Step 3: Write failing bypass and immediate-ownership tests**

Assert delegation never claims `/usage`, `/route status`, `-> shell`, `=> python`, image input, short input, non-interactive input, disabled config, manual/off state, or input while a workflow is active. For eligible input assert the handler resolves immediately to `{ handled: true }` before any injected deferred classifier/planner resolves and appends a pending delegation state entry.

- [ ] **Step 4: Write failing pass-through and selection tests**

Assert the asynchronous workflow:

- routes first and gives the selected model to the planner;
- supplies only discovered agents whose names appear in `config.delegation.agents`;
- replays malformed, timed-out, missing-agent, and `{ delegate: false }` plans via `sendUserMessage(original, { deliverAs: "followUp" })`;
- clears ownership before replay;
- never reinvokes planning for the extension-originated replay.

- [ ] **Step 5: Write failing execution/result tests**

For a valid plan, assert `runSubprocess` receives the discovered definition, standalone task, selected model selector, selected thinking effort, cwd, stable id/index, signal, and `keepAlive: false`. Assert success appends completed state and calls:

```ts
pi.sendMessage(
  {
    customType: MODEL_ROUTER_DELEGATION_MESSAGE,
    content: expect.stringContaining(result.output),
    display: true,
    details: expect.any(Object),
  },
  { triggerTurn: false },
);
```

Assert no `sendUserMessage` and no main turn on success.

- [ ] **Step 6: Write failing failure/cancellation tests**

Assert a nonzero/throwing child renders failure then replays a follow-up containing the original request and side-effect inspection warning. Assert `/route cancel` and `session_shutdown` abort during planning or execution, append cancelled state, clear ownership, and never replay. Assert `/route status` includes `delegation on|off` and active/idle state.

- [ ] **Step 7: Refactor routing to return the selected route**

Change `routePrompt` to return:

```ts
interface RoutedPrompt {
  model: Model;
  effort?: RouteEffort;
  thinking?: ExtensionThinkingLevel;
}
```

Return this only after route/model/thinking state is successfully applied. Preserve every current decision record and fallback. The existing nondelegated path still awaits `routePrompt` and returns unhandled.

- [ ] **Step 8: Implement workflow ownership and direct execution**

Add exact public imports:

```ts
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
```

Before returning handled, append a pending entry and assign an `AbortController`. Start `void processDelegation(...).catch(...)`. In the async pipeline route, discover/filter agents, load the repository index, plan, validate again, and execute. Clear ownership in a single `finally` guarded by run id so an old workflow cannot clear a newer one.

Use separate cancellation and timeout reasons. Planner timeout/failure replays; user/shutdown cancellation does not. Treat child failure as potentially side-effecting and use the guarded replay wording from the design spec.

- [ ] **Step 9: Register commands, shutdown, and renderer**

Extend command usage/completions with `cancel`. Register `MODEL_ROUTER_DELEGATION_MESSAGE` renderer using `Text`, preserving the message's plain string content. On `session_shutdown`, abort the active workflow. Update status output without changing persisted router state version; delegation workflow entries use a distinct custom entry key.

- [ ] **Step 10: Run focused tests and checks**

Run:

```bash
bun test test/extension.test.ts test/delegation.test.ts
bun run check
```

Expected: focused tests and type/style checks pass.

- [ ] **Step 11: Commit**

```bash
git add src/extension.ts test/extension.test.ts package.json bun.lock
git commit -m "feat: dispatch self-contained prompts to subagents"
```

---

### Task 5: User Documentation and End-to-End Verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: final config and command behavior.
- Produces: install/configuration/limitations guidance matching runtime behavior.

- [ ] **Step 1: Document delegation configuration**

Add the nested `delegation` defaults and explain that it is opt-in. State that the selected route model performs the compact self-contained/agent plan, then the same model override runs the selected agent.

- [ ] **Step 2: Document ingress and fallback semantics**

State that only idle interactive text can delegate; images, short prompts, slash commands, shell/Python prefixes, RPC/ACP input, queued follow-ups, and concurrent input stay on the main path. Explain successful results are shown directly without a main synthesis turn, while planning/failure pass-throughs become ordered main-session follow-ups.

- [ ] **Step 3: Document commands and source reload behavior**

Add `/route cancel`. State `/route reload` reloads JSON configuration only; after changing/upgrading extension source, restart OMP. Note that current `/usage` bypasses the router and a stale already-running process is the explanation if an old build still blocks it.

- [ ] **Step 4: Run permanent verification**

Run:

```bash
bun test
bun run check
```

Expected: all tests pass and Biome/type checks report no errors.

- [ ] **Step 5: Smoke test runtime behavior**

Use a fresh OMP process with a temporary config and deterministic/local test seams where credentials are unavailable. Verify:

1. `/usage` opens without classifier/planner/executor calls.
2. A self-contained prompt is handled, planned, and rendered from the selected agent without a main turn.
3. A contextual prompt is replayed once as a follow-up.
4. `/route cancel` aborts an active workflow without replay.
5. A planner timeout replays the original prompt once.

Record exact commands and observed outputs in the pull-request body; do not claim live-provider execution if only deterministic seams were exercised.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md
git commit -m "docs: explain subagent delegation behavior"
```

- [ ] **Step 7: Review, push, and open the pull request**

Run the repository review workflow, address correctness findings, push `feat/subagent-dispatch`, and open a pull request against `main`. Include the design spec, implementation plan, automated verification counts, smoke evidence, delegation default/limitations, and the no-code stale-process `/usage` diagnosis.
