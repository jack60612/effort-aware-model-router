import type {
	ParallelReviewStatus,
	ParallelShardSpec,
	ParallelShardStatus,
	ParallelWorkflowPlan,
} from "./contracts";

export interface ParallelShardState {
	id: string;
	status: ParallelShardStatus;
	branchName: string | null;
	baseSha: string | null;
	error: string | null;
}

export interface ParallelReviewFinding {
	path: string;
	line?: number;
	message: string;
}

export interface ParallelReviewState {
	shardId: string;
	status: ParallelReviewStatus;
	summary: string | null;
	findings: readonly ParallelReviewFinding[];
	error: string | null;
}

export interface ParallelSchedulerDecision {
	ready: readonly ParallelShardSpec[];
	blocked: readonly ParallelShardSpec[];
	terminal: boolean;
}

/**
 * Decide the next scheduling step for a run. Pure: reads only the plan and the
 * provided states, performs no I/O, and is deterministic in manifest shard
 * order.
 *
 * - `ready` lists pending shards whose dependencies are all satisfied, capped
 *   by `maxConcurrency` minus currently running shards.
 * - `blocked` lists every other pending shard (unsatisfied dependencies or
 *   deferred by the concurrency cap), so pending = ready + blocked.
 * - `terminal` is true when the scheduler can produce no further work without
 *   operator action: nothing ready, nothing running, and no dispatchable
 *   review outstanding.
 *
 * A dependency is satisfied only when the dependency shard is
 * approved/completed and, when it declares a required review, that review is
 * approved; a pending or rejected required review blocks dependents. Missing
 * shard states default to "pending" and missing review states to "pending".
 */
export function decideParallelSchedule(
	plan: ParallelWorkflowPlan,
	shardStates: readonly ParallelShardState[],
	reviewStates: readonly ParallelReviewState[],
): ParallelSchedulerDecision {
	const shardStatusById = new Map<string, ParallelShardStatus>();
	for (const state of shardStates) shardStatusById.set(state.id, state.status);
	const reviewStatusByShardId = new Map<string, ParallelReviewStatus>();
	for (const state of reviewStates) reviewStatusByShardId.set(state.shardId, state.status);

	const specById = new Map<string, ParallelShardSpec>();
	for (const shard of plan.shards) specById.set(shard.id, shard);

	const statusOf = (shardId: string): ParallelShardStatus => shardStatusById.get(shardId) ?? "pending";

	const isSatisfied = (dependencyId: string): boolean => {
		const status = statusOf(dependencyId);
		if (status !== "approved" && status !== "completed") return false;
		const spec = specById.get(dependencyId);
		if (spec?.review?.required !== true) return true;
		return (reviewStatusByShardId.get(dependencyId) ?? "pending") === "approved";
	};

	let running = 0;
	for (const shard of plan.shards) {
		if (statusOf(shard.id) === "running") running += 1;
	}
	const capacity = Math.max(0, plan.maxConcurrency - running);

	const ready: ParallelShardSpec[] = [];
	const blocked: ParallelShardSpec[] = [];
	for (const shard of plan.shards) {
		if (statusOf(shard.id) !== "pending") continue;
		if (ready.length < capacity && shard.dependsOn.every(isSatisfied)) {
			ready.push(shard);
		} else {
			blocked.push(shard);
		}
	}

	let reviewRunning = false;
	let reviewDispatchable = false;
	for (const shard of plan.shards) {
		if (shard.review === undefined) continue;
		const reviewStatus = reviewStatusByShardId.get(shard.id) ?? "pending";
		if (reviewStatus === "running") reviewRunning = true;
		const shardStatus = statusOf(shard.id);
		if (reviewStatus === "pending" && (shardStatus === "completed" || shardStatus === "review_pending")) {
			reviewDispatchable = true;
		}
	}

	const terminal = ready.length === 0 && running === 0 && !reviewRunning && !reviewDispatchable;
	return { ready, blocked, terminal };
}
