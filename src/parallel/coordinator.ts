import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentDefinition, isReadOnlyAgent, type SingleResult } from "@oh-my-pi/pi-coding-agent/task";
import {
	type CommitToBranchResult,
	captureBaseline,
	captureDeltaPatch,
	cleanupIsolation,
	cleanupTaskBranches,
	commitToBranch,
	ensureIsolation,
	getRepoRoot,
	type IsolationHandle,
	type MergeBranchResult,
	mergeTaskBranches,
	type WorktreeBaseline,
} from "@oh-my-pi/pi-coding-agent/task/worktree";
import type { ParallelRunStatus, ParallelShardSpec, ParallelWorkflowPlan } from "./contracts";
import {
	decideParallelSchedule,
	type ParallelReviewFinding,
	type ParallelReviewState,
	type ParallelShardState,
} from "./scheduler";
import type {
	ParallelCreateRunInput,
	ParallelReviewPatch,
	ParallelRunPatch,
	ParallelRunSummary,
	ParallelShardPatch,
	ParallelStoredRun,
} from "./storage";

/** Largest reviewer output the JSON verdict parser will scan. */
export const PARALLEL_REVIEW_OUTPUT_MAX_CHARS = 100_000;

/** One dispatched subagent request; `worktree` is the isolated merged view. */
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

export type ParallelSubagentResult = Pick<
	SingleResult,
	"exitCode" | "output" | "stderr" | "error" | "aborted" | "abortReason" | "durationMs"
>;

export type ParallelSubagentRunner = (request: ParallelSubagentRequest) => Promise<ParallelSubagentResult>;

/** Structural subset of `ExtensionAPI["exec"]`; argv arrays, never shell strings. */
export type ParallelExec = (
	command: string,
	args: string[],
	options?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export interface ParallelCoordinatorHost {
	cwd: string;
	/** Router-selected model used when the plan declares no model. */
	currentModelSelector?: string;
	exec: ParallelExec;
	discover: (cwd: string) => Promise<{ agents: AgentDefinition[] }>;
	runSubagent: ParallelSubagentRunner;
}

/** Structural store contract satisfied by `ParallelWorkflowStore`. */
export interface ParallelCoordinatorStore {
	createRun(input: ParallelCreateRunInput): ParallelStoredRun;
	getRun(runId: string): ParallelStoredRun | null;
	listRuns(): readonly ParallelRunSummary[];
	updateRun(runId: string, patch: ParallelRunPatch): void;
	updateShard(runId: string, shardId: string, patch: ParallelShardPatch): void;
	updateReview(runId: string, shardId: string, patch: ParallelReviewPatch): void;
	/** Atomically claim exclusive run ownership; rejects a live foreign owner. */
	claimRun(runId: string): void;
	/** Release run ownership; a no-op unless this instance is the owner. */
	releaseRun(runId: string): void;
}

export interface ParallelCoordinatorDependencies {
	store: ParallelCoordinatorStore;
	now?: () => number;
	createRunId?: () => string;
	isReadOnly?: typeof isReadOnlyAgent;
	getRepoRoot?: (cwd: string) => Promise<string>;
	captureBaseline?: (repoRoot: string) => Promise<WorktreeBaseline>;
	ensureIsolation?: (baseCwd: string, id: string) => Promise<IsolationHandle>;
	commitToBranch?: (
		isolationDir: string,
		baseline: WorktreeBaseline,
		taskId: string,
		description: string | undefined,
	) => Promise<CommitToBranchResult | null>;
	cleanupIsolation?: (handle: IsolationHandle) => Promise<void>;
	mergeTaskBranches?: (
		repoRoot: string,
		branches: Array<{ branchName: string; taskId: string; description?: string; baseSha?: string }>,
	) => Promise<MergeBranchResult>;
	cleanupTaskBranches?: (repoRoot: string, branches: string[]) => Promise<void>;
	/** Materialize a temporary detached worktree for one shard branch. */
	createReviewWorktree?: (repoRoot: string, branchName: string, worktreeId: string) => Promise<string>;
	/** Remove a temporary review worktree; must never throw fatally. */
	removeReviewWorktree?: (repoRoot: string, worktreeDir: string) => Promise<void>;
	/** Merge completed dependency branches into a shard's isolated worktree in manifest order. */
	materializeDependencyBranches?: (worktreeDir: string, branchNames: readonly string[]) => Promise<void>;
	/** Net project-relative POSIX paths changed in isolation vs the baseline. */
	captureChangedPaths?: (isolationDir: string, baseline: WorktreeBaseline) => Promise<readonly string[]>;
}

export type ParallelPreflightIssueKind = "missing-agent" | "missing-reviewer" | "reviewer-not-read-only";

export interface ParallelPreflightIssue {
	shardId: string;
	kind: ParallelPreflightIssueKind;
	message: string;
}

export interface ParallelPreflightResult {
	ok: boolean;
	repoRoot: string;
	issues: readonly ParallelPreflightIssue[];
}

export type ParallelRunSnapshot = ParallelStoredRun;

export interface ParallelReviewVerdict {
	approved: boolean;
	summary: string;
	findings: ParallelReviewFinding[];
}

const NONTERMINAL_RUN_STATUSES: readonly ParallelRunStatus[] = [
	"planned",
	"running",
	"review_pending",
	"ready_to_integrate",
	"integrating",
	"interrupted",
];

function coordinatorError(message: string): Error {
	return new Error(`Parallel coordinator: ${message}`);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Parse one reviewer output into a strict verdict. Fails closed: returns null
 * for oversized output, non-JSON output, or any shape deviation from
 * `{approved:boolean,summary:string,findings:[{path,line?,message}]}`.
 */
export function parseParallelReviewVerdict(output: string): ParallelReviewVerdict | null {
	if (output.length > PARALLEL_REVIEW_OUTPUT_MAX_CHARS) return null;
	const trimmed = output.trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start === -1 || end <= start) return null;
		try {
			parsed = JSON.parse(trimmed.slice(start, end + 1));
		} catch {
			return null;
		}
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const record = parsed as Record<string, unknown>;
	if (typeof record.approved !== "boolean") return null;
	if (typeof record.summary !== "string") return null;
	if (!Array.isArray(record.findings)) return null;
	const findings: ParallelReviewFinding[] = [];
	for (const entry of record.findings) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
		const finding = entry as Record<string, unknown>;
		if (typeof finding.path !== "string" || typeof finding.message !== "string") return null;
		if (finding.line !== undefined && (typeof finding.line !== "number" || !Number.isFinite(finding.line))) {
			return null;
		}
		findings.push(
			finding.line === undefined
				? { path: finding.path, message: finding.message }
				: { path: finding.path, line: finding.line, message: finding.message },
		);
	}
	return { approved: record.approved, summary: record.summary, findings };
}

/** Bounded review task asking for exactly one strict JSON verdict object. */
export function buildParallelReviewPrompt(shard: ParallelShardSpec): string {
	return [
		`Review the committed changes for parallel workflow shard "${shard.id}" in your current worktree.`,
		`The shard's assignment was:`,
		shard.prompt,
		"",
		"You are a read-only reviewer. Inspect the changes and respond with exactly one JSON object and nothing else:",
		'{"approved":boolean,"summary":string,"findings":[{"path":string,"line"?:number,"message":string}]}',
		"Set approved=false when the changes are incorrect, unsafe, or incomplete.",
	].join("\n");
}

/**
 * Touched project-relative POSIX paths named by one `git diff` patch.
 * Reads `---`/`+++`/`rename`/`copy` header lines inside each `diff --git`
 * block, falls back to the `diff --git` line itself for header-only entries
 * (binary changes), unquotes quoted paths, and ignores `/dev/null` sides.
 */
export function parallelPatchTouchedPaths(patch: string): string[] {
	const paths = new Set<string>();
	const add = (raw: string, prefix: "a/" | "b/" | null): void => {
		let value = raw.trim();
		if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
			try {
				value = JSON.parse(value) as string;
			} catch {
				value = value.slice(1, -1);
			}
		}
		if (value.length === 0 || value === "/dev/null") return;
		if (prefix !== null) {
			if (!value.startsWith(prefix)) return;
			value = value.slice(prefix.length);
		}
		if (value.startsWith("./")) value = value.slice(2);
		if (value.length > 0) paths.add(value);
	};
	let inHeader = false;
	for (const line of patch.split("\n")) {
		if (line.startsWith("diff --git ")) {
			inHeader = true;
			const body = line.slice("diff --git ".length);
			// The exact same-path form `a/P b/P` survives spaces inside P.
			let matched = false;
			for (let index = body.indexOf(" b/"); index !== -1; index = body.indexOf(" b/", index + 1)) {
				const left = body.slice(0, index);
				if (left.startsWith("a/") && left.slice(2) === body.slice(index + 3)) {
					add(left, "a/");
					matched = true;
					break;
				}
			}
			if (!matched) {
				const halves = body.match(/^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/);
				if (halves !== null) {
					add(halves[1] ?? "", "a/");
					add(halves[2] ?? "", "b/");
				}
			}
			continue;
		}
		if (!inHeader) continue;
		if (line.startsWith("@@") || line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
			inHeader = false;
			continue;
		}
		if (line.startsWith("--- ")) add(line.slice(4), "a/");
		else if (line.startsWith("+++ ")) add(line.slice(4), "b/");
		else if (line.startsWith("rename from ")) add(line.slice("rename from ".length), null);
		else if (line.startsWith("rename to ")) add(line.slice("rename to ".length), null);
		else if (line.startsWith("copy from ")) add(line.slice("copy from ".length), null);
		else if (line.startsWith("copy to ")) add(line.slice("copy to ".length), null);
	}
	return [...paths].sort();
}

/**
 * Owns preflight, dispatch, review gates, cancellation, recovery, and
 * integration for parallel workflow runs. All provider and git effects flow
 * through the injected host/dependency seams; nothing here touches the
 * router's session state, and nothing merges without an explicit
 * `integrate` call.
 */
export class ParallelCoordinator {
	private readonly host: ParallelCoordinatorHost;
	private readonly store: ParallelCoordinatorStore;
	private readonly createRunId: () => string;
	private readonly isReadOnly: typeof isReadOnlyAgent;
	private readonly getRepoRoot: (cwd: string) => Promise<string>;
	private readonly captureBaseline: (repoRoot: string) => Promise<WorktreeBaseline>;
	private readonly ensureIsolation: (baseCwd: string, id: string) => Promise<IsolationHandle>;
	private readonly commitToBranch: (
		isolationDir: string,
		baseline: WorktreeBaseline,
		taskId: string,
		description: string | undefined,
	) => Promise<CommitToBranchResult | null>;
	private readonly cleanupIsolation: (handle: IsolationHandle) => Promise<void>;
	private readonly mergeTaskBranches: (
		repoRoot: string,
		branches: Array<{ branchName: string; taskId: string; description?: string; baseSha?: string }>,
	) => Promise<MergeBranchResult>;
	private readonly cleanupTaskBranches: (repoRoot: string, branches: string[]) => Promise<void>;
	private readonly createReviewWorktree: (repoRoot: string, branchName: string, worktreeId: string) => Promise<string>;
	private readonly removeReviewWorktree: (repoRoot: string, worktreeDir: string) => Promise<void>;
	private readonly materializeDependencyBranches: (
		worktreeDir: string,
		branchNames: readonly string[],
	) => Promise<void>;
	private readonly captureChangedPaths: (
		isolationDir: string,
		baseline: WorktreeBaseline,
	) => Promise<readonly string[]>;
	private readonly controllers = new Map<string, Set<AbortController>>();
	private readonly active = new Map<string, Set<Promise<unknown>>>();
	private readonly leases = new Map<string, number>();
	private readonly integrations = new Map<string, Promise<ParallelRunSnapshot>>();

	constructor(host: ParallelCoordinatorHost, dependencies: ParallelCoordinatorDependencies) {
		this.host = host;
		this.store = dependencies.store;
		this.createRunId = dependencies.createRunId ?? (() => `run-${randomUUID().slice(0, 8)}`);
		this.isReadOnly = dependencies.isReadOnly ?? isReadOnlyAgent;
		this.getRepoRoot = dependencies.getRepoRoot ?? getRepoRoot;
		this.captureBaseline = dependencies.captureBaseline ?? captureBaseline;
		this.ensureIsolation = dependencies.ensureIsolation ?? ensureIsolation;
		this.commitToBranch = dependencies.commitToBranch ?? commitToBranch;
		this.cleanupIsolation = dependencies.cleanupIsolation ?? cleanupIsolation;
		this.mergeTaskBranches = dependencies.mergeTaskBranches ?? mergeTaskBranches;
		this.cleanupTaskBranches = dependencies.cleanupTaskBranches ?? cleanupTaskBranches;
		this.createReviewWorktree =
			dependencies.createReviewWorktree ??
			(async (repoRoot, branchName, worktreeId) => {
				// Unique per attempt: a leftover registration from an interrupted
				// review must never block a retry's `git worktree add`.
				const dir = path.join(os.tmpdir(), `omp-parallel-review-${worktreeId}-${randomUUID().slice(0, 8)}`);
				const result = await this.host.exec("git", [
					"-C",
					repoRoot,
					"worktree",
					"add",
					"--detach",
					dir,
					branchName,
				]);
				if (result.exitCode !== 0) {
					throw coordinatorError(`failed to create review worktree for ${branchName}: ${result.stderr.trim()}`);
				}
				return dir;
			});
		this.removeReviewWorktree =
			dependencies.removeReviewWorktree ??
			(async (repoRoot, worktreeDir) => {
				await this.host.exec("git", ["-C", repoRoot, "worktree", "remove", "--force", worktreeDir]);
			});
		this.materializeDependencyBranches =
			dependencies.materializeDependencyBranches ??
			(async (worktreeDir, branchNames) => {
				if (branchNames.length === 0) return;
				const branchList = branchNames.join(" ");
				// One octopus merge keeps every dependency staged in the isolated
				// view while producing only one MERGE_HEAD state to clear.
				const mergeResult = await this.host.exec("git", [
					"-C",
					worktreeDir,
					"merge",
					"--no-commit",
					"--no-ff",
					...branchNames,
				]);
				if (mergeResult.exitCode !== 0) {
					throw new Error(`git merge --no-commit --no-ff ${branchList} failed: ${mergeResult.stderr.trim()}`);
				}
				const quitResult = await this.host.exec("git", ["-C", worktreeDir, "merge", "--quit"]);
				if (quitResult.exitCode !== 0) {
					throw new Error(
						`git merge --quit after materializing ${branchList} failed: ${quitResult.stderr.trim()}`,
					);
				}
			});
		this.captureChangedPaths =
			dependencies.captureChangedPaths ??
			(async (isolationDir, baseline) => {
				const delta = await captureDeltaPatch(isolationDir, baseline);
				const paths = new Set<string>(parallelPatchTouchedPaths(delta.rootPatch));
				for (const nested of delta.nestedPatches) {
					const base = nested.relativePath.replace(/\\/g, "/").replace(/\/+$/, "");
					for (const touched of parallelPatchTouchedPaths(nested.patch)) {
						paths.add(base.length === 0 ? touched : `${base}/${touched}`);
					}
				}
				return [...paths].sort();
			});
	}

	/**
	 * Validate one plan against the discovered agent roster: every shard agent
	 * must exist, every declared reviewer must exist, and every required
	 * reviewer must pass the read-only gate. Never calls a model or runner.
	 */
	async preflight(plan: ParallelWorkflowPlan): Promise<ParallelPreflightResult> {
		const repoRoot = await this.getRepoRoot(this.host.cwd);
		const discovery = await this.host.discover(this.host.cwd);
		const agentsByName = new Map<string, AgentDefinition>();
		for (const agent of discovery.agents) agentsByName.set(agent.name, agent);

		const issues: ParallelPreflightIssue[] = [];
		for (const shard of plan.shards) {
			if (!agentsByName.has(shard.agent)) {
				issues.push({
					shardId: shard.id,
					kind: "missing-agent",
					message: `shard "${shard.id}" references unknown agent "${shard.agent}"`,
				});
			}
			if (shard.review === undefined) continue;
			const reviewer = agentsByName.get(shard.review.agent);
			if (reviewer === undefined) {
				issues.push({
					shardId: shard.id,
					kind: "missing-reviewer",
					message: `shard "${shard.id}" references unknown review agent "${shard.review.agent}"`,
				});
				continue;
			}
			if (shard.review.required && !this.isReadOnly(reviewer)) {
				issues.push({
					shardId: shard.id,
					kind: "reviewer-not-read-only",
					message: `shard "${shard.id}" requires reviewer "${shard.review.agent}" which is not read-only`,
				});
			}
		}
		return { ok: issues.length === 0, repoRoot, issues };
	}

	/** Persist one immutable plan after a passing preflight. Never dispatches. */
	async createRun(plan: ParallelWorkflowPlan): Promise<ParallelRunSnapshot> {
		const preflight = await this.preflight(plan);
		if (!preflight.ok) {
			const detail = preflight.issues.map(issue => issue.message).join("; ");
			throw coordinatorError(`preflight failed: ${detail}`);
		}
		return this.store.createRun({ runId: this.createRunId(), plan, cwd: this.host.cwd });
	}

	/**
	 * Drive one stored run forward: requeue interrupted rows, then process
	 * dependency-ready shards in bounded waves until nothing is dispatchable.
	 * Never merges and never bypasses a required review rejection.
	 */
	async resume(runId: string): Promise<ParallelRunSnapshot> {
		const promise = this.withRunLease(runId, () => this.resumeInner(runId));
		this.trackActive(runId, promise);
		return promise;
	}

	/** Retry every non-approved review whose shard already produced a result. */
	async review(runId: string): Promise<ParallelRunSnapshot> {
		const promise = this.withRunLease(runId, () => this.reviewInner(runId));
		this.trackActive(runId, promise);
		return promise;
	}

	/**
	 * Abort active work and mark every nonterminal row cancelled. Runs under
	 * the shared refcounted lease: an idle cancel claims and releases the
	 * run (rejecting a live foreign owner), while a cancel overlapping a
	 * local resume/review/integrate only piggybacks on the claim they hold.
	 */
	async cancel(runId: string): Promise<ParallelRunSnapshot> {
		return this.withRunLease(runId, async () => this.cancelInner(runId));
	}

	private cancelInner(runId: string): ParallelRunSnapshot {
		const stored = this.requireRun(runId);
		for (const controller of this.controllers.get(runId) ?? []) controller.abort();

		const shardNonterminal: readonly string[] = ["pending", "running", "review_pending", "interrupted"];
		for (const shard of stored.shards) {
			if (shardNonterminal.includes(shard.status)) {
				this.store.updateShard(runId, shard.shardId, { status: "cancelled" });
			}
		}
		const reviewNonterminal: readonly string[] = ["pending", "running", "interrupted"];
		for (const review of stored.reviews) {
			if (reviewNonterminal.includes(review.status)) {
				this.store.updateReview(runId, review.shardId, { status: "cancelled" });
			}
		}
		if (NONTERMINAL_RUN_STATUSES.includes(stored.run.status)) {
			this.store.updateRun(runId, { status: "cancelled" });
		}
		return this.requireRun(runId);
	}

	/**
	 * Explicitly merge one fully approved run. Merges task branches in
	 * manifest order and cleans up only branches that actually merged;
	 * a conflict leaves the run failed with every branch artifact retained.
	 */
	integrate(runId: string): Promise<ParallelRunSnapshot> {
		// One in-flight integration per run: repeated local calls share the
		// same promise instead of double-merging; the slot clears on settle.
		const existing = this.integrations.get(runId);
		if (existing !== undefined) return existing;
		const promise = this.withRunLease(runId, () => this.integrateInner(runId));
		this.integrations.set(runId, promise);
		// `.then(done, done)` clears the slot in the first settle tier, so a
		// caller resuming from `await` can never pick up the stale promise.
		const done = (): void => {
			if (this.integrations.get(runId) === promise) this.integrations.delete(runId);
		};
		void promise.then(done, done);
		this.trackActive(runId, promise);
		return promise;
	}

	/** One run snapshot, or bounded summaries of every stored run. */
	async status(runId?: string): Promise<ParallelRunSnapshot | readonly ParallelRunSummary[]> {
		if (runId === undefined) return this.store.listRuns();
		return this.requireRun(runId);
	}

	/** Resolve once every in-flight operation for the run settles; never busy-spins. */
	async wait(runId: string): Promise<ParallelRunSnapshot> {
		for (;;) {
			const pending = this.active.get(runId);
			if (pending === undefined || pending.size === 0) break;
			await Promise.allSettled([...pending]);
		}
		return this.requireRun(runId);
	}

	private trackActive(runId: string, promise: Promise<unknown>): void {
		let set = this.active.get(runId);
		if (set === undefined) {
			set = new Set();
			this.active.set(runId, set);
		}
		set.add(promise);
		void promise
			.catch(() => undefined)
			.finally(() => {
				set.delete(promise);
				if (set.size === 0 && this.active.get(runId) === set) this.active.delete(runId);
			});
	}

	/**
	 * Run one operation while holding the persisted run lease. Overlapping
	 * local operations share a single claim via reference counting, so a
	 * concurrent cancel can never release a lease a sibling still holds; the
	 * store claim itself rejects runs owned by another live process.
	 */
	private async withRunLease<T>(runId: string, operation: () => Promise<T>): Promise<T> {
		this.requireRun(runId);
		const held = this.leases.get(runId) ?? 0;
		if (held === 0) this.store.claimRun(runId);
		this.leases.set(runId, held + 1);
		try {
			return await operation();
		} finally {
			const remaining = (this.leases.get(runId) ?? 1) - 1;
			if (remaining <= 0) {
				this.leases.delete(runId);
				this.store.releaseRun(runId);
			} else {
				this.leases.set(runId, remaining);
			}
		}
	}

	private requireRun(runId: string): ParallelStoredRun {
		const stored = this.store.getRun(runId);
		if (stored === null) throw coordinatorError(`unknown run "${runId}"`);
		return stored;
	}

	private registerController(runId: string): AbortController {
		const controller = new AbortController();
		let set = this.controllers.get(runId);
		if (set === undefined) {
			set = new Set();
			this.controllers.set(runId, set);
		}
		set.add(controller);
		return controller;
	}

	private releaseController(runId: string, controller: AbortController): void {
		const set = this.controllers.get(runId);
		if (set === undefined) return;
		set.delete(controller);
		if (set.size === 0) this.controllers.delete(runId);
	}

	private async resumeInner(runId: string): Promise<ParallelRunSnapshot> {
		let stored = this.requireRun(runId);
		if (stored.run.status === "integrated" || stored.run.status === "cancelled") return stored;
		// A failed run has nothing the scheduler can requeue: failed shards are
		// never redispatched, and an integration failure must keep its
		// `lastError` so the operator retries via an explicit `integrate`.
		if (stored.run.status === "failed") return stored;

		// Requeue rows abandoned by a dead process; branch artifacts survive.
		for (const shard of stored.shards) {
			if (shard.status === "interrupted") this.store.updateShard(runId, shard.shardId, { status: "pending" });
		}
		for (const review of stored.reviews) {
			if (review.status === "interrupted") this.store.updateReview(runId, review.shardId, { status: "pending" });
		}
		this.store.updateRun(runId, { status: "running", lastError: null });

		const controller = this.registerController(runId);
		try {
			const repoRoot = await this.getRepoRoot(this.host.cwd);
			const discovery = await this.host.discover(this.host.cwd);
			const agentsByName = new Map<string, AgentDefinition>();
			for (const agent of discovery.agents) agentsByName.set(agent.name, agent);

			const plan = stored.run.plan;
			const indexByShardId = new Map<string, number>();
			plan.shards.forEach((shard, index) => {
				indexByShardId.set(shard.id, index);
			});

			while (!controller.signal.aborted) {
				stored = this.requireRun(runId);
				const shardStates: ParallelShardState[] = stored.shards.map(shard => ({
					id: shard.shardId,
					status: shard.status,
					branchName: shard.branchName,
					baseSha: shard.baseSha,
					error: shard.error,
				}));
				const reviewStates: ParallelReviewState[] = stored.reviews.map(review => ({
					shardId: review.shardId,
					status: review.status,
					summary: review.summary,
					findings: review.findings,
					error: review.error,
				}));
				const decision = decideParallelSchedule(plan, shardStates, reviewStates);
				if (decision.ready.length === 0) break;
				await Promise.allSettled(
					decision.ready.map(shard =>
						this.processShard(
							runId,
							plan,
							shard,
							indexByShardId.get(shard.id) ?? 0,
							repoRoot,
							agentsByName,
							controller.signal,
						),
					),
				);
			}

			if (!controller.signal.aborted) {
				stored = this.requireRun(runId);
				const outcome = computeRunOutcome(plan, stored);
				const firstFailure = stored.shards.find(shard => shard.status === "failed");
				this.store.updateRun(runId, {
					status: outcome,
					lastError: outcome === "failed" ? (firstFailure?.error ?? "one or more shards failed") : null,
				});
			}
		} finally {
			this.releaseController(runId, controller);
		}
		return this.requireRun(runId);
	}

	private async processShard(
		runId: string,
		plan: ParallelWorkflowPlan,
		shard: ParallelShardSpec,
		index: number,
		repoRoot: string,
		agentsByName: ReadonlyMap<string, AgentDefinition>,
		signal: AbortSignal,
	): Promise<void> {
		const agent = agentsByName.get(shard.agent);
		if (agent === undefined) {
			this.store.updateShard(runId, shard.id, { status: "failed", error: `unknown agent "${shard.agent}"` });
			return;
		}
		const uniqueTaskId = `${runId}-${shard.id}`;
		this.store.updateShard(runId, shard.id, { status: "running" });
		try {
			const handle = await this.ensureIsolation(repoRoot, uniqueTaskId);
			let commit: CommitToBranchResult | null = null;
			let output = "";
			try {
				await this.materializeDependencies(runId, plan, shard, handle.mergedDir);
				// The baseline is captured inside the isolated view only after
				// dependency materialization, so the committed delta is this
				// shard's net work alone; the repo root is normalized back to
				// the real repository so the task branch is created there.
				const isolatedBaseline = await this.captureBaseline(handle.mergedDir);
				const baseline: WorktreeBaseline = {
					...isolatedBaseline,
					root: { ...isolatedBaseline.root, repoRoot },
				};
				const result = await this.host.runSubagent({
					cwd: repoRoot,
					worktree: handle.mergedDir,
					agent,
					task: shard.prompt,
					id: uniqueTaskId,
					index,
					modelOverride: plan.model ?? this.host.currentModelSelector,
					signal,
				});
				if (result.aborted === true || signal.aborted) {
					this.store.updateShard(runId, shard.id, { status: "cancelled", error: result.abortReason ?? null });
					return;
				}
				if (result.exitCode !== 0 || result.error !== undefined) {
					this.store.updateShard(runId, shard.id, {
						status: "failed",
						error: result.error ?? `subagent exited with code ${result.exitCode}`,
						outputExcerpt: result.output,
					});
					return;
				}
				output = result.output;
				const violations = await this.ownershipViolations(handle.mergedDir, baseline, shard);
				if (violations.length > 0) {
					this.store.updateShard(runId, shard.id, {
						status: "failed",
						error: `shard "${shard.id}" changed paths outside its owns list: ${violations.join(", ")}`,
						outputExcerpt: output,
					});
					return;
				}
				commit = await this.commitToBranch(handle.mergedDir, baseline, uniqueTaskId, shard.prompt);
			} finally {
				await this.cleanupIsolation(handle);
			}

			// Branch and base SHA are durable before any review dispatch.
			const requiresReview = shard.review?.required === true;
			const noChanges = commit === null;
			this.store.updateShard(runId, shard.id, {
				status: requiresReview && !noChanges ? "review_pending" : "completed",
				branchName: commit?.branchName ?? null,
				baseSha: commit?.baseSha ?? null,
				outputExcerpt: output,
			});

			if (shard.review !== undefined && !signal.aborted) {
				if (noChanges) {
					// Nothing to review: approve the declared review so the run
					// can still reach ready_to_integrate.
					this.store.updateReview(runId, shard.id, {
						status: "approved",
						summary: "No changes produced; review skipped.",
						findings: [],
						error: null,
					});
				} else {
					await this.runReview(runId, plan, shard, index, repoRoot, agentsByName, signal);
				}
			}
		} catch (error) {
			this.store.updateShard(runId, shard.id, {
				status: signal.aborted ? "cancelled" : "failed",
				error: errorMessage(error),
			});
		}
	}

	/**
	 * Merge every transitive completed dependency branch into one shard's
	 * isolated worktree so downstream work sees upstream results. Branches
	 * are passed to one merge in manifest order; a dependency that produced
	 * no branch is a no-op; a merge failure fails this shard with all affected
	 * branches named.
	 */
	private async materializeDependencies(
		runId: string,
		plan: ParallelWorkflowPlan,
		shard: ParallelShardSpec,
		worktreeDir: string,
	): Promise<void> {
		if (shard.dependsOn.length === 0) return;
		const specById = new Map(plan.shards.map(spec => [spec.id, spec]));
		const needed = new Set<string>();
		const visit = (id: string): void => {
			if (needed.has(id)) return;
			needed.add(id);
			for (const dependency of specById.get(id)?.dependsOn ?? []) visit(dependency);
		};
		for (const dependency of shard.dependsOn) visit(dependency);

		const stored = this.requireRun(runId);
		const branchByShardId = new Map(stored.shards.map(record => [record.shardId, record.branchName]));
		const dependencies: Array<{ spec: ParallelShardSpec; branchName: string }> = [];
		for (const spec of plan.shards) {
			if (!needed.has(spec.id)) continue;
			const branchName = branchByShardId.get(spec.id) ?? null;
			if (branchName !== null) dependencies.push({ spec, branchName });
		}
		if (dependencies.length === 0) return;

		try {
			await this.materializeDependencyBranches(
				worktreeDir,
				dependencies.map(dependency => dependency.branchName),
			);
		} catch (error) {
			const labels = dependencies.map(dependency => `"${dependency.spec.id}" (${dependency.branchName})`).join(", ");
			const noun = dependencies.length === 1 ? "dependency" : "dependencies";
			throw coordinatorError(
				`failed to materialize ${noun} ${labels} for shard "${shard.id}": ${errorMessage(error)}`,
			);
		}
	}

	/** Net changed paths that fall outside the shard's declared `owns` scope. */
	private async ownershipViolations(
		isolationDir: string,
		baseline: WorktreeBaseline,
		shard: ParallelShardSpec,
	): Promise<string[]> {
		const changed = await this.captureChangedPaths(isolationDir, baseline);
		const violations = new Set<string>();
		for (const rawPath of changed) {
			let candidate = rawPath.trim().replace(/\\/g, "/");
			while (candidate.startsWith("./")) candidate = candidate.slice(2);
			if (candidate.length === 0) continue;
			const owned = shard.owns.some(owns => candidate === owns || candidate.startsWith(`${owns}/`));
			if (!owned) violations.add(candidate);
		}
		return [...violations].sort();
	}

	private async runReview(
		runId: string,
		plan: ParallelWorkflowPlan,
		shard: ParallelShardSpec,
		index: number,
		repoRoot: string,
		agentsByName: ReadonlyMap<string, AgentDefinition>,
		signal: AbortSignal,
	): Promise<void> {
		const spec = shard.review;
		if (spec === undefined) return;
		const failClosed = (error: string): void => {
			this.store.updateReview(runId, shard.id, { status: "failed", error });
		};

		const reviewer = agentsByName.get(spec.agent);
		if (reviewer === undefined) {
			failClosed(`unknown review agent "${spec.agent}"`);
			return;
		}
		if (spec.required && !this.isReadOnly(reviewer)) {
			failClosed(`required reviewer "${spec.agent}" is not read-only`);
			return;
		}
		const stored = this.requireRun(runId);
		const shardRecord = stored.shards.find(record => record.shardId === shard.id);
		const branchName = shardRecord?.branchName ?? null;
		if (branchName === null) {
			failClosed(`shard "${shard.id}" produced no branch to review`);
			return;
		}

		this.store.updateReview(runId, shard.id, { status: "running", error: null });
		const worktreeId = `${runId}-${shard.id}-review`;
		let worktreeDir: string | null = null;
		try {
			worktreeDir = await this.createReviewWorktree(repoRoot, branchName, worktreeId);
			const result = await this.host.runSubagent({
				cwd: repoRoot,
				worktree: worktreeDir,
				agent: reviewer,
				task: buildParallelReviewPrompt(shard),
				id: worktreeId,
				index,
				modelOverride: plan.model ?? this.host.currentModelSelector,
				signal,
			});
			if (result.aborted === true || signal.aborted) {
				this.store.updateReview(runId, shard.id, { status: "cancelled", error: result.abortReason ?? null });
				return;
			}
			if (result.exitCode !== 0 || result.error !== undefined) {
				failClosed(result.error ?? `review subagent exited with code ${result.exitCode}`);
				return;
			}
			const verdict = parseParallelReviewVerdict(result.output);
			if (verdict === null) {
				failClosed("reviewer returned malformed verdict JSON");
				return;
			}
			this.store.updateReview(runId, shard.id, {
				status: verdict.approved ? "approved" : "rejected",
				summary: verdict.summary,
				findings: verdict.findings,
				error: null,
			});
			if (verdict.approved && spec.required) {
				this.store.updateShard(runId, shard.id, { status: "approved" });
			}
		} catch (error) {
			this.store.updateReview(runId, shard.id, {
				status: signal.aborted ? "cancelled" : "failed",
				error: errorMessage(error),
			});
		} finally {
			if (worktreeDir !== null) {
				try {
					await this.removeReviewWorktree(repoRoot, worktreeDir);
				} catch {
					// Removal is best-effort; the verdict outcome already persisted.
				}
			}
		}
	}

	private async reviewInner(runId: string): Promise<ParallelRunSnapshot> {
		const stored = this.requireRun(runId);
		if (stored.run.status === "integrated" || stored.run.status === "cancelled") return stored;
		const plan = stored.run.plan;
		const repoRoot = await this.getRepoRoot(this.host.cwd);
		const discovery = await this.host.discover(this.host.cwd);
		const agentsByName = new Map<string, AgentDefinition>();
		for (const agent of discovery.agents) agentsByName.set(agent.name, agent);

		const retryable: readonly string[] = ["pending", "rejected", "failed", "interrupted"];
		const reviewsByShardId = new Map(stored.reviews.map(review => [review.shardId, review]));
		const shardsById = new Map(stored.shards.map(shard => [shard.shardId, shard]));
		const indexByShardId = new Map<string, number>();
		plan.shards.forEach((shard, index) => {
			indexByShardId.set(shard.id, index);
		});

		const controller = this.registerController(runId);
		try {
			let anyReviewRan = false;
			for (const shard of plan.shards) {
				if (controller.signal.aborted) break;
				if (shard.review === undefined) continue;
				const review = reviewsByShardId.get(shard.id);
				if (review === undefined || !retryable.includes(review.status)) continue;
				const record = shardsById.get(shard.id);
				const shardStatus = record?.status;
				if (shardStatus !== "review_pending" && shardStatus !== "completed") continue;
				anyReviewRan = true;
				await this.runReview(
					runId,
					plan,
					shard,
					indexByShardId.get(shard.id) ?? 0,
					repoRoot,
					agentsByName,
					controller.signal,
				);
			}
			// A no-op retry pass must not disturb the run status (e.g. planned).
			if (anyReviewRan && !controller.signal.aborted) {
				const latest = this.requireRun(runId);
				this.store.updateRun(runId, { status: computeRunOutcome(plan, latest) });
			}
		} finally {
			this.releaseController(runId, controller);
		}
		return this.requireRun(runId);
	}

	private async integrateInner(runId: string): Promise<ParallelRunSnapshot> {
		const stored = this.requireRun(runId);
		if (stored.run.status === "integrated") throw coordinatorError(`run "${runId}" is already integrated`);
		if (stored.run.status === "cancelled") {
			throw coordinatorError(`cannot integrate run "${runId}": run is cancelled`);
		}
		const plan = stored.run.plan;

		const shardsById = new Map(stored.shards.map(shard => [shard.shardId, shard]));
		const reviewsByShardId = new Map(stored.reviews.map(review => [review.shardId, review]));
		for (const shard of plan.shards) {
			const record = shardsById.get(shard.id);
			const status = record?.status;
			if (status !== "completed" && status !== "approved") {
				throw coordinatorError(`cannot integrate run "${runId}": shard "${shard.id}" is ${status ?? "missing"}`);
			}
			if (shard.review?.required === true && reviewsByShardId.get(shard.id)?.status !== "approved") {
				throw coordinatorError(
					`cannot integrate run "${runId}": required review for shard "${shard.id}" is not approved`,
				);
			}
		}

		const repoRoot = await this.getRepoRoot(this.host.cwd);
		// Manifest order is the integration order.
		const branches: Array<{ branchName: string; taskId: string; description?: string; baseSha?: string }> = [];
		for (const shard of plan.shards) {
			const record = shardsById.get(shard.id);
			if (record?.branchName == null) continue;
			branches.push({
				branchName: record.branchName,
				taskId: `${runId}-${shard.id}`,
				description: shard.prompt,
				baseSha: record.baseSha ?? undefined,
			});
		}

		this.store.updateRun(runId, { status: "integrating", lastError: null });
		try {
			const result = await this.mergeTaskBranches(repoRoot, branches);
			const conflicted =
				result.failed.length > 0 || result.conflict !== undefined || result.stashConflict !== undefined;
			// Only branches that actually merged are ever cleaned up.
			if (result.merged.length > 0) {
				await this.cleanupTaskBranches(repoRoot, result.merged);
				// Merged branches are gone; clear them so a later integrate
				// retry resubmits only the branches that did not merge.
				const mergedSet = new Set(result.merged);
				for (const shard of stored.shards) {
					if (shard.branchName !== null && mergedSet.has(shard.branchName)) {
						this.store.updateShard(runId, shard.shardId, { branchName: null });
					}
				}
			}
			if (conflicted) {
				this.store.updateRun(runId, {
					status: "failed",
					lastError:
						result.conflict ?? result.stashConflict ?? `merge failed for branches: ${result.failed.join(", ")}`,
				});
			} else {
				this.store.updateRun(runId, { status: "integrated", lastError: null });
			}
		} catch (error) {
			this.store.updateRun(runId, { status: "failed", lastError: errorMessage(error) });
		}
		return this.requireRun(runId);
	}
}

/**
 * Derive the run status from persisted rows: any failed shard fails the run,
 * a fully completed/approved roster with approved required reviews is ready
 * to integrate, and everything else awaits operator review action.
 */
function computeRunOutcome(plan: ParallelWorkflowPlan, stored: ParallelStoredRun): ParallelRunStatus {
	const shardsById = new Map(stored.shards.map(shard => [shard.shardId, shard]));
	const reviewsByShardId = new Map(stored.reviews.map(review => [review.shardId, review]));

	if (stored.shards.some(shard => shard.status === "failed")) return "failed";
	if (stored.shards.some(shard => shard.status === "cancelled")) return "cancelled";

	const allShardsDone = plan.shards.every(shard => {
		const status = shardsById.get(shard.id)?.status;
		return status === "completed" || status === "approved";
	});
	const allRequiredApproved = plan.shards.every(shard => {
		if (shard.review?.required !== true) return true;
		return reviewsByShardId.get(shard.id)?.status === "approved";
	});
	if (allShardsDone && allRequiredApproved) return "ready_to_integrate";
	return "review_pending";
}
