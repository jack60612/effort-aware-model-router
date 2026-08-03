import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ParallelWorkflowPlan, validateParallelWorkflowManifest } from "../src/parallel/index";
import {
	PARALLEL_STORE_BUSY_TIMEOUT_MS,
	PARALLEL_STORE_ERROR_MAX_CHARS,
	PARALLEL_STORE_FINDING_MESSAGE_MAX_CHARS,
	PARALLEL_STORE_FINDINGS_MAX,
	PARALLEL_STORE_OUTPUT_MAX_CHARS,
	PARALLEL_STORE_PROJECT_KEY_CHARS,
	PARALLEL_STORE_SCHEMA_VERSION,
	PARALLEL_STORE_SUMMARY_MAX_CHARS,
	ParallelWorkflowStore,
	parallelProjectKey,
} from "../src/parallel/storage";

const SOURCE = "manifest.yml";

function makePlan(run = "cache-aware-delegation"): ParallelWorkflowPlan {
	return validateParallelWorkflowManifest(
		{
			run,
			model: "@smol",
			maxConcurrency: 4,
			contracts: [
				{
					id: "delegation-config-v1",
					description: "Validated delegation configuration and defaults.",
					owner: "delegation-config",
				},
			],
			shards: [
				{
					id: "delegation-config",
					kind: "implementation",
					agent: "task",
					prompt: "Implement and test the delegation configuration contract.",
					owns: ["src/config.ts", "test/config.test.ts"],
					produces: ["delegation-config-v1"],
					requires: [],
					dependsOn: [],
					review: { agent: "reviewer", required: true },
				},
				{
					id: "consumer",
					kind: "implementation",
					agent: "task",
					prompt: "Consume the delegation configuration contract.",
					owns: ["src/consumer.ts"],
					produces: [],
					requires: ["delegation-config-v1"],
					dependsOn: ["delegation-config"],
				},
			],
		},
		SOURCE,
	);
}

let tmpRoot: string;
let projectDir: string;
let stateDir: string;
let stores: ParallelWorkflowStore[];

function openStore(
	options: { now?: () => number; ownerPid?: number; isProcessAlive?: (pid: number) => boolean } = {},
): ParallelWorkflowStore {
	const store = ParallelWorkflowStore.openForCwd(projectDir, { stateDir, ...options });
	stores.push(store);
	return store;
}

beforeEach(async () => {
	tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "parallel-storage-"));
	projectDir = path.join(tmpRoot, "project");
	stateDir = path.join(tmpRoot, "state");
	await fs.mkdir(path.join(projectDir, ".git"), { recursive: true });
	stores = [];
});

afterEach(async () => {
	for (const store of stores) {
		try {
			store.close();
		} catch {
			// Already closed by the test body.
		}
	}
	await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("openForCwd", () => {
	it("configures WAL, synchronous NORMAL, foreign keys, busy timeout, and the schema version", () => {
		const store = openStore();
		const settings = store.connectionSettings();
		expect(settings.journalMode).toBe("wal");
		expect(settings.synchronous).toBe(1);
		expect(settings.foreignKeys).toBe(1);
		expect(settings.busyTimeoutMs).toBe(PARALLEL_STORE_BUSY_TIMEOUT_MS);
		expect(settings.userVersion).toBe(PARALLEL_STORE_SCHEMA_VERSION);
	});

	it("derives a stable hash filename that never leaks the raw project path", () => {
		const store = openStore();
		const filename = path.basename(store.databasePath);
		expect(filename).toMatch(new RegExp(`^[0-9a-f]{${PARALLEL_STORE_PROJECT_KEY_CHARS}}\\.sqlite$`));
		expect(filename).toBe(`${parallelProjectKey(store.repoRoot)}.sqlite`);
		expect(store.databasePath.startsWith(stateDir)).toBe(true);
		expect(filename.includes(path.basename(projectDir))).toBe(false);
		store.close();

		const reopened = openStore();
		expect(reopened.databasePath).toBe(store.databasePath);
	});

	it("resolves the repository root from a nested working directory", async () => {
		const nested = path.join(projectDir, "packages", "app");
		await fs.mkdir(nested, { recursive: true });
		const fromRoot = openStore();
		fromRoot.close();
		const fromNested = ParallelWorkflowStore.openForCwd(nested, { stateDir });
		stores.push(fromNested);
		expect(fromNested.repoRoot).toBe(fromRoot.repoRoot);
		expect(fromNested.databasePath).toBe(fromRoot.databasePath);
	});

	it("resolves the XDG state directory from an injected environment", async () => {
		const xdgHome = path.join(tmpRoot, "xdg-state");
		const store = ParallelWorkflowStore.openForCwd(projectDir, { env: { XDG_STATE_HOME: xdgHome } });
		stores.push(store);
		expect(store.databasePath.startsWith(path.join(xdgHome, "omp", "parallel"))).toBe(true);
	});

	it("rejects a database with an unknown schema version", () => {
		const store = openStore();
		const databasePath = store.databasePath;
		store.close();
		const raw = new Database(databasePath);
		raw.exec("PRAGMA user_version = 99");
		raw.close();
		expect(() => ParallelWorkflowStore.openForCwd(projectDir, { stateDir })).toThrow(/unknown schema version 99/);
	});
});

describe("run round trips", () => {
	it("creates a run with pending shards and declared pending reviews", () => {
		const store = openStore({ now: () => 1_000 });
		const plan = makePlan();
		const stored = store.createRun({ runId: "run-1", plan, baseSha: "abc123" });

		expect(stored.run.runId).toBe("run-1");
		expect(stored.run.status).toBe("planned");
		expect(stored.run.cwd).toBe(store.cwd);
		expect(stored.run.repoRoot).toBe(store.repoRoot);
		expect(stored.run.baseSha).toBe("abc123");
		expect(stored.run.lastError).toBeNull();
		expect(stored.run.createdAt).toBe(1_000);
		expect(stored.run.updatedAt).toBe(1_000);

		expect(stored.shards.map(shard => shard.shardId)).toEqual(["delegation-config", "consumer"]);
		for (const shard of stored.shards) {
			expect(shard.status).toBe("pending");
			expect(shard.branchName).toBeNull();
			expect(shard.baseSha).toBeNull();
			expect(shard.outputExcerpt).toBeNull();
			expect(shard.error).toBeNull();
		}

		expect(stored.reviews).toHaveLength(1);
		expect(stored.reviews[0]?.shardId).toBe("delegation-config");
		expect(stored.reviews[0]?.agent).toBe("reviewer");
		expect(stored.reviews[0]?.status).toBe("pending");
		expect(stored.reviews[0]?.findings).toEqual([]);
	});

	it("round-trips run, shard, and review updates", () => {
		let clock = 1_000;
		const store = openStore({ now: () => clock });
		store.createRun({ runId: "run-1", plan: makePlan() });

		clock = 2_000;
		store.updateRun("run-1", { status: "running", baseSha: "deadbeef" });
		store.updateShard("run-1", "delegation-config", {
			status: "review_pending",
			branchName: "task/delegation-config",
			baseSha: "deadbeef",
			outputExcerpt: "implemented config contract",
		});
		store.updateReview("run-1", "delegation-config", {
			status: "rejected",
			summary: "Found one blocking issue.",
			findings: [{ path: "src/config.ts", line: 12, message: "Missing bound check." }],
			error: null,
		});

		const stored = store.getRun("run-1");
		expect(stored).not.toBeNull();
		expect(stored?.run.status).toBe("running");
		expect(stored?.run.baseSha).toBe("deadbeef");
		expect(stored?.run.updatedAt).toBe(2_000);

		const shard = stored?.shards.find(entry => entry.shardId === "delegation-config");
		expect(shard?.status).toBe("review_pending");
		expect(shard?.branchName).toBe("task/delegation-config");
		expect(shard?.baseSha).toBe("deadbeef");
		expect(shard?.outputExcerpt).toBe("implemented config contract");
		expect(shard?.updatedAt).toBe(2_000);

		const review = stored?.reviews[0];
		expect(review?.status).toBe("rejected");
		expect(review?.summary).toBe("Found one blocking issue.");
		expect(review?.findings).toEqual([{ path: "src/config.ts", line: 12, message: "Missing bound check." }]);
		expect(review?.error).toBeNull();
	});

	it("persists across close and reopen", () => {
		const store = openStore();
		store.createRun({ runId: "run-1", plan: makePlan() });
		store.updateRun("run-1", { status: "failed", lastError: "shard exploded" });
		store.close();

		const reopened = openStore();
		const stored = reopened.getRun("run-1");
		expect(stored?.run.status).toBe("failed");
		expect(stored?.run.lastError).toBe("shard exploded");
		expect(stored?.shards).toHaveLength(2);
	});

	it("lists runs newest first with bounded summaries", () => {
		let clock = 1_000;
		const store = openStore({ now: () => clock });
		store.createRun({ runId: "run-old", plan: makePlan("older-run") });
		clock = 2_000;
		store.createRun({ runId: "run-new", plan: makePlan("newer-run") });

		const runs = store.listRuns();
		expect(runs.map(run => run.runId)).toEqual(["run-new", "run-old"]);
		expect(runs[0]?.runName).toBe("newer-run");
		expect(runs[1]?.runName).toBe("older-run");
		expect(runs[0]?.status).toBe("planned");
	});

	it("returns null for unknown runs and throws for unknown update targets", () => {
		const store = openStore();
		expect(store.getRun("missing")).toBeNull();
		expect(() => store.updateRun("missing", { status: "running" })).toThrow(/not found/);
		expect(() => store.updateShard("missing", "delegation-config", { status: "running" })).toThrow(/not found/);
		expect(() => store.updateReview("missing", "delegation-config", { status: "running" })).toThrow(/not found/);
	});

	it("rejects duplicate run IDs, blank run IDs, and empty patches", () => {
		const store = openStore();
		const plan = makePlan();
		store.createRun({ runId: "run-1", plan });
		expect(() => store.createRun({ runId: "run-1", plan })).toThrow(/already exists/);
		expect(() => store.createRun({ runId: "   ", plan })).toThrow(/must not be blank/);
		expect(() => store.updateRun("run-1", {})).toThrow(/empty patch/);
	});

	it("rejects updates to shards without a declared review row", () => {
		const store = openStore();
		store.createRun({ runId: "run-1", plan: makePlan() });
		expect(() => store.updateReview("run-1", "consumer", { status: "approved" })).toThrow(/not found/);
	});
});

describe("plan immutability", () => {
	it("retains the exact plan hash and normalized plan across storage", () => {
		const store = openStore();
		const plan = makePlan();
		const stored = store.createRun({ runId: "run-1", plan });

		expect(stored.run.planHash).toBe(plan.planHash);
		expect(stored.run.plan.planHash).toBe(plan.planHash);
		expect(stored.run.plan.run).toBe(plan.run);
		expect(stored.run.plan.shards.map(shard => shard.id)).toEqual(plan.shards.map(shard => shard.id));
		expect(Object.isFrozen(stored.run.plan)).toBe(true);
		expect(Object.isFrozen(stored.run.plan.shards)).toBe(true);
	});

	it("rejects a plan whose hash does not match its canonical content", () => {
		const store = openStore();
		const plan = makePlan();
		const tampered = { ...plan, planHash: "0".repeat(64) } as ParallelWorkflowPlan;
		expect(() => store.createRun({ runId: "run-1", plan: tampered })).toThrow(/plan hash mismatch/);
	});

	it("provides no update path for plan JSON or plan hash", () => {
		const store = openStore();
		const plan = makePlan();
		store.createRun({ runId: "run-1", plan });
		store.updateRun("run-1", { status: "integrated", baseSha: "ffff", lastError: null });
		const stored = store.getRun("run-1");
		expect(stored?.run.planHash).toBe(plan.planHash);
		expect(stored?.run.plan.run).toBe(plan.run);
	});

	it("fails closed when the stored plan row was tampered with", () => {
		const store = openStore();
		store.createRun({ runId: "run-1", plan: makePlan() });
		const databasePath = store.databasePath;
		store.close();

		const raw = new Database(databasePath);
		raw.exec("UPDATE workflow_runs SET plan_json = 'not json' WHERE run_id = 'run-1'");
		raw.close();

		const reopened = openStore();
		expect(() => reopened.getRun("run-1")).toThrow(/corrupt plan JSON/);
	});
});

describe("bounded and defensive values", () => {
	it("caps output excerpts, summaries, and errors", () => {
		const store = openStore();
		store.createRun({ runId: "run-1", plan: makePlan() });
		store.updateShard("run-1", "delegation-config", {
			outputExcerpt: "x".repeat(PARALLEL_STORE_OUTPUT_MAX_CHARS * 2),
			error: "e".repeat(PARALLEL_STORE_ERROR_MAX_CHARS * 2),
		});
		store.updateReview("run-1", "delegation-config", {
			summary: "s".repeat(PARALLEL_STORE_SUMMARY_MAX_CHARS * 2),
		});
		store.updateRun("run-1", { lastError: "r".repeat(PARALLEL_STORE_ERROR_MAX_CHARS * 2) });

		const stored = store.getRun("run-1");
		const shard = stored?.shards.find(entry => entry.shardId === "delegation-config");
		expect(shard?.outputExcerpt?.length).toBe(PARALLEL_STORE_OUTPUT_MAX_CHARS);
		expect(shard?.error?.length).toBe(PARALLEL_STORE_ERROR_MAX_CHARS);
		expect(stored?.reviews[0]?.summary?.length).toBe(PARALLEL_STORE_SUMMARY_MAX_CHARS);
		expect(stored?.run.lastError?.length).toBe(PARALLEL_STORE_ERROR_MAX_CHARS);
	});

	it("caps finding counts and lengths and drops malformed findings", () => {
		const store = openStore();
		store.createRun({ runId: "run-1", plan: makePlan() });
		const oversized = Array.from({ length: PARALLEL_STORE_FINDINGS_MAX + 50 }, (_, index) => ({
			path: `src/file-${index}.ts`,
			message: "m".repeat(PARALLEL_STORE_FINDING_MESSAGE_MAX_CHARS * 2),
		}));
		const malformed = [
			null,
			42,
			"finding",
			{ path: "src/a.ts" },
			{ message: "no path" },
			{ path: "", message: "blank path" },
			{ path: "src/b.ts", message: "ok", line: -3 },
			{ path: "src/c.ts", message: "ok", line: 1.5 },
		] as unknown as { path: string; message: string }[];
		store.updateReview("run-1", "delegation-config", { findings: [...malformed, ...oversized] });

		const findings = store.getRun("run-1")?.reviews[0]?.findings ?? [];
		expect(findings.length).toBe(PARALLEL_STORE_FINDINGS_MAX);
		for (const finding of findings) {
			expect(finding.message.length).toBeLessThanOrEqual(PARALLEL_STORE_FINDING_MESSAGE_MAX_CHARS);
		}
		expect(findings.some(finding => finding.line !== undefined && finding.line < 1)).toBe(false);
		expect(findings.filter(finding => finding.path === "src/b.ts")).toEqual([{ path: "src/b.ts", message: "ok" }]);
	});

	it("returns empty findings when stored findings JSON is corrupt", () => {
		const store = openStore();
		store.createRun({ runId: "run-1", plan: makePlan() });
		const databasePath = store.databasePath;
		store.close();

		const raw = new Database(databasePath);
		raw.exec("UPDATE workflow_reviews SET findings_json = '{broken' WHERE run_id = 'run-1'");
		raw.close();

		const reopened = openStore();
		expect(reopened.getRun("run-1")?.reviews[0]?.findings).toEqual([]);
	});

	it("rejects unknown status values on update and on read", () => {
		const store = openStore();
		store.createRun({ runId: "run-1", plan: makePlan() });
		expect(() => store.updateRun("run-1", { status: "exploded" as never })).toThrow(/unknown status/);
		expect(() => store.updateShard("run-1", "consumer", { status: "exploded" as never })).toThrow(/unknown status/);

		const databasePath = store.databasePath;
		store.close();
		const raw = new Database(databasePath);
		raw.exec("UPDATE workflow_runs SET status = 'garbage' WHERE run_id = 'run-1'");
		raw.close();

		const reopened = openStore();
		expect(() => reopened.getRun("run-1")).toThrow(/unknown status/);
	});
});

describe("run ownership leases", () => {
	it("opening the store never mutates running rows", () => {
		const store = openStore();
		store.createRun({ runId: "run-1", plan: makePlan() });
		store.updateRun("run-1", { status: "running" });
		store.updateShard("run-1", "delegation-config", {
			status: "running",
			branchName: "task/delegation-config",
			baseSha: "deadbeef",
			outputExcerpt: "partial output",
		});
		store.updateReview("run-1", "delegation-config", { status: "running" });
		store.close();

		// A status/read-only open leaves every mid-flight row untouched.
		const reopened = openStore();
		const stored = reopened.getRun("run-1");
		expect(stored?.run.status).toBe("running");
		const shard = stored?.shards.find(entry => entry.shardId === "delegation-config");
		expect(shard?.status).toBe("running");
		expect(shard?.branchName).toBe("task/delegation-config");
		expect(stored?.reviews[0]?.status).toBe("running");
	});

	it("claims an idle run reentrantly and releases only for the current owner", () => {
		const first = openStore({ isProcessAlive: () => true });
		first.createRun({ runId: "run-1", plan: makePlan() });
		first.claimRun("run-1");
		first.claimRun("run-1");
		expect(first.runOwnership("run-1")?.ownerToken).toBe(first.ownerToken);

		const second = openStore({ isProcessAlive: () => true });
		expect(() => second.claimRun("run-1")).toThrow(/claimed by live process/);
		// A non-owner release is a no-op; the lease survives.
		second.releaseRun("run-1");
		expect(first.runOwnership("run-1")?.ownerToken).toBe(first.ownerToken);

		first.releaseRun("run-1");
		expect(first.runOwnership("run-1")?.ownerToken).toBeNull();
		second.claimRun("run-1");
		expect(second.runOwnership("run-1")?.ownerToken).toBe(second.ownerToken);
	});

	it("claimRun throws for unknown runs", () => {
		const store = openStore();
		expect(() => store.claimRun("missing")).toThrow(/not found/);
	});

	it("takeover from a dead owner marks only that run's mid-flight rows interrupted", () => {
		const dying = openStore({ ownerPid: 424_242 });
		for (const [runId, name] of [
			["run-1", "first-run"],
			["run-2", "second-run"],
		] as const) {
			dying.createRun({ runId, plan: makePlan(name) });
			dying.claimRun(runId);
			dying.updateRun(runId, { status: "running" });
			dying.updateShard(runId, "delegation-config", {
				status: "running",
				branchName: "task/keep",
				baseSha: "deadbeef",
				outputExcerpt: "partial output",
			});
			dying.updateReview(runId, "delegation-config", {
				status: "running",
				findings: [{ path: "src/config.ts", message: "in flight" }],
			});
		}
		dying.close();

		const survivor = openStore({ isProcessAlive: () => false });
		survivor.claimRun("run-1");

		const taken = survivor.getRun("run-1");
		expect(taken?.run.status).toBe("interrupted");
		const shard = taken?.shards.find(entry => entry.shardId === "delegation-config");
		expect(shard?.status).toBe("interrupted");
		// Branch artifacts survive takeover untouched so `resume` can requeue.
		expect(shard?.branchName).toBe("task/keep");
		expect(shard?.baseSha).toBe("deadbeef");
		expect(shard?.outputExcerpt).toBe("partial output");
		expect(taken?.reviews[0]?.status).toBe("interrupted");
		expect(taken?.reviews[0]?.findings).toEqual([{ path: "src/config.ts", message: "in flight" }]);
		expect(survivor.runOwnership("run-1")?.ownerToken).toBe(survivor.ownerToken);

		// The sibling run keeps its rows and its dead owner's lease.
		const untouched = survivor.getRun("run-2");
		expect(untouched?.run.status).toBe("running");
		expect(untouched?.shards.find(entry => entry.shardId === "delegation-config")?.status).toBe("running");
		expect(untouched?.reviews[0]?.status).toBe("running");
		expect(survivor.runOwnership("run-2")?.ownerPid).toBe(424_242);
	});

	it("a fresh claim recovers unowned stale running and integrating rows", () => {
		// Legacy shape: rows left running/integrating with no owner recorded
		// (schema-v1 crash). A live driver would hold the lease, so a fresh
		// claim treats them as abandoned and recovers them.
		const before = openStore();
		before.createRun({ runId: "run-1", plan: makePlan() });
		before.updateRun("run-1", { status: "integrating" });
		before.updateShard("run-1", "delegation-config", { status: "running" });
		before.close();

		const store = openStore({ isProcessAlive: () => true });
		store.claimRun("run-1");
		const stored = store.getRun("run-1");
		expect(stored?.run.status).toBe("interrupted");
		expect(stored?.shards.find(entry => entry.shardId === "delegation-config")?.status).toBe("interrupted");
	});
});

describe("schema migration", () => {
	it("upgrades a version-1 database in place and preserves existing rows", async () => {
		await fs.mkdir(stateDir, { recursive: true });
		const databasePath = path.join(stateDir, `${parallelProjectKey(path.resolve(projectDir))}.sqlite`);
		const raw = new Database(databasePath, { create: true });
		raw.exec(
			`CREATE TABLE workflow_runs (
				run_id TEXT PRIMARY KEY,
				cwd TEXT NOT NULL,
				repo_root TEXT NOT NULL,
				plan_hash TEXT NOT NULL,
				plan_json TEXT NOT NULL,
				source_path TEXT NOT NULL,
				base_sha TEXT,
				status TEXT NOT NULL,
				last_error TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)`,
		);
		raw.exec(
			`CREATE TABLE workflow_shards (
				run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
				shard_id TEXT NOT NULL,
				position INTEGER NOT NULL,
				status TEXT NOT NULL,
				branch_name TEXT,
				base_sha TEXT,
				output_excerpt TEXT,
				error TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (run_id, shard_id)
			)`,
		);
		raw.exec(
			`CREATE TABLE workflow_reviews (
				run_id TEXT NOT NULL,
				shard_id TEXT NOT NULL,
				position INTEGER NOT NULL,
				agent TEXT NOT NULL,
				status TEXT NOT NULL,
				summary TEXT,
				findings_json TEXT NOT NULL DEFAULT '[]',
				error TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (run_id, shard_id),
				FOREIGN KEY (run_id, shard_id) REFERENCES workflow_shards(run_id, shard_id) ON DELETE CASCADE
			)`,
		);
		raw.exec(
			`INSERT INTO workflow_runs (run_id, cwd, repo_root, plan_hash, plan_json, source_path, base_sha, status, last_error, created_at, updated_at)
			 VALUES ('legacy', '/p', '/p', 'hash', '{"run":"legacy-run"}', 'm.yml', NULL, 'planned', NULL, 1, 1)`,
		);
		raw.exec("PRAGMA user_version = 1");
		raw.close();

		const store = openStore();
		expect(store.connectionSettings().userVersion).toBe(PARALLEL_STORE_SCHEMA_VERSION);
		const runs = store.listRuns();
		expect(runs.map(run => run.runId)).toEqual(["legacy"]);
		expect(runs[0]?.runName).toBe("legacy-run");
		// The migrated row starts idle and is claimable under the new lease.
		expect(store.runOwnership("legacy")).toEqual({ ownerToken: null, ownerPid: null, claimedAt: null });
		store.claimRun("legacy");
		expect(store.runOwnership("legacy")?.ownerToken).toBe(store.ownerToken);
	});
});
