# Contract-First Parallel Workflows Plugin Plan

> For implementation: use the `subagent-driven-development` workflow task-by-task. This plan is for the existing `effort-aware-model-router` OMP extension. It must not modify or fork OMP core.

**Goal:** Add an opt-in, contract-first parallel workflow coordinator to the existing installable OMP extension. A YAML manifest describes shards, file ownership, produced/required contracts, dependencies, and read-only review gates. The extension validates the complete plan before dispatch, runs ready shards in bounded isolated worktrees through OMP's public task APIs, persists state in a plugin-owned SQLite database, and exposes `/parallel` lifecycle commands.

**Repository:** `jack60612/effort-aware-model-router`
**Base branch:** `feat/subagent-dispatch`
**Feature branch:** `feat/contract-first-parallel-workflows`

## Hard boundaries

- No changes under OMP source. No OMP fork, core patch, private `ToolSession`, or `TaskTool` construction.
- Use only public OMP imports: `@oh-my-pi/pi-coding-agent/task`, `@oh-my-pi/pi-coding-agent/task/executor`, and the exported `@oh-my-pi/pi-coding-agent/task/worktree` helpers where needed.
- Existing effort classification, routing, delegation, slash-command bypass, and session-state versioning remain unchanged.
- `/parallel` is a plugin command registered through `ExtensionAPI`; there is no new top-level `omp` CLI command.
- A workflow never claims ordinary interactive input. It starts only from an explicit `/parallel` command.
- Manifest content, command arguments, model selectors, agent names, contract IDs, and paths are untrusted input. Reject invalid values; never interpolate unvalidated values into shell command strings.
- All shard execution is isolated. The parent checkout's uncommitted edits are preserved by the public worktree helpers.
- Review agents must pass `isReadOnlyAgent`; a configured reviewer with write-capable tools is rejected before dispatch.
- Successful shard execution does not auto-merge. Integration is an explicit command and requires every required review to be approved.
- No live model credentials in tests. Inject discovery, subagent execution, filesystem/git helpers, clock, IDs, and store paths.

## Manifest contract

The supported manifest is YAML parsed with Bun's built-in `Bun.YAML.parse`. The parser accepts one object and rejects unknown shape, inherited properties, duplicate IDs, blank values, and unsafe paths.

```yaml
run: cache-aware-delegation
model: "@smol"
maxConcurrency: 4
contracts:
  - id: delegation-config-v1
    description: Validated delegation configuration and defaults.
    owner: delegation-config
shards:
  - id: delegation-config
    kind: implementation
    agent: task
    prompt: Implement and test the delegation configuration contract.
    owns:
      - src/config.ts
      - test/config.test.ts
    produces:
      - delegation-config-v1
    requires: []
    dependsOn: []
    review:
      agent: reviewer
      required: true
```

Contract invariants:

- IDs match `[a-z0-9][a-z0-9-]{0,63}` and are unique within their collection.
- `run`, `kind`, `agent`, `prompt`, and contract descriptions are trimmed non-empty strings with bounded lengths.
- `maxConcurrency` is an integer from 1 through 32.
- `model` is optional, but when present is a trimmed selector no longer than 200 characters.
- Every contract has exactly one shard owner. The owner shard must list that contract in `produces`.
- Every `produces` and `requires` reference names an existing contract. A shard may not produce a contract owned by another shard.
- Every required contract's owner must appear in the requiring shard's `dependsOn`; this prevents implicit edges hidden in prose.
- Every dependency names a shard, is not self-referential, and the graph is acyclic.
- `owns` paths are normalized project-relative POSIX paths. Absolute paths, `..`, empty paths, backslashes, duplicate paths, and overlapping paths across shards are rejected. A path may be owned by only one shard.
- A required review has a non-empty agent name and `required: true`; optional review entries are allowed but never gate integration.
- The plan hash is SHA-256 over a canonical, normalized representation. The stored plan is immutable for a run.

## Public contracts produced by the implementation

`src/parallel/contracts.ts` produces:

```ts
export interface ParallelContractSpec {
  id: string;
  description: string;
  owner: string;
}

export interface ParallelReviewSpec {
  agent: string;
  required: boolean;
}

export interface ParallelShardSpec {
  id: string;
  kind: string;
  agent: string;
  prompt: string;
  owns: readonly string[];
  produces: readonly string[];
  requires: readonly string[];
  dependsOn: readonly string[];
  review?: ParallelReviewSpec;
}

export interface ParallelWorkflowManifest {
  run: string;
  model?: string;
  maxConcurrency: number;
  contracts: readonly ParallelContractSpec[];
  shards: readonly ParallelShardSpec[];
}

export interface ParallelWorkflowPlan extends ParallelWorkflowManifest {
  sourcePath: string;
  planHash: string;
}

export type ParallelShardStatus =
  | "pending"
  | "running"
  | "completed"
  | "review_pending"
  | "approved"
  | "rejected"
  | "failed"
  | "cancelled"
  | "interrupted";

export type ParallelReviewStatus =
  | "pending"
  | "running"
  | "approved"
  | "rejected"
  | "failed"
  | "cancelled"
  | "interrupted";

export type ParallelRunStatus =
  | "planned"
  | "running"
  | "review_pending"
  | "ready_to_integrate"
  | "integrating"
  | "integrated"
  | "failed"
  | "cancelled"
  | "interrupted";

export function parseParallelWorkflowManifest(text: string, sourcePath: string): ParallelWorkflowPlan;
export function loadParallelWorkflowManifest(sourcePath: string): Promise<ParallelWorkflowPlan>;
export function validateParallelWorkflowManifest(input: unknown, sourcePath: string): ParallelWorkflowPlan;
export function getParallelDependencyWaves(plan: ParallelWorkflowPlan): readonly (readonly ParallelShardSpec[])[];
export function canonicalParallelPlan(plan: ParallelWorkflowManifest): string;
```

`src/parallel/scheduler.ts` additionally produces pure transitions and readiness helpers. The scheduler never performs I/O or provider work:

```ts
export interface ParallelShardState {
  id: string;
  status: ParallelShardStatus;
  branchName: string | null;
  baseSha: string | null;
  error: string | null;
}

export interface ParallelReviewState {
  shardId: string;
  status: ParallelReviewStatus;
  summary: string | null;
  findings: readonly ParallelReviewFinding[];
  error: string | null;
}

export interface ParallelReviewFinding {
  path: string;
  line?: number;
  message: string;
}

export interface ParallelSchedulerDecision {
  ready: readonly ParallelShardSpec[];
  blocked: readonly ParallelShardSpec[];
  terminal: boolean;
}
```

## Durable store contract

`src/parallel/storage.ts` owns a versioned SQLite database. The database is plugin state, not the OMP session transcript.

- Location: `$XDG_STATE_HOME/omp/parallel/<project-key>.sqlite`, falling back to `~/.local/state/omp/parallel/<project-key>.sqlite`. `project-key` is a stable SHA-256 prefix of the resolved repository root; no raw user path is placed in the filename.
- Open with WAL, `synchronous=NORMAL`, `foreign_keys=ON`, and a bounded busy timeout.
- Schema version is held in `PRAGMA user_version`; migrations fail closed on unknown versions.
- Tables: `workflow_runs`, `workflow_shards`, `workflow_reviews`. Foreign keys cascade only from a run to its child rows.
- JSON fields are parsed defensively and never trusted as executable input.
- A run stores `runId`, `cwd`, `repoRoot`, `planHash`, normalized plan JSON, base SHA, status, timestamps, and last error.
- A shard stores its immutable spec ID, status, branch name, base SHA, output excerpt, error, and timestamps.
- A review stores shard ID, reviewer agent, status, bounded summary/findings JSON, and timestamps.
- Opening a database marks `running` shard/review rows as `interrupted` and `running` runs as `interrupted`; `resume` can requeue those rows.

The store exports `ParallelWorkflowStore.openForCwd(cwd, options?)`, `createRun`, `getRun`, `listRuns`, `updateRun`, `updateShard`, `updateReview`, and `close`. All writes use transactions where multiple rows must move together.

## Coordinator contract

`src/parallel/coordinator.ts` owns preflight, dispatch, review gates, cancellation, recovery, and integration. It consumes the contracts/store/scheduler modules and the public OMP task/worktree APIs.

```ts
export interface ParallelSubagentRequest {
  cwd: string;
  worktree: string;
  agent: AgentDefinition;
  task: string;
  id: string;
  index: number;
  modelOverride?: string;
  signal: AbortSignal;
}

export type ParallelSubagentRunner = (
  request: ParallelSubagentRequest,
) => Promise<Pick<SingleResult, "exitCode" | "output" | "stderr" | "error" | "aborted" | "abortReason" | "durationMs">>;

export interface ParallelCoordinatorHost {
  cwd: string;
  currentModelSelector?: string;
  exec: ExtensionAPI["exec"];
  discover: typeof discoverAgents;
  runSubagent: ParallelSubagentRunner;
}

export interface ParallelCoordinatorDependencies {
  store: ParallelWorkflowStore;
  now?: () => number;
  createRunId?: () => string;
  getRepoRoot?: typeof getRepoRoot;
  captureBaseline?: typeof captureBaseline;
  ensureIsolation?: typeof ensureIsolation;
  commitToBranch?: typeof commitToBranch;
  cleanupIsolation?: typeof cleanupIsolation;
  mergeTaskBranches?: typeof mergeTaskBranches;
  cleanupTaskBranches?: typeof cleanupTaskBranches;
}

export interface ParallelRunSnapshot {
  run: ParallelRunRecord;
  shards: readonly ParallelShardRecord[];
  reviews: readonly ParallelReviewRecord[];
}

export class ParallelCoordinator {
  preflight(plan: ParallelWorkflowPlan): Promise<ParallelPreflightResult>;
  createRun(plan: ParallelWorkflowPlan): Promise<ParallelRunSnapshot>;
  resume(runId: string): Promise<ParallelRunSnapshot>;
  review(runId: string): Promise<ParallelRunSnapshot>;
  cancel(runId: string): Promise<ParallelRunSnapshot>;
  integrate(runId: string): Promise<ParallelRunSnapshot>;
  status(runId?: string): Promise<ParallelRunSnapshot | readonly ParallelRunSummary[]>;
  wait(runId: string): Promise<ParallelRunSnapshot>;
}
```

Execution rules:

1. `preflight` resolves the repository root, current base SHA, selected model, discovered agents, and all shard/reviewer names. It rejects missing agents, missing reviewers, non-read-only required reviewers, and a dirty/non-Git workspace only when isolation cannot be safely prepared. It does not call a model.
2. `createRun` stores the immutable plan and initial rows only after preflight succeeds.
3. `resume` takes a per-run abort controller, marks the run running, requeues interrupted rows, and processes dependency waves. Ready shards are bounded by `maxConcurrency`; a failed shard blocks dependents and ends the run failed.
4. Each implementation shard captures the parent baseline, calls public `ensureIsolation`, runs `runSubprocess` with `worktree: isolation.mergedDir`, then calls `commitToBranch` and `cleanupIsolation` in `finally`. The branch/base SHA are persisted before the shard becomes review-pending.
5. Required reviews run only after a shard has a branch/result. Review execution materializes a temporary detached Git worktree at the shard branch, runs a verified read-only reviewer through the same public `runSubprocess` seam, parses strict JSON, persists bounded findings, and removes the temporary worktree. A missing/invalid review fails closed.
6. A rejected review leaves the run in `review_pending` and can be retried with `review`. `resume` never bypasses a required rejection.
7. `integrate` requires every shard terminal-successful and every required review approved. It calls `mergeTaskBranches` in stable plan order, persists the merge result, then calls `cleanupTaskBranches` only for branches that merged. Conflicts leave the run `failed` with branch artifacts retained.
8. `cancel` aborts active work, marks non-terminal rows cancelled, and never replays or integrates. Cleanup remains in each shard/review `finally` block.
9. `wait` resolves when the run reaches a terminal or operator-action state. It never busy-spins; tests may inject a clock/waiter.

## Plugin command surface

`src/parallel/commands.ts` parses command arguments without shell evaluation. `extension.ts` registers:

```text
/parallel plan <manifest.yml>
/parallel status [<run-id>]
/parallel resume <run-id> [--wait]
/parallel review <run-id> [--wait]
/parallel cancel <run-id>
/parallel integrate <run-id> [--wait]
```

`--json` is accepted for status/lifecycle commands and renders a bounded serialized snapshot through `ctx.ui.notify`. Human output includes the run ID, status, shard counts, review counts, and the next allowed action. Argument completions expose the six subcommands and known run IDs. `/route` behavior and existing `/route cancel` behavior remain unchanged.

## Tests and verification

Focused tests must defend observable contracts:

- `test/parallel-contracts.test.ts`: YAML/JSON parse, bounds, path normalization/overlap, exact contract ownership, missing refs, implicit dependency rejection, cycle detection, stable hash, and deterministic waves.
- `test/parallel-storage.test.ts`: schema creation/migration, run/shard/review round trips, plan immutability, defensive JSON handling, and interrupted-run recovery using a temporary state directory.
- `test/parallel-coordinator.test.ts`: preflight agent/reviewer gates, bounded wave dispatch, isolated branch capture, review rejection/retry, cancellation, failure blocking, and integration conflict preservation through injected helpers.
- `test/parallel-commands.test.ts`: command parsing/completions and handler routing with a fake coordinator.
- Existing router/config/delegation/extension tests remain green.

Verification order:

1. Focused new tests after each task.
2. `bun run check:types` and `bun test` in the plugin repository.
3. `bun run check` and a smoke scenario with fake agents/git helpers; no live credentials required.
4. Review the complete branch, record the existing baseline/native limitations if they affect verification, commit, push, and open a PR using the plugin repository template.
 
## Task 1: Workflow contracts and dependency scheduler

**Files:**

- Create `src/parallel/contracts.ts`
- Create `src/parallel/scheduler.ts`
- Create `src/parallel/index.ts`
- Create `test/parallel-contracts.test.ts`

**Requirements:**

- Implement the public contract types and functions defined above.
- Parse Bun YAML and JSON-shaped YAML values; reject malformed top-level values with actionable errors.
- Normalize and validate every field before computing the SHA-256 plan hash. Canonical output must be deterministic for equivalent normalized input.
- Enforce exact contract ownership, explicit dependency edges for `requires`, unique non-overlapping project-relative paths, stable IDs, max concurrency bounds, and acyclic dependencies.
- Keep scheduler decisions pure and stable in manifest shard order. A shard is ready only when every dependency is approved/completed and no required review is pending or rejected.
- Tests must cover valid manifests, each rejection boundary, deterministic hashes, cycles, and wave ordering. Tests must not invoke OMP or live providers.
- Run `bun test test/parallel-contracts.test.ts`. Commit with `feat(plugin): add parallel workflow contracts`.

## Task 2: Durable plugin workflow state

**Files:**

- Create `src/parallel/storage.ts`
- Create `test/parallel-storage.test.ts`

**Requirements:**

- Implement `ParallelWorkflowStore` with the storage contract above using `bun:sqlite`.
- Resolve the XDG state path and project key without exposing the raw repository path in filenames.
- Configure WAL, `synchronous=NORMAL`, foreign keys, busy timeout, and a schema version. Reject unknown schema versions.
- Store normalized immutable plan JSON/hash plus run, shard, and review rows. Use transactions for run creation and state transitions.
- Bound stored output, summaries, errors, and review findings. Parse JSON defensively.
- On open, mark interrupted rows/runs as recoverable. Do not silently delete branch names or artifacts.
- Tests use temporary state directories and verify round trips, immutability, migrations, and interruption recovery.
- Run `bun test test/parallel-storage.test.ts`. Commit with `feat(plugin): persist parallel workflow state`.

## Task 3: Isolated shard and review coordinator

**Files:**

- Create `src/parallel/coordinator.ts`
- Create `test/parallel-coordinator.test.ts`

**Requirements:**

- Implement `ParallelCoordinator` and its host/dependency contracts.
- Use `discoverAgents`, `isReadOnlyAgent`, `runSubprocess`, and exported task/worktree helpers only. Keep all provider and git operations behind injected seams.
- Preflight must validate all shard agents and required reviewers before any subagent runs.
- Dispatch dependency-ready shards with the manifest concurrency cap. Each implementation run uses `ensureIsolation`, `runSubprocess({ worktree })`, `commitToBranch`, and `cleanupIsolation` with cleanup in `finally`.
- Persist branch/base SHA before review. Required reviewers run against a detached branch worktree, must return strict bounded JSON, and reject malformed output.
- Implement review retry, cancellation, failure blocking, interrupted recovery, explicit integration via `mergeTaskBranches`, and cleanup only for merged branches.
- Never auto-merge, replay user prompts, or mutate the router's existing session state.
- Tests inject fake agents, runners, worktree/merge helpers, IDs, and store. Exercise concurrency, branch capture, rejection/retry, cancellation, failure blocking, and conflict preservation.
- Run `bun test test/parallel-coordinator.test.ts`. Commit with `feat(plugin): coordinate isolated parallel workflows`.

## Task 4: Plugin command integration and documentation

**Files:**

- Create `src/parallel/commands.ts`
- Create `test/parallel-commands.test.ts`
- Modify `src/extension.ts`
- Modify `src/AGENTS.md` only if the public worktree import boundary needs updating
- Modify `README.md`
- Modify `CHANGELOG.md`

**Requirements:**

- Parse `/parallel` commands, flags, and arguments without shell evaluation. Add completions for subcommands and known run IDs.
- Register `/parallel` through `ExtensionAPI` and route commands to one coordinator per current working directory. Keep `/route` command behavior unchanged.
- Use `pi.exec` for the host command seam and display bounded human/JSON status through the extension UI. Long-running resume/review/integrate commands must return control promptly unless `--wait` is supplied.
- Document manifest shape, contract/path rules, lifecycle commands, explicit review/integration, persistence location, cancellation/recovery, and the fact that this remains an installable plugin with no OMP fork/core patch.
- Add a changelog entry without rewriting unrelated history.
- Run `bun test test/parallel-commands.test.ts test/extension.test.ts`. Commit with `feat(plugin): expose parallel workflow commands`.

## Task 5: Integration coverage and delivery cleanup

**Files:**

- Modify the focused parallel tests or add `test/parallel-integration.test.ts` only where an end-to-end plugin-owned contract is not already covered.

**Requirements:**

- Exercise the registered `/parallel` command against a fake coordinator and a temporary manifest, proving plan → resume → review → integrate state flow without live credentials.
- Verify existing `/route` and delegation tests remain unaffected, especially slash bypass and session lifecycle cancellation.
- Run focused parallel tests, `bun run check:types`, `bun test`, and `bun run check`; distinguish any pre-existing environment/native failures from regressions.
- Review the final branch for forbidden OMP-core edits, unsafe path/shell handling, unbounded persistence, and missing cleanup.
- Commit any final test-only changes with `test(plugin): cover parallel workflow lifecycle`.
