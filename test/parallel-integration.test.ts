import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { createModelRouterExtension } from "../src/extension";
import type { ParallelCommandCoordinator } from "../src/parallel/commands";
import type { ParallelRunStatus, ParallelWorkflowPlan } from "../src/parallel/contracts";
import type { ParallelRunSnapshot } from "../src/parallel/coordinator";
import type { ParallelRunSummary, ParallelStoredRun } from "../src/parallel/storage";

const RUN_ID = "run-integration";

const MANIFEST_YAML = [
	"run: integration-run",
	"maxConcurrency: 2",
	"contracts:",
	"  - id: core-v1",
	"    description: Core module contract.",
	"    owner: core",
	"shards:",
	"  - id: core",
	"    kind: implementation",
	"    agent: task",
	"    prompt: Implement the core shard.",
	"    owns: [src/core.ts]",
	"    produces: [core-v1]",
	"    requires: []",
	"    dependsOn: []",
	"  - id: api",
	"    kind: implementation",
	"    agent: task",
	"    prompt: Implement the api shard.",
	"    owns: [src/api.ts]",
	"    produces: []",
	"    requires: [core-v1]",
	"    dependsOn: [core]",
	"",
].join("\n");

/**
 * Fake coordinator holding one run as a tiny state machine so the registered
 * command's plan -> resume -> review -> integrate sequence is observable as
 * ordered status transitions, without live credentials or subprocesses.
 */
class LifecycleFakeCoordinator implements ParallelCommandCoordinator {
	plan: ParallelWorkflowPlan | undefined;
	status_: ParallelRunStatus = "planned";
	readonly transitions: ParallelRunStatus[] = [];
	readonly calls: Array<{ method: string; runId?: string }> = [];

	private advance(status: ParallelRunStatus): ParallelRunSnapshot {
		this.status_ = status;
		this.transitions.push(status);
		return this.snapshot();
	}

	private snapshot(): ParallelStoredRun {
		const plan = this.plan;
		if (plan === undefined) throw new Error("no run planned");
		return {
			run: {
				runId: RUN_ID,
				cwd: "/project",
				repoRoot: "/project",
				planHash: plan.planHash,
				plan,
				baseSha: null,
				status: this.status_,
				lastError: null,
				createdAt: 1,
				updatedAt: 2,
			},
			shards: plan.shards.map(shard => ({
				runId: RUN_ID,
				shardId: shard.id,
				status: this.status_ === "planned" ? "pending" : "completed",
				branchName: this.status_ === "planned" ? null : `omp-task/${shard.id}`,
				baseSha: null,
				outputExcerpt: null,
				error: null,
				createdAt: 1,
				updatedAt: 2,
			})),
			reviews: [],
		};
	}

	async createRun(plan: ParallelWorkflowPlan): Promise<ParallelRunSnapshot> {
		this.calls.push({ method: "createRun" });
		this.plan = plan;
		return this.advance("planned");
	}
	async resume(runId: string): Promise<ParallelRunSnapshot> {
		this.calls.push({ method: "resume", runId });
		return this.advance("review_pending");
	}
	async review(runId: string): Promise<ParallelRunSnapshot> {
		this.calls.push({ method: "review", runId });
		return this.advance("ready_to_integrate");
	}
	async integrate(runId: string): Promise<ParallelRunSnapshot> {
		this.calls.push({ method: "integrate", runId });
		return this.advance("integrated");
	}
	async cancel(runId: string): Promise<ParallelRunSnapshot> {
		this.calls.push({ method: "cancel", runId });
		return this.advance("cancelled");
	}
	async status(runId?: string): Promise<ParallelRunSnapshot | readonly ParallelRunSummary[]> {
		this.calls.push({ method: "status", runId });
		if (runId === undefined) {
			const summary: ParallelRunSummary = {
				runId: RUN_ID,
				runName: this.plan?.run ?? "unknown",
				status: this.status_,
				planHash: this.plan?.planHash ?? "hash",
				lastError: null,
				createdAt: 1,
				updatedAt: 2,
			};
			return this.plan === undefined ? [] : [summary];
		}
		return this.snapshot();
	}
	async wait(runId: string): Promise<ParallelRunSnapshot> {
		this.calls.push({ method: "wait", runId });
		return this.snapshot();
	}
}

describe("parallel workflow lifecycle through the registered command", () => {
	let projectDir: string;
	let coordinator: LifecycleFakeCoordinator;
	let notifications: Array<{ message: string; type: string | undefined }>;
	let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void> | void) | undefined;

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "parallel-integration-"));
		await fs.writeFile(path.join(projectDir, "manifest.yml"), MANIFEST_YAML, "utf8");
		coordinator = new LifecycleFakeCoordinator();
		notifications = [];

		const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void> | void>();
		const api = {
			on(): void {},
			registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void }): void {
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
		// No loadManifest override: the default on-disk YAML loader must run.
		createModelRouterExtension({
			loadConfig: async () => {
				throw new Error("config load unused in this test");
			},
			classify: async () => "low",
			parallel: {
				createRuntime: () => ({
					coordinator,
					listRunIds: () => (coordinator.plan === undefined ? [] : [RUN_ID]),
					setCurrentModelSelector: () => {},
				}),
			},
		})(api);
		command = commands.get("parallel");
	});

	afterEach(async () => {
		await fs.rm(projectDir, { recursive: true, force: true });
	});

	function ctx(): ExtensionCommandContext {
		return {
			cwd: projectDir,
			model: undefined,
			models: { current: () => ({ provider: "mock", id: "base" }) },
			ui: {
				notify(message: string, type?: string): void {
					notifications.push({ message, type });
				},
			},
		} as unknown as ExtensionCommandContext;
	}

	it("drives plan -> resume -> review -> integrate from a temporary manifest file", async () => {
		expect(command).toBeDefined();

		await command?.("plan manifest.yml", ctx());
		const plan = coordinator.plan;
		expect(plan?.run).toBe("integration-run");
		expect(plan?.sourcePath).toBe(path.join(projectDir, "manifest.yml"));
		expect(plan?.planHash).toMatch(/^[0-9a-f]{64}$/);
		expect(plan?.shards.map(shard => shard.id)).toEqual(["core", "api"]);
		expect(notifications).toEqual([
			{
				message:
					`Parallel run ${RUN_ID} created from "integration-run" (2 shards, status planned). ` +
					`Start it with /parallel resume ${RUN_ID}.`,
				type: "info",
			},
		]);

		await command?.(`resume ${RUN_ID} --wait`, ctx());
		expect(notifications.at(-1)?.type).toBe("info");
		expect(notifications.at(-1)?.message).toContain(`Parallel run ${RUN_ID} (integration-run): review_pending`);

		await command?.(`review ${RUN_ID} --wait`, ctx());
		expect(notifications.at(-1)?.message).toContain("ready_to_integrate");

		await command?.(`integrate ${RUN_ID} --wait`, ctx());
		expect(notifications.at(-1)?.message).toContain(`Parallel run ${RUN_ID} (integration-run): integrated`);
		expect(notifications.at(-1)?.message).toContain("shard core: completed [omp-task/core]");

		expect(coordinator.transitions).toEqual(["planned", "review_pending", "ready_to_integrate", "integrated"]);
		expect(coordinator.calls.map(call => call.method)).toEqual(["createRun", "resume", "review", "integrate"]);
		expect(coordinator.calls.slice(1).every(call => call.runId === RUN_ID)).toBe(true);

		await command?.(`status ${RUN_ID}`, ctx());
		expect(notifications.at(-1)?.type).toBe("info");
		expect(notifications.at(-1)?.message).toContain(`Parallel run ${RUN_ID} (integration-run): integrated`);
	});

	it("surfaces a manifest that fails validation as a warning without reaching the coordinator", async () => {
		await fs.writeFile(path.join(projectDir, "broken.yml"), "run: broken\nshards: []\n", "utf8");
		await command?.("plan broken.yml", ctx());
		expect(notifications).toHaveLength(1);
		expect(notifications[0].type).toBe("warning");
		expect(notifications[0].message).toContain("Invalid parallel workflow manifest");
		expect(coordinator.calls).toEqual([]);
	});
});
