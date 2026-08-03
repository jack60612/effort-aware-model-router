import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { createModelRouterExtension } from "../src/extension";
import {
	formatParallelRunSnapshot,
	formatParallelRunSummaries,
	PARALLEL_COMMAND_USAGE,
	PARALLEL_STATUS_MAX_RUNS,
	PARALLEL_STATUS_TEXT_MAX_CHARS,
	type ParallelCommandCoordinator,
	type ParallelCommandRuntime,
	parallelArgumentCompletions,
	parallelSnapshotToJson,
	parallelSummariesToJson,
	parseParallelCommandArgs,
	registerParallelCommand,
} from "../src/parallel/commands";
import type { ParallelRunStatus, ParallelWorkflowPlan } from "../src/parallel/contracts";
import { validateParallelWorkflowManifest } from "../src/parallel/contracts";
import type { ParallelRunSnapshot } from "../src/parallel/coordinator";
import type { ParallelRunSummary, ParallelShardRecord, ParallelStoredRun } from "../src/parallel/storage";

const SOURCE = "manifest.yml";

function makePlan(shardIds: string[] = ["core"]): ParallelWorkflowPlan {
	return validateParallelWorkflowManifest(
		{
			run: "test-run",
			maxConcurrency: 4,
			contracts: [],
			shards: shardIds.map(id => ({
				id,
				kind: "implementation",
				agent: "task",
				prompt: `Implement shard ${id}.`,
				owns: [`src/${id}.ts`],
				produces: [],
				requires: [],
				dependsOn: [],
			})),
		},
		SOURCE,
	);
}

function makeStored(
	runId: string,
	status: ParallelRunStatus,
	options: {
		plan?: ParallelWorkflowPlan;
		lastError?: string | null;
		shards?: Array<Partial<ParallelShardRecord> & { shardId: string }>;
		reviews?: Array<{ shardId: string; agent: string; status: string; summary?: string | null; error?: string | null }>;
	} = {},
): ParallelStoredRun {
	const plan = options.plan ?? makePlan();
	const shardInputs: Array<Partial<ParallelShardRecord> & { shardId: string }> =
		options.shards ?? plan.shards.map(shard => ({ shardId: shard.id }));
	return {
		run: {
			runId,
			cwd: "/project",
			repoRoot: "/project",
			planHash: plan.planHash,
			plan,
			baseSha: null,
			status,
			lastError: options.lastError ?? null,
			createdAt: 1,
			updatedAt: 2,
		},
		shards: shardInputs.map(shard => ({
			runId,
			shardId: shard.shardId,
			status: shard.status ?? "pending",
			branchName: shard.branchName ?? null,
			baseSha: shard.baseSha ?? null,
			outputExcerpt: shard.outputExcerpt ?? null,
			error: shard.error ?? null,
			createdAt: 1,
			updatedAt: 2,
		})),
		reviews: (options.reviews ?? []).map(review => ({
			runId,
			shardId: review.shardId,
			agent: review.agent,
			status: review.status as ParallelStoredRun["reviews"][number]["status"],
			summary: review.summary ?? null,
			findings: [],
			error: review.error ?? null,
			createdAt: 1,
			updatedAt: 2,
		})),
	};
}

function makeSummary(runId: string, status: ParallelRunStatus, lastError: string | null = null): ParallelRunSummary {
	return { runId, runName: "test-run", status, planHash: "hash", lastError, createdAt: 1, updatedAt: 2 };
}

type Deferred = { promise: Promise<ParallelRunSnapshot>; resolve: (s: ParallelRunSnapshot) => void; reject: (e: Error) => void };

function deferred(): Deferred {
	let resolve!: (s: ParallelRunSnapshot) => void;
	let reject!: (e: Error) => void;
	const promise = new Promise<ParallelRunSnapshot>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

class FakeCoordinator implements ParallelCommandCoordinator {
	readonly calls: Array<{ method: string; runId?: string }> = [];
	createRunResult: ParallelRunSnapshot | Error = makeStored("run-created", "planned");
	statusResult: ParallelRunSnapshot | readonly ParallelRunSummary[] | Error = [];
	cancelResult: ParallelRunSnapshot | Error = makeStored("run-cancelled", "cancelled");
	operationResults: Array<Promise<ParallelRunSnapshot>> = [];
	lastCreatedPlan: ParallelWorkflowPlan | undefined;

	async createRun(plan: ParallelWorkflowPlan): Promise<ParallelRunSnapshot> {
		this.calls.push({ method: "createRun" });
		this.lastCreatedPlan = plan;
		if (this.createRunResult instanceof Error) throw this.createRunResult;
		return this.createRunResult;
	}
	async resume(runId: string): Promise<ParallelRunSnapshot> {
		this.calls.push({ method: "resume", runId });
		return this.nextOperation();
	}
	async review(runId: string): Promise<ParallelRunSnapshot> {
		this.calls.push({ method: "review", runId });
		return this.nextOperation();
	}
	async integrate(runId: string): Promise<ParallelRunSnapshot> {
		this.calls.push({ method: "integrate", runId });
		return this.nextOperation();
	}
	async cancel(runId: string): Promise<ParallelRunSnapshot> {
		this.calls.push({ method: "cancel", runId });
		if (this.cancelResult instanceof Error) throw this.cancelResult;
		return this.cancelResult;
	}
	async status(runId?: string): Promise<ParallelRunSnapshot | readonly ParallelRunSummary[]> {
		this.calls.push({ method: "status", runId });
		if (this.statusResult instanceof Error) throw this.statusResult;
		return this.statusResult;
	}
	async wait(runId: string): Promise<ParallelRunSnapshot> {
		this.calls.push({ method: "wait", runId });
		return this.nextOperation();
	}

	private nextOperation(): Promise<ParallelRunSnapshot> {
		const next = this.operationResults.shift();
		return next ?? Promise.resolve(makeStored("run-op", "ready_to_integrate"));
	}
}

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];

class CommandHarness {
	readonly commands = new Map<string, CommandOptions["handler"]>();
	readonly completions = new Map<string, NonNullable<CommandOptions["getArgumentCompletions"]>>();
	readonly notifications: Array<{ message: string; type: string | undefined }> = [];
	readonly coordinator = new FakeCoordinator();
	readonly createRuntimeCalls: string[] = [];
	readonly selectorUpdates: Array<string | undefined> = [];
	runIds: string[] = [];
	cwd = "/project";
	currentModel: { provider: string; id: string } | undefined = { provider: "mock", id: "base" };
	readonly api: ExtensionAPI;

	constructor(options: { loadManifest?: (sourcePath: string) => Promise<ParallelWorkflowPlan> } = {}) {
		const self = this;
		this.api = {
			registerCommand(name: string, commandOptions: CommandOptions): void {
				self.commands.set(name, commandOptions.handler);
				if (commandOptions.getArgumentCompletions) {
					self.completions.set(name, commandOptions.getArgumentCompletions);
				}
			},
			logger: { warn(): void {}, debug(): void {}, error(): void {}, info(): void {} },
		} as unknown as ExtensionAPI;
		registerParallelCommand(this.api, {
			createRuntime: (cwd: string): ParallelCommandRuntime => {
				self.createRuntimeCalls.push(cwd);
				return {
					coordinator: self.coordinator,
					listRunIds: () => [...self.runIds],
					setCurrentModelSelector: selector => {
						self.selectorUpdates.push(selector);
					},
				};
			},
			loadManifest: options.loadManifest ?? (async () => makePlan()),
		});
	}

	ctx(): ExtensionCommandContext {
		const self = this;
		return {
			cwd: self.cwd,
			get model() {
				return self.currentModel;
			},
			models: { current: () => self.currentModel },
			ui: {
				notify(message: string, type?: string): void {
					self.notifications.push({ message, type });
				},
			},
		} as unknown as ExtensionCommandContext;
	}

	async command(args: string): Promise<void> {
		await this.commands.get("parallel")?.(args, this.ctx());
	}

	complete(argumentPrefix: string) {
		return this.completions.get("parallel")?.(argumentPrefix) ?? null;
	}

	async settle(predicate: () => boolean): Promise<void> {
		for (let turn = 0; turn < 100; turn += 1) {
			if (predicate()) return;
			await Promise.resolve();
		}
		throw new Error("parallel command did not settle");
	}
}

describe("parallel command parsing", () => {
	it("parses every subcommand with run IDs and order-independent flags", () => {
		expect(parseParallelCommandArgs("plan tasks/manifest.yml")).toEqual({
			action: "plan",
			manifestPath: "tasks/manifest.yml",
			json: false,
		});
		expect(parseParallelCommandArgs("status")).toEqual({ action: "status", runId: undefined, json: false });
		expect(parseParallelCommandArgs("")).toEqual({ action: "status", runId: undefined, json: false });
		expect(parseParallelCommandArgs("status run-1 --json")).toEqual({ action: "status", runId: "run-1", json: true });
		expect(parseParallelCommandArgs("resume run-1")).toEqual({
			action: "resume",
			runId: "run-1",
			wait: false,
			json: false,
		});
		expect(parseParallelCommandArgs("--wait resume --json run-1")).toEqual({
			action: "resume",
			runId: "run-1",
			wait: true,
			json: true,
		});
		expect(parseParallelCommandArgs("review run-2 --wait")).toEqual({
			action: "review",
			runId: "run-2",
			wait: true,
			json: false,
		});
		expect(parseParallelCommandArgs("integrate run-3")).toEqual({
			action: "integrate",
			runId: "run-3",
			wait: false,
			json: false,
		});
		expect(parseParallelCommandArgs("cancel run-4")).toEqual({ action: "cancel", runId: "run-4", json: false });
		expect(parseParallelCommandArgs("PLAN m.yml")).toEqual({ action: "plan", manifestPath: "m.yml", json: false });
	});

	it("treats shell metacharacters as literal tokens, never evaluating them", () => {
		expect(parseParallelCommandArgs("resume $(touch /tmp/pwned)")).toEqual({
			error: "resume requires exactly one run ID",
		});
		expect(parseParallelCommandArgs("resume run-1;id")).toEqual({
			action: "resume",
			runId: "run-1;id",
			wait: false,
			json: false,
		});
		expect(parseParallelCommandArgs("plan `whoami`.yml")).toEqual({
			action: "plan",
			manifestPath: "`whoami`.yml",
			json: false,
		});
	});

	it("rejects malformed invocations with specific errors", () => {
		expect(parseParallelCommandArgs("launch run-1")).toEqual({ error: 'unknown subcommand "launch"' });
		expect(parseParallelCommandArgs("resume run-1 --force")).toEqual({ error: 'unknown flag "--force"' });
		expect(parseParallelCommandArgs("status run-1 --wait")).toEqual({
			error: "--wait is only valid for resume/review/integrate",
		});
		expect(parseParallelCommandArgs("cancel run-1 --wait")).toEqual({
			error: "--wait is only valid for resume/review/integrate",
		});
		expect(parseParallelCommandArgs("plan")).toEqual({ error: "plan requires exactly one manifest path" });
		expect(parseParallelCommandArgs("plan a.yml b.yml")).toEqual({ error: "plan requires exactly one manifest path" });
		expect(parseParallelCommandArgs("status run-1 run-2")).toEqual({ error: "status accepts at most one run ID" });
		expect(parseParallelCommandArgs("resume")).toEqual({ error: "resume requires exactly one run ID" });
		expect(parseParallelCommandArgs("integrate run-1 run-2")).toEqual({
			error: "integrate requires exactly one run ID",
		});
	});
});

describe("parallel command completions", () => {
	it("completes subcommands on the first word", () => {
		const all = parallelArgumentCompletions("", []);
		expect(all?.map(item => item.label)).toEqual(["plan", "status", "resume", "review", "integrate", "cancel"]);
		const re = parallelArgumentCompletions("re", []);
		expect(re?.map(item => item.label)).toEqual(["resume", "review"]);
	});

	it("completes known run IDs for run-scoped subcommands", () => {
		const ids = ["run-alpha", "run-beta", "other"];
		const completions = parallelArgumentCompletions("resume run-", ids);
		expect(completions?.map(item => item.value)).toEqual(["resume run-alpha", "resume run-beta"]);
		expect(parallelArgumentCompletions("status ", ids)?.map(item => item.label)).toEqual(ids);
	});

	it("returns null for manifest paths and completed arguments", () => {
		expect(parallelArgumentCompletions("plan man", ["run-1"])).toBeNull();
		expect(parallelArgumentCompletions("resume run-1 ", ["run-1"])).toBeNull();
		expect(parallelArgumentCompletions("bogus ru", ["run-1"])).toBeNull();
	});
});

describe("parallel command formatting", () => {
	it("formats empty and populated run listings within display caps", () => {
		expect(formatParallelRunSummaries([])).toContain("/parallel plan");
		const many = Array.from({ length: PARALLEL_STATUS_MAX_RUNS + 5 }, (_, index) =>
			makeSummary(`run-${index}`, "planned"),
		);
		const text = formatParallelRunSummaries(many);
		expect(text).toContain(`Parallel runs (${many.length}):`);
		expect(text).toContain("run-0");
		expect(text).toContain(`\u2026and 5 more runs`);
		expect(text).not.toContain(`run-${PARALLEL_STATUS_MAX_RUNS + 1}  `);
	});

	it("formats one run with clipped shard and review detail", () => {
		const longError = "x".repeat(PARALLEL_STATUS_TEXT_MAX_CHARS + 50);
		const stored = makeStored("run-1", "review_pending", {
			plan: makePlan(["core", "api"]),
			lastError: longError,
			shards: [
				{ shardId: "core", status: "approved", branchName: "omp-task/core" },
				{ shardId: "api", status: "failed", error: longError },
			],
			reviews: [{ shardId: "core", agent: "reviewer", status: "approved", summary: "looks good" }],
		});
		const text = formatParallelRunSnapshot(stored);
		expect(text).toContain("Parallel run run-1 (test-run): review_pending");
		expect(text).toContain("shard core: approved [omp-task/core]");
		expect(text).toContain("shard api: failed");
		expect(text).toContain("review core (reviewer): approved \u2014 looks good");
		for (const line of text.split("\n")) {
			expect(line.length).toBeLessThanOrEqual(PARALLEL_STATUS_TEXT_MAX_CHARS + 60);
		}
		expect(text).toContain("\u2026");
	});

	it("emits bounded parseable JSON views", () => {
		const stored = makeStored("run-1", "planned", {
			shards: [{ shardId: "core", status: "pending", error: "e".repeat(500) }],
			reviews: [{ shardId: "core", agent: "reviewer", status: "pending" }],
		});
		const snapshot = JSON.parse(parallelSnapshotToJson(stored));
		expect(snapshot.runId).toBe("run-1");
		expect(snapshot.name).toBe("test-run");
		expect(snapshot.shards[0].error.length).toBe(PARALLEL_STATUS_TEXT_MAX_CHARS);
		expect(snapshot.reviews[0].findingsCount).toBe(0);
		const summaries = JSON.parse(parallelSummariesToJson([makeSummary("run-2", "failed", "boom")]));
		expect(summaries).toEqual([
			{
				runId: "run-2",
				runName: "test-run",
				status: "failed",
				planHash: "hash",
				lastError: "boom",
				createdAt: 1,
				updatedAt: 2,
			},
		]);
	});
});

describe("parallel command handler", () => {
	it("registers the parallel command with completions", () => {
		const harness = new CommandHarness();
		expect(harness.commands.has("parallel")).toBe(true);
		expect(harness.completions.has("parallel")).toBe(true);
	});

	it("warns with usage on malformed input instead of throwing", async () => {
		const harness = new CommandHarness();
		await harness.command("resume");
		expect(harness.notifications).toHaveLength(1);
		expect(harness.notifications[0].type).toBe("warning");
		expect(harness.notifications[0].message).toContain("resume requires exactly one run ID");
		expect(harness.notifications[0].message).toContain(PARALLEL_COMMAND_USAGE);
		expect(harness.createRuntimeCalls).toHaveLength(0);
	});

	it("plans a manifest resolved against the command cwd", async () => {
		const loadedPaths: string[] = [];
		const harness = new CommandHarness({
			loadManifest: async sourcePath => {
				loadedPaths.push(sourcePath);
				return makePlan(["core", "api"]);
			},
		});
		harness.coordinator.createRunResult = makeStored("run-new", "planned", { plan: makePlan(["core", "api"]) });
		await harness.command("plan tasks/manifest.yml");
		expect(loadedPaths).toEqual(["/project/tasks/manifest.yml"]);
		expect(harness.coordinator.calls).toEqual([{ method: "createRun" }]);
		expect(harness.coordinator.lastCreatedPlan?.shards).toHaveLength(2);
		expect(harness.notifications).toEqual([
			{
				message:
					'Parallel run run-new created from "test-run" (2 shards, status planned). ' +
					"Start it with /parallel resume run-new.",
				type: "info",
			},
		]);
	});

	it("reports manifest and preflight failures as warnings, never uncaught", async () => {
		const harness = new CommandHarness({
			loadManifest: async () => {
				throw new Error("Invalid parallel workflow manifest (m.yml): shards must declare at least one shard");
			},
		});
		await harness.command("plan m.yml");
		expect(harness.notifications).toHaveLength(1);
		expect(harness.notifications[0].type).toBe("warning");
		expect(harness.notifications[0].message).toContain("Parallel workflows:");
		expect(harness.notifications[0].message).toContain("shards must declare at least one shard");

		harness.coordinator.createRunResult = new Error("Parallel coordinator: preflight failed: missing agent");
		const okManifest = new CommandHarness();
		okManifest.coordinator.createRunResult = new Error("Parallel coordinator: preflight failed: missing agent");
		await okManifest.command("plan m.yml");
		expect(okManifest.notifications[0].type).toBe("warning");
		expect(okManifest.notifications[0].message).toContain("preflight failed");
	});

	it("shows the bounded run listing and one-run detail via status", async () => {
		const harness = new CommandHarness();
		harness.coordinator.statusResult = [makeSummary("run-1", "planned"), makeSummary("run-2", "failed", "boom")];
		await harness.command("status");
		expect(harness.coordinator.calls).toEqual([{ method: "status", runId: undefined }]);
		expect(harness.notifications[0].type).toBe("info");
		expect(harness.notifications[0].message).toContain("run-1");
		expect(harness.notifications[0].message).toContain("run-2");

		harness.coordinator.statusResult = makeStored("run-2", "failed", { lastError: "merge conflict" });
		await harness.command("status run-2 --json");
		expect(harness.coordinator.calls.at(-1)).toEqual({ method: "status", runId: "run-2" });
		const last = harness.notifications.at(-1);
		expect(last?.type).toBe("warning");
		expect(JSON.parse(last?.message ?? "").lastError).toBe("merge conflict");
	});

	it("returns control promptly on resume and notifies on background settlement", async () => {
		const harness = new CommandHarness();
		const gate = deferred();
		harness.coordinator.operationResults = [gate.promise];
		await harness.command("resume run-1");
		expect(harness.coordinator.calls).toEqual([{ method: "resume", runId: "run-1" }]);
		expect(harness.notifications).toHaveLength(1);
		expect(harness.notifications[0].message).toContain("Parallel resume started for run-1");
		expect(harness.notifications[0].type).toBe("info");

		gate.resolve(makeStored("run-1", "ready_to_integrate"));
		await harness.settle(() => harness.notifications.length === 2);
		expect(harness.notifications[1].type).toBe("info");
		expect(harness.notifications[1].message).toContain("Parallel run run-1 (test-run): ready_to_integrate");
	});

	it("surfaces detached operation failures as warnings", async () => {
		const harness = new CommandHarness();
		const gate = deferred();
		harness.coordinator.operationResults = [gate.promise];
		await harness.command("integrate run-9");
		expect(harness.notifications).toHaveLength(1);
		gate.reject(new Error('Parallel coordinator: unknown run "run-9"'));
		await harness.settle(() => harness.notifications.length === 2);
		expect(harness.notifications[1].type).toBe("warning");
		expect(harness.notifications[1].message).toContain("Parallel integrate for run-9 failed");
		expect(harness.notifications[1].message).toContain('unknown run "run-9"');
	});

	it("blocks until settlement when --wait is supplied", async () => {
		const harness = new CommandHarness();
		harness.coordinator.operationResults = [Promise.resolve(makeStored("run-1", "failed", { lastError: "boom" }))];
		await harness.command("review run-1 --wait");
		expect(harness.coordinator.calls).toEqual([{ method: "review", runId: "run-1" }]);
		expect(harness.notifications).toHaveLength(1);
		expect(harness.notifications[0].type).toBe("warning");
		expect(harness.notifications[0].message).toContain("Parallel run run-1 (test-run): failed");
		expect(harness.notifications[0].message).toContain("boom");
	});

	it("cancels synchronously with a bounded confirmation", async () => {
		const harness = new CommandHarness();
		harness.coordinator.cancelResult = makeStored("run-1", "cancelled");
		await harness.command("cancel run-1");
		expect(harness.coordinator.calls).toEqual([{ method: "cancel", runId: "run-1" }]);
		expect(harness.notifications).toEqual([
			{ message: "Parallel run run-1 cancelled (status cancelled).", type: "info" },
		]);
	});

	it("caches one runtime per cwd and refreshes the routed model selector", async () => {
		const harness = new CommandHarness();
		harness.coordinator.statusResult = [];
		await harness.command("status");
		await harness.command("status");
		expect(harness.createRuntimeCalls).toEqual(["/project"]);
		expect(harness.selectorUpdates).toEqual(["mock/base", "mock/base"]);

		harness.cwd = "/elsewhere";
		harness.currentModel = { provider: "mock", id: "slow" };
		await harness.command("status");
		expect(harness.createRuntimeCalls).toEqual(["/project", "/elsewhere"]);
		expect(harness.selectorUpdates.at(-1)).toBe("mock/slow");

		harness.currentModel = undefined;
		await harness.command("status");
		expect(harness.selectorUpdates.at(-1)).toBeUndefined();
	});

	it("feeds known run IDs from used runtimes into completions", async () => {
		const harness = new CommandHarness();
		harness.runIds = ["run-alpha", "run-beta"];
		expect(harness.complete("resume run-")).toEqual([]);
		harness.coordinator.statusResult = [];
		await harness.command("status");
		expect(harness.complete("resume run-")?.map(item => item.value)).toEqual([
			"resume run-alpha",
			"resume run-beta",
		]);
	});
});

describe("parallel command extension wiring", () => {
	it("registers /parallel alongside /route without new event handlers", async () => {
		const commands = new Map<string, CommandOptions["handler"]>();
		const handlers: string[] = [];
		const coordinator = new FakeCoordinator();
		const notifications: Array<{ message: string; type: string | undefined }> = [];
		const api = {
			on(event: string): void {
				handlers.push(event);
			},
			registerCommand(name: string, options: CommandOptions): void {
				commands.set(name, options.handler);
			},
			registerMessageRenderer(): void {},
			appendEntry(): void {},
			async setModel(): Promise<boolean> {
				return true;
			},
			setThinkingLevel(): void {},
			sendMessage(): void {},
			sendUserMessage(): void {},
			logger: { warn(): void {}, debug(): void {}, error(): void {}, info(): void {} },
		} as unknown as ExtensionAPI;
		createModelRouterExtension({
			loadConfig: async () => {
				throw new Error("config load unused in this test");
			},
			classify: async () => "low",
			parallel: {
				createRuntime: () => ({
					coordinator,
					listRunIds: () => [],
					setCurrentModelSelector: () => {},
				}),
			},
		})(api);
		expect(commands.has("route")).toBe(true);
		expect(commands.has("parallel")).toBe(true);
		expect(handlers.sort()).toEqual([
			"agent_end",
			"input",
			"message_end",
			"session_branch",
			"session_shutdown",
			"session_start",
			"session_switch",
			"session_tree",
		]);

		coordinator.statusResult = [makeSummary("run-1", "planned")];
		const ctx = {
			cwd: "/project",
			model: undefined,
			models: { current: () => undefined },
			ui: {
				notify(message: string, type?: string): void {
					notifications.push({ message, type });
				},
			},
		} as unknown as ExtensionCommandContext;
		await commands.get("parallel")?.("status", ctx);
		expect(coordinator.calls).toEqual([{ method: "status", runId: undefined }]);
		expect(notifications[0].message).toContain("run-1");
	});
});
