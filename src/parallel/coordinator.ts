import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentDefinition, isReadOnlyAgent, type SingleResult } from "@oh-my-pi/pi-coding-agent/task";
import {
	captureBaseline,
	cleanupIsolation,
	cleanupTaskBranches,
	commitToBranch,
	type CommitToBranchResult,
	ensureIsolation,
	getRepoRoot,
	type IsolationHandle,
	type MergeBranchResult,
	mergeTaskBranches,
	type WorktreeBaseline,
} from "@oh-my-pi/pi-coding-agent/task/worktree";
import type { ParallelShardSpec, ParallelRunStatus, ParallelWorkflowPlan } from "./contracts";
import { decideParallelSchedule, type ParallelReviewFinding, type ParallelReviewState, type ParallelShardState } from "./scheduler";
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
	private readonly controllers = new Map<string, Set<AbortController>>();
	private readonly active = new Map<string, Set<Promise<unknown>>>();

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
				const dir = path.join(os.tmpdir(), `omp-parallel-review-${worktreeId}`);
				const result = await this.host.exec("git", ["-C", repoRoot, "worktree", "add", "--detach", dir, branchName]);
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
		const promise = this.resumeInner(runId);
		this.trackActive(runId, promise);
		return promise;
	}

	/** Retry every non-approved review whose shard already produced a result. */
	async review(runId: string): Promise<ParallelRunSnapshot> {
		const promise = this.reviewInner(runId);
		this.trackActive(runId, promise);
		return promise;
	}

	/** Abort active work and mark every nonterminal row cancelled. */
	async cancel(runId: string): Promise<ParallelRunSnapshot> {
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
	async integrate(runId: string): Promise<ParallelRunSnapshot> {
		const promise = this.integrateInner(runId);
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
		void promise.catch(() => undefined).finally(() => {
			set.delete(promise);
			if (set.size === 0 && this.active.get(runId) === set) this.active.delete(runId);
		});
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
			plan.shards.forEach((shard, index) => indexByShardId.set(shard.id, index));

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
						this.processShard(runId, plan, shard, indexByShardId.get(shard.id) ?? 0, repoRoot, agentsByName, controller.signal),
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
			const baseline = await this.captureBaseline(repoRoot);
			const handle = await this.ensureIsolation(repoRoot, uniqueTaskId);
			let commit: CommitToBranchResult | null = null;
			let output = "";
			try {
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
				commit = await this.commitToBranch(handle.mergedDir, baseline, uniqueTaskId, shard.prompt);
			} finally {
				await this.cleanupIsolation(handle);
			}

			// Branch and base SHA are durable before any review dispatch.
			const requiresReview = shard.review?.required === true;
			this.store.updateShard(runId, shard.id, {
				status: requiresReview ? "review_pending" : "completed",
				branchName: commit?.branchName ?? null,
				baseSha: commit?.baseSha ?? null,
				outputExcerpt: output,
			});

			if (shard.review !== undefined && !signal.aborted) {
				await this.runReview(runId, plan, shard, index, repoRoot, agentsByName, signal);
			}
		} catch (error) {
			this.store.updateShard(runId, shard.id, {
				status: signal.aborted ? "cancelled" : "failed",
				error: errorMessage(error),
			});
		}
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
		plan.shards.forEach((shard, index) => indexByShardId.set(shard.id, index));

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
				throw coordinatorError(`cannot integrate run "${runId}": required review for shard "${shard.id}" is not approved`);
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
			const conflicted = result.failed.length > 0 || result.conflict !== undefined || result.stashConflict !== undefined;
			// Only branches that actually merged are ever cleaned up.
			if (result.merged.length > 0) await this.cleanupTaskBranches(repoRoot, result.merged);
			if (conflicted) {
				this.store.updateRun(runId, {
					status: "failed",
					lastError:
						result.conflict ??
						result.stashConflict ??
						`merge failed for branches: ${result.failed.join(", ")}`,
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
