import { describe, expect, it } from "bun:test";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task";
import type {
	CommitToBranchResult,
	IsolationHandle,
	MergeBranchResult,
	WorktreeBaseline,
} from "@oh-my-pi/pi-coding-agent/task/worktree";
import {
	ParallelCoordinator,
	type ParallelCoordinatorDependencies,
	type ParallelCoordinatorHost,
	type ParallelCoordinatorStore,
	type ParallelSubagentRequest,
	type ParallelSubagentResult,
	parallelPatchTouchedPaths,
	parseParallelReviewVerdict,
} from "../src/parallel/coordinator";
import { type ParallelWorkflowPlan, validateParallelWorkflowManifest } from "../src/parallel/index";
import type {
	ParallelCreateRunInput,
	ParallelReviewPatch,
	ParallelReviewRecord,
	ParallelRunPatch,
	ParallelRunSummary,
	ParallelShardPatch,
	ParallelShardRecord,
	ParallelStoredRun,
} from "../src/parallel/storage";

const SOURCE = "manifest.yml";
const REPO_ROOT = "/repo";

interface ShardInput {
	id: string;
	agent?: string;
	dependsOn?: string[];
	owns?: string[];
	review?: { agent: string; required: boolean };
}

function makePlan(
	shards: ShardInput[],
	options: { maxConcurrency?: number; model?: string } = {},
): ParallelWorkflowPlan {
	return validateParallelWorkflowManifest(
		{
			run: "test-run",
			...(options.model === undefined ? {} : { model: options.model }),
			maxConcurrency: options.maxConcurrency ?? 4,
			contracts: [],
			shards: shards.map(shard => ({
				id: shard.id,
				kind: "implementation",
				agent: shard.agent ?? "task",
				prompt: `Implement shard ${shard.id}.`,
				owns: shard.owns ?? [`src/${shard.id}.ts`],
				produces: [],
				requires: [],
				dependsOn: shard.dependsOn ?? [],
				...(shard.review === undefined ? {} : { review: shard.review }),
			})),
		},
		SOURCE,
	);
}

/** Deterministic in-memory store implementing the coordinator's store seam. */
class FakeStore implements ParallelCoordinatorStore {
	private readonly runs = new Map<
		string,
		{ record: ParallelStoredRun["run"]; shards: ParallelShardRecord[]; reviews: ParallelReviewRecord[] }
	>();
	readonly leaseLog: string[] = [];
	claimError: Error | null = null;
	private readonly claimed = new Set<string>();

	createRun(input: ParallelCreateRunInput): ParallelStoredRun {
		if (this.runs.has(input.runId)) throw new Error(`run "${input.runId}" already exists`);
		const timestamp = 1;
		const record = {
			runId: input.runId,
			cwd: input.cwd ?? REPO_ROOT,
			repoRoot: REPO_ROOT,
			planHash: input.plan.planHash,
			plan: input.plan,
			baseSha: input.baseSha ?? null,
			status: "planned" as const,
			lastError: null,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		const shards: ParallelShardRecord[] = input.plan.shards.map(shard => ({
			runId: input.runId,
			shardId: shard.id,
			status: "pending",
			branchName: null,
			baseSha: null,
			outputExcerpt: null,
			error: null,
			createdAt: timestamp,
			updatedAt: timestamp,
		}));
		const reviews: ParallelReviewRecord[] = input.plan.shards
			.filter(shard => shard.review !== undefined)
			.map(shard => ({
				runId: input.runId,
				shardId: shard.id,
				agent: shard.review?.agent ?? "",
				status: "pending",
				summary: null,
				findings: [],
				error: null,
				createdAt: timestamp,
				updatedAt: timestamp,
			}));
		this.runs.set(input.runId, { record: { ...record }, shards, reviews });
		const stored = this.getRun(input.runId);
		if (stored === null) throw new Error("unreachable");
		return stored;
	}

	getRun(runId: string): ParallelStoredRun | null {
		const entry = this.runs.get(runId);
		if (entry === undefined) return null;
		return {
			run: { ...entry.record },
			shards: entry.shards.map(shard => ({ ...shard })),
			reviews: entry.reviews.map(review => ({ ...review, findings: [...review.findings] })),
		};
	}

	listRuns(): readonly ParallelRunSummary[] {
		return [...this.runs.values()].map(entry => ({
			runId: entry.record.runId,
			runName: entry.record.plan.run,
			status: entry.record.status,
			planHash: entry.record.planHash,
			lastError: entry.record.lastError,
			createdAt: entry.record.createdAt,
			updatedAt: entry.record.updatedAt,
		}));
	}

	updateRun(runId: string, patch: ParallelRunPatch): void {
		const entry = this.runs.get(runId);
		if (entry === undefined) throw new Error(`run "${runId}" not found`);
		if (patch.status !== undefined) entry.record = { ...entry.record, status: patch.status };
		if (patch.baseSha !== undefined) entry.record = { ...entry.record, baseSha: patch.baseSha };
		if (patch.lastError !== undefined) entry.record = { ...entry.record, lastError: patch.lastError };
	}

	updateShard(runId: string, shardId: string, patch: ParallelShardPatch): void {
		const entry = this.runs.get(runId);
		const shard = entry?.shards.find(record => record.shardId === shardId);
		if (entry === undefined || shard === undefined) throw new Error(`shard "${shardId}" not found`);
		if (patch.status !== undefined) shard.status = patch.status;
		if (patch.branchName !== undefined) shard.branchName = patch.branchName;
		if (patch.baseSha !== undefined) shard.baseSha = patch.baseSha;
		if (patch.outputExcerpt !== undefined) shard.outputExcerpt = patch.outputExcerpt;
		if (patch.error !== undefined) shard.error = patch.error;
	}

	updateReview(runId: string, shardId: string, patch: ParallelReviewPatch): void {
		const entry = this.runs.get(runId);
		const review = entry?.reviews.find(record => record.shardId === shardId);
		if (entry === undefined || review === undefined) throw new Error(`review "${shardId}" not found`);
		if (patch.status !== undefined) review.status = patch.status;
		if (patch.agent !== undefined) review.agent = patch.agent;
		if (patch.summary !== undefined) review.summary = patch.summary;
		if (patch.findings !== undefined) review.findings = [...patch.findings];
		if (patch.error !== undefined) review.error = patch.error;
	}

	claimRun(runId: string): void {
		if (!this.runs.has(runId)) throw new Error(`run "${runId}" not found`);
		if (this.claimError !== null) throw this.claimError;
		this.claimed.add(runId);
		this.leaseLog.push(`claim:${runId}`);
	}

	releaseRun(runId: string): void {
		this.claimed.delete(runId);
		this.leaseLog.push(`release:${runId}`);
	}
}

function makeAgent(name: string, tools: string[]): AgentDefinition {
	// Test double: only name/tools are read through the injected seams.
	return { name, description: `${name} agent`, systemPrompt: "", tools, source: "project" } as AgentDefinition;
}

const BASELINE: WorktreeBaseline = {
	root: { repoRoot: REPO_ROOT, headCommit: "head", staged: "", unstaged: "", untracked: [], untrackedPatch: "" },
	nested: [],
};

interface HarnessOptions {
	agents?: AgentDefinition[];
	maxConcurrency?: number;
	model?: string;
	runSubagent?: (request: ParallelSubagentRequest) => Promise<ParallelSubagentResult>;
	commitToBranch?: ParallelCoordinatorDependencies["commitToBranch"];
	mergeTaskBranches?: ParallelCoordinatorDependencies["mergeTaskBranches"];
	currentModelSelector?: string;
	/** Use the coordinator's built-in review worktree seam instead of the fake. */
	defaultReviewWorktree?: boolean;
	/** Host exec seam override; the default succeeds for every command. */
	exec?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
	/** Changed-path seam; the default reports no changes so ownership passes. */
	captureChangedPaths?: ParallelCoordinatorDependencies["captureChangedPaths"];
	/** Dependency materializer; the default records a `dep:` event per branch. */
	materializeDependencyBranches?: ParallelCoordinatorDependencies["materializeDependencyBranches"];
	/** Use the coordinator's built-in git-merge materializer instead of the fake. */
	defaultMaterializer?: boolean;
}

function okResult(output: string): ParallelSubagentResult {
	return { exitCode: 0, output, stderr: "", durationMs: 1 };
}

function makeHarness(options: HarnessOptions = {}) {
	const events: string[] = [];
	const requests: ParallelSubagentRequest[] = [];
	const execCalls: Array<{ command: string; args: string[] }> = [];
	const store = new FakeStore();
	let runCounter = 0;
	let active = 0;
	let maxActive = 0;

	const agents = options.agents ?? [makeAgent("task", ["edit"]), makeAgent("reviewer", ["read"])];
	const runSubagent =
		options.runSubagent ??
		(async (request: ParallelSubagentRequest): Promise<ParallelSubagentResult> => {
			return okResult(`done:${request.id}`);
		});

	const host: ParallelCoordinatorHost = {
		cwd: REPO_ROOT,
		...(options.currentModelSelector === undefined ? {} : { currentModelSelector: options.currentModelSelector }),
		exec: async (command, args) => {
			execCalls.push({ command, args: [...args] });
			return options.exec === undefined ? { stdout: "", stderr: "", exitCode: 0 } : options.exec(command, args);
		},
		discover: async () => ({ agents }),
		runSubagent: async request => {
			requests.push(request);
			active += 1;
			maxActive = Math.max(maxActive, active);
			events.push(`run:${request.id}`);
			try {
				// Yield so sibling wave members can overlap and be counted.
				await Promise.resolve();
				return await runSubagent(request);
			} finally {
				active -= 1;
			}
		},
	};

	const dependencies: ParallelCoordinatorDependencies = {
		store,
		createRunId: () => `run-${++runCounter}`,
		isReadOnly: agent => (agent.tools ?? []).every(tool => tool === "read" || tool === "grep"),
		getRepoRoot: async () => REPO_ROOT,
		captureBaseline: async repoRoot => {
			events.push(`baseline:${repoRoot}`);
			return { root: { ...BASELINE.root, repoRoot }, nested: [] };
		},
		ensureIsolation: async (_baseCwd, id): Promise<IsolationHandle> => {
			events.push(`ensure:${id}`);
			return {
				mergedDir: `/iso/${id}`,
				backend: 0 as IsolationHandle["backend"],
				fellBack: false,
				fallbackReason: null,
			};
		},
		cleanupIsolation: async handle => {
			events.push(`cleanup:${handle.mergedDir}`);
		},
		commitToBranch:
			options.commitToBranch ??
			(async (_dir, _baseline, taskId): Promise<CommitToBranchResult> => {
				events.push(`commit:${taskId}`);
				return { branchName: `task/${taskId}`, baseSha: `base-${taskId}`, nestedPatches: [] };
			}),
		mergeTaskBranches:
			options.mergeTaskBranches ??
			(async (_repoRoot, branches): Promise<MergeBranchResult> => {
				events.push(`merge:${branches.map(branch => branch.branchName).join(",")}`);
				return { merged: branches.map(branch => branch.branchName), failed: [] };
			}),
		cleanupTaskBranches: async (_repoRoot, branches) => {
			events.push(`prune:${branches.join(",")}`);
		},
		captureChangedPaths: options.captureChangedPaths ?? (async () => []),
		...(options.defaultMaterializer === true
			? {}
			: {
					materializeDependencyBranches:
						options.materializeDependencyBranches ??
						(async (worktreeDir: string, branchNames: readonly string[]) => {
							for (const branchName of branchNames) events.push(`dep:${branchName}:${worktreeDir}`);
						}),
				}),
		...(options.defaultReviewWorktree === true
			? {}
			: {
					createReviewWorktree: async (_repoRoot: string, branchName: string, worktreeId: string) => {
						events.push(`review-wt:${branchName}:${worktreeId}`);
						return `/review/${worktreeId}`;
					},
					removeReviewWorktree: async (_repoRoot: string, worktreeDir: string) => {
						events.push(`review-rm:${worktreeDir}`);
					},
				}),
	};

	const coordinator = new ParallelCoordinator(host, dependencies);
	return { coordinator, store, events, requests, execCalls, maxActive: () => maxActive };
}

const REVIEW_OK = JSON.stringify({ approved: true, summary: "looks good", findings: [] });
const REVIEW_REJECT = JSON.stringify({
	approved: false,
	summary: "missing tests",
	findings: [{ path: "src/a.ts", line: 3, message: "untested branch" }],
});

describe("parallel coordinator preflight", () => {
	it("accepts a plan whose agents and reviewers all resolve", async () => {
		const { coordinator } = makeHarness();
		const plan = makePlan([{ id: "a", review: { agent: "reviewer", required: true } }]);
		const result = await coordinator.preflight(plan);
		expect(result.ok).toBe(true);
		expect(result.repoRoot).toBe(REPO_ROOT);
		expect(result.issues).toEqual([]);
	});

	it("rejects missing shard agents, missing reviewers, and non-read-only required reviewers", async () => {
		const { coordinator } = makeHarness({
			agents: [makeAgent("task", ["edit"]), makeAgent("writer-reviewer", ["edit"])],
		});
		const plan = makePlan([
			{ id: "a", agent: "ghost" },
			{ id: "b", review: { agent: "nobody", required: true } },
			{ id: "c", review: { agent: "writer-reviewer", required: true } },
		]);
		const result = await coordinator.preflight(plan);
		expect(result.ok).toBe(false);
		expect(result.issues.map(issue => issue.kind)).toEqual([
			"missing-agent",
			"missing-reviewer",
			"reviewer-not-read-only",
		]);
		expect(result.issues.map(issue => issue.shardId)).toEqual(["a", "b", "c"]);
	});

	it("createRun refuses a plan that fails preflight and never dispatches", async () => {
		const { coordinator, requests } = makeHarness({ agents: [makeAgent("task", ["edit"])] });
		const plan = makePlan([{ id: "a", agent: "ghost" }]);
		await expect(coordinator.createRun(plan)).rejects.toThrow("preflight failed");
		expect(requests).toHaveLength(0);
	});
});

describe("parallel coordinator dispatch", () => {
	it("runs dependency-ready shards in waves capped by maxConcurrency", async () => {
		const gates = new Map<string, () => void>();
		const harness = makeHarness({
			runSubagent: async request => {
				await new Promise<void>(resolve => gates.set(request.id, resolve));
				return okResult(`done:${request.id}`);
			},
		});
		const plan = makePlan([{ id: "a" }, { id: "b" }, { id: "c", dependsOn: ["a", "b"] }], { maxConcurrency: 1 });
		const created = await harness.coordinator.createRun(plan);
		const resumePromise = harness.coordinator.resume(created.run.runId);

		// Cap of 1: only one runner may be in flight per wave.
		for (const id of ["run-1-a", "run-1-b", "run-1-c"]) {
			while (!gates.has(id)) await Promise.resolve();
			expect(gates.size).toBe(1);
			const release = gates.get(id);
			gates.delete(id);
			release?.();
		}
		const snapshot = await resumePromise;
		expect(harness.maxActive()).toBe(1);
		expect(snapshot.run.status).toBe("ready_to_integrate");
		// Dependent dispatched only after both dependencies completed.
		const order = harness.requests.map(request => request.id);
		expect(order).toEqual(["run-1-a", "run-1-b", "run-1-c"]);
	});

	it("passes the isolated worktree, model override, and repo cwd to the runner", async () => {
		const harness = makeHarness({ model: "@smol", currentModelSelector: "@fallback" });
		const plan = makePlan([{ id: "a" }], { model: "@smol" });
		const created = await harness.coordinator.createRun(plan);
		await harness.coordinator.resume(created.run.runId);
		expect(harness.requests).toHaveLength(1);
		const request = harness.requests[0];
		expect(request?.cwd).toBe(REPO_ROOT);
		expect(request?.worktree).toBe("/iso/run-1-a");
		expect(request?.modelOverride).toBe("@smol");
		expect(request?.task).toBe("Implement shard a.");
	});

	it("persists branch, base SHA, and output, and cleans isolation up even on failure", async () => {
		const harness = makeHarness({
			runSubagent: async request =>
				request.id === "run-1-boom"
					? { exitCode: 1, output: "", stderr: "exploded", error: "boom", durationMs: 1 }
					: okResult(`done:${request.id}`),
		});
		const plan = makePlan([{ id: "good" }, { id: "boom" }]);
		const created = await harness.coordinator.createRun(plan);
		const snapshot = await harness.coordinator.resume(created.run.runId);

		const good = snapshot.shards.find(shard => shard.shardId === "good");
		expect(good?.status).toBe("completed");
		expect(good?.branchName).toBe("task/run-1-good");
		expect(good?.baseSha).toBe("base-run-1-good");
		expect(good?.outputExcerpt).toBe("done:run-1-good");

		const boom = snapshot.shards.find(shard => shard.shardId === "boom");
		expect(boom?.status).toBe("failed");
		expect(boom?.error).toBe("boom");
		expect(snapshot.run.status).toBe("failed");

		// Isolation is torn down for both the success and the failure.
		expect(harness.events).toContain("cleanup:/iso/run-1-good");
		expect(harness.events).toContain("cleanup:/iso/run-1-boom");
		// Commit ordering: ensure -> baseline -> run -> commit -> cleanup for the success.
		const sequence = harness.events.filter(
			event => event.endsWith("run-1-good") || event === "cleanup:/iso/run-1-good",
		);
		expect(sequence).toEqual([
			"ensure:run-1-good",
			"baseline:/iso/run-1-good",
			"run:run-1-good",
			"commit:run-1-good",
			"cleanup:/iso/run-1-good",
		]);
	});

	it("blocks dependents of a failed shard and fails the run", async () => {
		const harness = makeHarness({
			runSubagent: async request =>
				request.id === "run-1-a"
					? { exitCode: 1, output: "", stderr: "", error: "dead", durationMs: 1 }
					: okResult(`done:${request.id}`),
		});
		const plan = makePlan([{ id: "a" }, { id: "b", dependsOn: ["a"] }]);
		const created = await harness.coordinator.createRun(plan);
		const snapshot = await harness.coordinator.resume(created.run.runId);
		expect(harness.requests.map(request => request.id)).toEqual(["run-1-a"]);
		expect(snapshot.shards.find(shard => shard.shardId === "b")?.status).toBe("pending");
		expect(snapshot.run.status).toBe("failed");
		expect(snapshot.run.lastError).toBe("dead");
	});
});

describe("parallel coordinator reviews", () => {
	it("runs required reviews in a temporary worktree and always removes it", async () => {
		const harness = makeHarness({
			runSubagent: async request => (request.id.endsWith("-review") ? okResult(REVIEW_OK) : okResult("did work")),
		});
		const plan = makePlan([{ id: "a", review: { agent: "reviewer", required: true } }]);
		const created = await harness.coordinator.createRun(plan);
		const snapshot = await harness.coordinator.resume(created.run.runId);

		expect(snapshot.shards[0]?.status).toBe("approved");
		expect(snapshot.reviews[0]?.status).toBe("approved");
		expect(snapshot.reviews[0]?.summary).toBe("looks good");
		expect(snapshot.run.status).toBe("ready_to_integrate");
		expect(harness.events).toContain("review-wt:task/run-1-a:run-1-a-review");
		expect(harness.events).toContain("review-rm:/review/run-1-a-review");
		// Review dispatch happened after the branch was persisted and isolation cleaned.
		const cleanupIndex = harness.events.indexOf("cleanup:/iso/run-1-a");
		const reviewIndex = harness.events.indexOf("review-wt:task/run-1-a:run-1-a-review");
		expect(cleanupIndex).toBeGreaterThanOrEqual(0);
		expect(reviewIndex).toBeGreaterThan(cleanupIndex);
	});

	it("a rejected required review leaves the run review_pending and review() retries it", async () => {
		let verdict = REVIEW_REJECT;
		const harness = makeHarness({
			runSubagent: async request => (request.id.endsWith("-review") ? okResult(verdict) : okResult("did work")),
		});
		const plan = makePlan([{ id: "a", review: { agent: "reviewer", required: true } }]);
		const created = await harness.coordinator.createRun(plan);
		const rejected = await harness.coordinator.resume(created.run.runId);
		expect(rejected.reviews[0]?.status).toBe("rejected");
		expect(rejected.reviews[0]?.findings).toEqual([{ path: "src/a.ts", line: 3, message: "untested branch" }]);
		expect(rejected.shards[0]?.status).toBe("review_pending");
		expect(rejected.run.status).toBe("review_pending");

		verdict = REVIEW_OK;
		const retried = await harness.coordinator.review(created.run.runId);
		expect(retried.reviews[0]?.status).toBe("approved");
		expect(retried.shards[0]?.status).toBe("approved");
		expect(retried.run.status).toBe("ready_to_integrate");
		// Both attempts created and removed their temporary worktree.
		expect(harness.events.filter(event => event.startsWith("review-wt:")).length).toBe(2);
		expect(harness.events.filter(event => event.startsWith("review-rm:")).length).toBe(2);
	});

	it("fails closed on malformed reviewer output", async () => {
		const harness = makeHarness({
			runSubagent: async request =>
				request.id.endsWith("-review") ? okResult("I approve! ship it") : okResult("did work"),
		});
		const plan = makePlan([{ id: "a", review: { agent: "reviewer", required: true } }]);
		const created = await harness.coordinator.createRun(plan);
		const snapshot = await harness.coordinator.resume(created.run.runId);
		expect(snapshot.reviews[0]?.status).toBe("failed");
		expect(snapshot.reviews[0]?.error).toBe("reviewer returned malformed verdict JSON");
		expect(snapshot.shards[0]?.status).toBe("review_pending");
		expect(snapshot.run.status).toBe("review_pending");
		expect(harness.events).toContain("review-rm:/review/run-1-a-review");
	});

	it("the default review worktree seam uses a unique directory per attempt", async () => {
		let verdict = "not json";
		const harness = makeHarness({
			defaultReviewWorktree: true,
			runSubagent: async request => (request.id.endsWith("-review") ? okResult(verdict) : okResult("did work")),
		});
		const plan = makePlan([{ id: "a", review: { agent: "reviewer", required: true } }]);
		const created = await harness.coordinator.createRun(plan);
		const first = await harness.coordinator.resume(created.run.runId);
		expect(first.reviews[0]?.status).toBe("failed");

		verdict = REVIEW_OK;
		const retried = await harness.coordinator.review(created.run.runId);
		expect(retried.reviews[0]?.status).toBe("approved");

		// Both attempts ran `git worktree add` against distinct directories, so
		// a leftover registration from attempt one cannot block attempt two.
		const adds = harness.execCalls.filter(
			call => call.command === "git" && call.args.includes("worktree") && call.args.includes("add"),
		);
		expect(adds).toHaveLength(2);
		const dirs = adds.map(call => call.args[5] ?? "");
		expect(dirs[0]).not.toBe(dirs[1]);
		for (const dir of dirs) expect(dir).toContain("omp-parallel-review-run-1-a-review-");
		// Best-effort removal targeted each attempt's own directory.
		const removes = harness.execCalls.filter(call => call.command === "git" && call.args.includes("remove"));
		expect(removes.map(call => call.args[5])).toEqual(dirs);
	});

	it("a required review on a no-op shard is auto-approved and the run integrates", async () => {
		const harness = makeHarness({ commitToBranch: async () => null });
		const plan = makePlan([{ id: "a", review: { agent: "reviewer", required: true } }]);
		const created = await harness.coordinator.createRun(plan);
		const snapshot = await harness.coordinator.resume(created.run.runId);

		expect(snapshot.shards[0]?.status).toBe("completed");
		expect(snapshot.shards[0]?.branchName).toBeNull();
		expect(snapshot.reviews[0]?.status).toBe("approved");
		expect(snapshot.reviews[0]?.summary).toBe("No changes produced; review skipped.");
		expect(snapshot.run.status).toBe("ready_to_integrate");
		// The review subagent was never dispatched for the no-op shard.
		expect(harness.requests.some(request => request.id.endsWith("-review"))).toBe(false);

		const integrated = await harness.coordinator.integrate(created.run.runId);
		expect(integrated.run.status).toBe("integrated");
	});

	it("parseParallelReviewVerdict enforces the strict bounded shape", () => {
		expect(parseParallelReviewVerdict(REVIEW_OK)).toEqual({ approved: true, summary: "looks good", findings: [] });
		expect(parseParallelReviewVerdict(`prose before {"approved":false,"summary":"s","findings":[]} after`)).toEqual({
			approved: false,
			summary: "s",
			findings: [],
		});
		expect(parseParallelReviewVerdict("not json")).toBeNull();
		expect(parseParallelReviewVerdict('{"approved":"yes","summary":"s","findings":[]}')).toBeNull();
		expect(parseParallelReviewVerdict('{"approved":true,"summary":"s"}')).toBeNull();
		expect(parseParallelReviewVerdict('{"approved":true,"summary":"s","findings":[{"message":"m"}]}')).toBeNull();
		expect(
			parseParallelReviewVerdict(`{"approved":true,"summary":"s","findings":[]}${" ".repeat(100_001)}`),
		).toBeNull();
	});
});

describe("parallel coordinator cancellation", () => {
	it("aborts in-flight shards and marks nonterminal rows cancelled without integrating", async () => {
		let started: (() => void) | null = null;
		const startedPromise = new Promise<void>(resolve => {
			started = resolve;
		});
		const harness = makeHarness({
			runSubagent: request =>
				new Promise<ParallelSubagentResult>(resolve => {
					started?.();
					request.signal.addEventListener("abort", () => {
						resolve({
							exitCode: 1,
							output: "",
							stderr: "",
							aborted: true,
							abortReason: "cancelled",
							durationMs: 1,
						});
					});
				}),
		});
		const plan = makePlan([{ id: "a" }, { id: "b", dependsOn: ["a"] }]);
		const created = await harness.coordinator.createRun(plan);
		const resumePromise = harness.coordinator.resume(created.run.runId);
		await startedPromise;

		const cancelled = await harness.coordinator.cancel(created.run.runId);
		expect(cancelled.run.status).toBe("cancelled");
		await resumePromise;

		const snapshot = await harness.coordinator.wait(created.run.runId);
		expect(snapshot.run.status).toBe("cancelled");
		for (const shard of snapshot.shards) expect(shard.status).toBe("cancelled");
		expect(harness.events.some(event => event.startsWith("merge:"))).toBe(false);
		// Isolation for the aborted shard was still cleaned up.
		expect(harness.events).toContain("cleanup:/iso/run-1-a");
	});
});

describe("parallel coordinator integration", () => {
	it("refuses to integrate before every shard and required review is approved", async () => {
		const harness = makeHarness();
		const plan = makePlan([{ id: "a", review: { agent: "reviewer", required: true } }]);
		const created = await harness.coordinator.createRun(plan);
		await expect(harness.coordinator.integrate(created.run.runId)).rejects.toThrow("cannot integrate");
	});

	it("merges branches in manifest order and cleans up merged branches on success", async () => {
		const harness = makeHarness({
			runSubagent: async request => (request.id.endsWith("-review") ? okResult(REVIEW_OK) : okResult("did work")),
		});
		const plan = makePlan([{ id: "a", review: { agent: "reviewer", required: true } }, { id: "b" }]);
		const created = await harness.coordinator.createRun(plan);
		await harness.coordinator.resume(created.run.runId);
		const snapshot = await harness.coordinator.integrate(created.run.runId);
		expect(snapshot.run.status).toBe("integrated");
		expect(harness.events).toContain("merge:task/run-1-a,task/run-1-b");
		expect(harness.events).toContain("prune:task/run-1-a,task/run-1-b");
	});

	it("a merge conflict prunes and clears only merged branches, and a retry integrates the rest", async () => {
		let attempt = 0;
		const mergeCalls: string[][] = [];
		const harness = makeHarness({
			mergeTaskBranches: async (_repoRoot, branches) => {
				attempt += 1;
				mergeCalls.push(branches.map(branch => branch.branchName));
				if (attempt === 1) {
					return {
						merged: [branches[0]?.branchName ?? ""],
						failed: [branches[1]?.branchName ?? ""],
						conflict: "conflict cherry-picking task/run-1-b",
					};
				}
				return { merged: branches.map(branch => branch.branchName), failed: [] };
			},
		});
		const plan = makePlan([{ id: "a" }, { id: "b" }]);
		const created = await harness.coordinator.createRun(plan);
		await harness.coordinator.resume(created.run.runId);
		const snapshot = await harness.coordinator.integrate(created.run.runId);

		expect(snapshot.run.status).toBe("failed");
		expect(snapshot.run.lastError).toBe("conflict cherry-picking task/run-1-b");
		// The merged branch is pruned and cleared; the failed branch survives for retry.
		expect(snapshot.shards.map(shard => shard.branchName)).toEqual([null, "task/run-1-b"]);
		expect(harness.events).toContain("prune:task/run-1-a");
		expect(harness.events.some(event => event.includes("task/run-1-b") && event.startsWith("prune:"))).toBe(false);

		// resume() leaves the integration-failed run untouched for explicit retry.
		const resumed = await harness.coordinator.resume(created.run.runId);
		expect(resumed.run.status).toBe("failed");
		expect(resumed.run.lastError).toBe("conflict cherry-picking task/run-1-b");

		// The retry submits only the unmerged branch; the pruned one is never re-merged.
		const retried = await harness.coordinator.integrate(created.run.runId);
		expect(retried.run.status).toBe("integrated");
		expect(retried.run.lastError).toBeNull();
		expect(mergeCalls).toEqual([["task/run-1-a", "task/run-1-b"], ["task/run-1-b"]]);
		expect(retried.shards.map(shard => shard.branchName)).toEqual([null, null]);
	});
});

describe("parallel coordinator recovery and status", () => {
	it("resume requeues interrupted rows and finishes them", async () => {
		const harness = makeHarness({
			runSubagent: async request => (request.id.endsWith("-review") ? okResult(REVIEW_OK) : okResult("did work")),
		});
		const plan = makePlan([{ id: "a", review: { agent: "reviewer", required: true } }]);
		const created = await harness.coordinator.createRun(plan);
		harness.store.updateRun(created.run.runId, { status: "interrupted" });
		harness.store.updateShard(created.run.runId, "a", { status: "interrupted" });
		harness.store.updateReview(created.run.runId, "a", { status: "interrupted" });

		const snapshot = await harness.coordinator.resume(created.run.runId);
		expect(snapshot.shards[0]?.status).toBe("approved");
		expect(snapshot.run.status).toBe("ready_to_integrate");
	});

	it("status returns one snapshot or bounded summaries for all runs", async () => {
		const harness = makeHarness();
		const plan = makePlan([{ id: "a" }]);
		const created = await harness.coordinator.createRun(plan);
		const single = await harness.coordinator.status(created.run.runId);
		expect("run" in single && single.run.runId).toBe(created.run.runId);
		const all = await harness.coordinator.status();
		expect(Array.isArray(all)).toBe(true);
		if (Array.isArray(all)) expect(all.map(summary => summary.runId)).toEqual([created.run.runId]);
		await expect(harness.coordinator.status("nope")).rejects.toThrow('unknown run "nope"');
	});
});

describe("parallel coordinator guards", () => {
	it("integrate rejects a cancelled run, even one that was ready to integrate", async () => {
		const harness = makeHarness();
		const plan = makePlan([{ id: "a" }]);
		const created = await harness.coordinator.createRun(plan);
		const resumed = await harness.coordinator.resume(created.run.runId);
		expect(resumed.run.status).toBe("ready_to_integrate");

		const cancelled = await harness.coordinator.cancel(created.run.runId);
		expect(cancelled.run.status).toBe("cancelled");

		await expect(harness.coordinator.integrate(created.run.runId)).rejects.toThrow("run is cancelled");
		expect(harness.events.some(event => event.startsWith("merge:"))).toBe(false);
	});

	it("review() before any shard has run preserves the planned status and dispatches nothing", async () => {
		const harness = makeHarness();
		const plan = makePlan([{ id: "a", review: { agent: "reviewer", required: true } }]);
		const created = await harness.coordinator.createRun(plan);
		const snapshot = await harness.coordinator.review(created.run.runId);
		expect(snapshot.run.status).toBe("planned");
		expect(snapshot.reviews[0]?.status).toBe("pending");
		expect(harness.requests).toHaveLength(0);
	});

	it("wait() blocks on every concurrent in-flight operation, not only the latest", async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		let started: (() => void) | null = null;
		const startedPromise = new Promise<void>(resolve => {
			started = resolve;
		});
		const harness = makeHarness({
			runSubagent: async request => {
				started?.();
				await gate;
				return okResult(`done:${request.id}`);
			},
		});
		const plan = makePlan([{ id: "a" }]);
		const created = await harness.coordinator.createRun(plan);
		const resumePromise = harness.coordinator.resume(created.run.runId);
		await startedPromise;

		// A quick no-op review() registers and settles while resume is in flight.
		await harness.coordinator.review(created.run.runId);

		let waited = false;
		const waitPromise = harness.coordinator.wait(created.run.runId).then(snapshot => {
			waited = true;
			return snapshot;
		});
		for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
		expect(waited).toBe(false);

		release();
		const snapshot = await waitPromise;
		expect(waited).toBe(true);
		expect(snapshot.run.status).toBe("ready_to_integrate");
		await resumePromise;
	});
});

describe("parallel coordinator dependency materialization", () => {
	it("materializes transitive dependency branches in the isolated worktree before capturing the baseline", async () => {
		const baselines: WorktreeBaseline[] = [];
		const harness = makeHarness({
			commitToBranch: async (_dir, baseline, taskId): Promise<CommitToBranchResult> => {
				baselines.push(baseline);
				return { branchName: `task/${taskId}`, baseSha: `base-${taskId}`, nestedPatches: [] };
			},
		});
		const plan = makePlan([{ id: "a" }, { id: "b", dependsOn: ["a"] }, { id: "c", dependsOn: ["b"] }]);
		const created = await harness.coordinator.createRun(plan);
		const snapshot = await harness.coordinator.resume(created.run.runId);
		expect(snapshot.run.status).toBe("ready_to_integrate");

		// b sees a's branch; c sees the transitive closure in manifest order.
		expect(harness.events.filter(event => event.startsWith("dep:") && event.endsWith(":/iso/run-1-b"))).toEqual([
			"dep:task/run-1-a:/iso/run-1-b",
		]);
		expect(harness.events.filter(event => event.startsWith("dep:") && event.endsWith(":/iso/run-1-c"))).toEqual([
			"dep:task/run-1-a:/iso/run-1-c",
			"dep:task/run-1-b:/iso/run-1-c",
		]);
		// Per-shard ordering: ensure -> materialize -> baseline -> run.
		const bEvents = harness.events.filter(event => event.includes("run-1-b"));
		expect(bEvents.indexOf("dep:task/run-1-a:/iso/run-1-b")).toBeGreaterThan(bEvents.indexOf("ensure:run-1-b"));
		expect(bEvents.indexOf("baseline:/iso/run-1-b")).toBeGreaterThan(
			bEvents.indexOf("dep:task/run-1-a:/iso/run-1-b"),
		);
		expect(bEvents.indexOf("run:run-1-b")).toBeGreaterThan(bEvents.indexOf("baseline:/iso/run-1-b"));
		// The baseline handed to the commit helper is normalized back to the
		// real repository so the task branch lands there, not in the isolation.
		expect(baselines).toHaveLength(3);
		for (const baseline of baselines) expect(baseline.root.repoRoot).toBe(REPO_ROOT);
	});

	it("treats a dependency that produced no branch as a no-op", async () => {
		const harness = makeHarness({
			commitToBranch: async (_dir, _baseline, taskId): Promise<CommitToBranchResult | null> =>
				taskId === "run-1-a"
					? null
					: { branchName: `task/${taskId}`, baseSha: `base-${taskId}`, nestedPatches: [] },
		});
		const plan = makePlan([{ id: "a" }, { id: "b", dependsOn: ["a"] }]);
		const created = await harness.coordinator.createRun(plan);
		const snapshot = await harness.coordinator.resume(created.run.runId);
		expect(snapshot.run.status).toBe("ready_to_integrate");
		expect(snapshot.shards.find(shard => shard.shardId === "b")?.status).toBe("completed");
		expect(harness.events.some(event => event.startsWith("dep:"))).toBe(false);
	});

	it("the default materializer merges --no-commit --no-ff and a failure fails the shard clearly", async () => {
		const harness = makeHarness({
			defaultMaterializer: true,
			exec: async (_command, args) =>
				args.includes("merge")
					? { stdout: "", stderr: "merge exploded", exitCode: 1 }
					: { stdout: "", stderr: "", exitCode: 0 },
		});
		const plan = makePlan([{ id: "a" }, { id: "b", dependsOn: ["a"] }]);
		const created = await harness.coordinator.createRun(plan);
		const snapshot = await harness.coordinator.resume(created.run.runId);

		const merge = harness.execCalls.find(call => call.args.includes("merge"));
		expect(merge?.command).toBe("git");
		expect(merge?.args).toEqual(["-C", "/iso/run-1-b", "merge", "--no-commit", "--no-ff", "task/run-1-a"]);

		const failed = snapshot.shards.find(shard => shard.shardId === "b");
		expect(failed?.status).toBe("failed");
		expect(failed?.error).toContain('failed to materialize dependency "a" (task/run-1-a) for shard "b"');
		expect(failed?.error).toContain("merge exploded");
		expect(snapshot.shards.find(shard => shard.shardId === "a")?.status).toBe("completed");
		expect(snapshot.run.status).toBe("failed");
		// Isolation for the failed shard was still torn down.
		expect(harness.events).toContain("cleanup:/iso/run-1-b");
	});
	it("merges all dependency branches in one concluded merge", async () => {
		let mergeInProgress = false;
		const mergeCalls: string[] = [];
		let quitCalls = 0;
		const harness = makeHarness({
			defaultMaterializer: true,
			exec: async (_command, args) => {
				if (args.includes("--quit")) {
					quitCalls += 1;
					mergeInProgress = false;
					return { stdout: "", stderr: "", exitCode: 0 };
				}
				if (args.includes("merge")) {
					const noFastForward = args.indexOf("--no-ff");
					mergeCalls.push(args.slice(noFastForward + 1).join(","));
					if (mergeInProgress) {
						return { stdout: "", stderr: "MERGE_HEAD exists", exitCode: 1 };
					}
					mergeInProgress = true;
					return { stdout: "", stderr: "", exitCode: 0 };
				}
				return { stdout: "", stderr: "", exitCode: 0 };
			},
		});
		const plan = makePlan([{ id: "a" }, { id: "b", dependsOn: ["a"] }, { id: "c", dependsOn: ["b"] }]);
		const created = await harness.coordinator.createRun(plan);
		const snapshot = await harness.coordinator.resume(created.run.runId);

		expect(snapshot.run.status).toBe("ready_to_integrate");
		expect(snapshot.shards.every(shard => shard.status === "completed")).toBe(true);
		expect(mergeCalls).toEqual(["task/run-1-a", "task/run-1-a,task/run-1-b"]);
		expect(quitCalls).toBe(2);
	});
});

describe("parallel coordinator ownership enforcement", () => {
	it("rejects out-of-scope changes without creating a task branch", async () => {
		const harness = makeHarness({
			captureChangedPaths: async () => ["src/a.ts", "src/evil.ts", "./src/evil.ts"],
		});
		const plan = makePlan([{ id: "a" }]);
		const created = await harness.coordinator.createRun(plan);
		const snapshot = await harness.coordinator.resume(created.run.runId);

		const shard = snapshot.shards[0];
		expect(shard?.status).toBe("failed");
		expect(shard?.error).toBe('shard "a" changed paths outside its owns list: src/evil.ts');
		expect(shard?.branchName).toBeNull();
		expect(snapshot.run.status).toBe("failed");
		// No task branch commit was attempted; isolation still cleaned up.
		expect(harness.events.some(event => event.startsWith("commit:"))).toBe(false);
		expect(harness.events).toContain("cleanup:/iso/run-1-a");
	});

	it("accepts changes under an owned directory prefix", async () => {
		const harness = makeHarness({
			captureChangedPaths: async () => ["src/mod/deep/file.ts", "./src/mod/other.ts"],
		});
		const plan = makePlan([{ id: "a", owns: ["src/mod"] }]);
		const created = await harness.coordinator.createRun(plan);
		const snapshot = await harness.coordinator.resume(created.run.runId);
		expect(snapshot.shards[0]?.status).toBe("completed");
		expect(snapshot.shards[0]?.branchName).toBe("task/run-1-a");
		expect(snapshot.run.status).toBe("ready_to_integrate");
	});

	it("parallelPatchTouchedPaths reads modify, add, delete, rename, and quoted binary headers", () => {
		const patch = [
			"diff --git a/src/mod.ts b/src/mod.ts",
			"index 1111111..2222222 100644",
			"--- a/src/mod.ts",
			"+++ b/src/mod.ts",
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"diff --git a/src/new.ts b/src/new.ts",
			"new file mode 100644",
			"--- /dev/null",
			"+++ b/src/new.ts",
			"@@ -0,0 +1 @@",
			"+created",
			"diff --git a/src/old.ts b/src/old.ts",
			"deleted file mode 100644",
			"--- a/src/old.ts",
			"+++ /dev/null",
			"@@ -1 +0,0 @@",
			"-gone",
			"diff --git a/src/from.ts b/src/to.ts",
			"similarity index 100%",
			"rename from src/from.ts",
			"rename to src/to.ts",
			'diff --git "a/src/spa ce.ts" "b/src/spa ce.ts"',
			'Binary files "a/src/spa ce.ts" and "b/src/spa ce.ts" differ',
		].join("\n");
		expect(parallelPatchTouchedPaths(patch)).toEqual([
			"src/from.ts",
			"src/mod.ts",
			"src/new.ts",
			"src/old.ts",
			"src/spa ce.ts",
			"src/to.ts",
		]);
	});
});

describe("parallel coordinator run leases", () => {
	it("wraps resume, review, integrate, and idle cancel in a claim/release pair", async () => {
		const harness = makeHarness({
			runSubagent: async request => (request.id.endsWith("-review") ? okResult(REVIEW_OK) : okResult("did work")),
		});
		const plan = makePlan([{ id: "a" }]);
		const created = await harness.coordinator.createRun(plan);
		const runId = created.run.runId;
		expect(harness.store.leaseLog).toEqual([]);

		await harness.coordinator.resume(runId);
		expect(harness.store.leaseLog).toEqual([`claim:${runId}`, `release:${runId}`]);

		await harness.coordinator.review(runId);
		await harness.coordinator.integrate(runId);
		await harness.coordinator.cancel(runId);
		expect(harness.store.leaseLog).toEqual([
			`claim:${runId}`,
			`release:${runId}`,
			`claim:${runId}`,
			`release:${runId}`,
			`claim:${runId}`,
			`release:${runId}`,
			`claim:${runId}`,
			`release:${runId}`,
		]);
	});

	it("overlapping local operations share one claim and cancel never releases a held lease", async () => {
		let releaseRunner!: () => void;
		const runnerGate = new Promise<void>(resolve => {
			releaseRunner = resolve;
		});
		let started: (() => void) | null = null;
		const startedPromise = new Promise<void>(resolve => {
			started = resolve;
		});
		const harness = makeHarness({
			runSubagent: async request => {
				started?.();
				await runnerGate;
				return okResult(`done:${request.id}`);
			},
		});
		const plan = makePlan([{ id: "a" }]);
		const created = await harness.coordinator.createRun(plan);
		const runId = created.run.runId;
		const resumePromise = harness.coordinator.resume(runId);
		await startedPromise;
		expect(harness.store.leaseLog).toEqual([`claim:${runId}`]);

		// cancel piggybacks on the lease resume still holds: no extra claim,
		// and no release until the last local holder settles.
		const cancelled = await harness.coordinator.cancel(runId);
		expect(cancelled.run.status).toBe("cancelled");
		expect(harness.store.leaseLog).toEqual([`claim:${runId}`]);

		releaseRunner();
		await resumePromise;
		await harness.coordinator.wait(runId);
		expect(harness.store.leaseLog).toEqual([`claim:${runId}`, `release:${runId}`]);
	});

	it("a claim rejected by a live foreign owner fails the operation before any dispatch", async () => {
		const harness = makeHarness();
		const plan = makePlan([{ id: "a" }]);
		const created = await harness.coordinator.createRun(plan);
		harness.store.claimError = new Error('run "run-1" is claimed by live process 4242');
		await expect(harness.coordinator.resume(created.run.runId)).rejects.toThrow("claimed by live process 4242");
		expect(harness.requests).toHaveLength(0);
		// The rejected claim never produced a spurious release.
		expect(harness.store.leaseLog).toEqual([]);

		harness.store.claimError = null;
		const snapshot = await harness.coordinator.resume(created.run.runId);
		expect(snapshot.run.status).toBe("ready_to_integrate");
		expect(harness.store.leaseLog).toEqual([`claim:${created.run.runId}`, `release:${created.run.runId}`]);
	});
});

describe("parallel coordinator repeated integrate", () => {
	it("reuses the exact in-flight integration promise and clears the slot on settle", async () => {
		let releaseMerge!: () => void;
		const mergeGate = new Promise<void>(resolve => {
			releaseMerge = resolve;
		});
		let mergeCalls = 0;
		const harness = makeHarness({
			mergeTaskBranches: async (_repoRoot, branches) => {
				mergeCalls += 1;
				await mergeGate;
				return { merged: branches.map(branch => branch.branchName), failed: [] };
			},
		});
		const plan = makePlan([{ id: "a" }]);
		const created = await harness.coordinator.createRun(plan);
		await harness.coordinator.resume(created.run.runId);

		const first = harness.coordinator.integrate(created.run.runId);
		const second = harness.coordinator.integrate(created.run.runId);
		expect(second).toBe(first);

		releaseMerge();
		const snapshot = await first;
		expect(snapshot.run.status).toBe("integrated");
		expect(mergeCalls).toBe(1);
		// Settled slot cleared: the next call is a fresh attempt, rejected
		// because the run is already integrated rather than silently reused.
		await expect(harness.coordinator.integrate(created.run.runId)).rejects.toThrow("already integrated");
	});
});
