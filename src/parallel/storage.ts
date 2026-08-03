import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	canonicalParallelPlan,
	type ParallelReviewStatus,
	type ParallelRunStatus,
	type ParallelShardStatus,
	type ParallelWorkflowPlan,
	validateParallelWorkflowManifest,
} from "./contracts";
import type { ParallelReviewFinding } from "./scheduler";

export const PARALLEL_STORE_SCHEMA_VERSION = 2;
export const PARALLEL_STORE_BUSY_TIMEOUT_MS = 5_000;
export const PARALLEL_STORE_PROJECT_KEY_CHARS = 16;
export const PARALLEL_STORE_RUN_ID_MAX_CHARS = 128;
export const PARALLEL_STORE_PATH_MAX_CHARS = 1_024;
export const PARALLEL_STORE_SHA_MAX_CHARS = 128;
export const PARALLEL_STORE_BRANCH_MAX_CHARS = 300;
export const PARALLEL_STORE_ERROR_MAX_CHARS = 2_000;
export const PARALLEL_STORE_OUTPUT_MAX_CHARS = 10_000;
export const PARALLEL_STORE_SUMMARY_MAX_CHARS = 4_000;
export const PARALLEL_STORE_FINDINGS_MAX = 100;
export const PARALLEL_STORE_FINDING_PATH_MAX_CHARS = 512;
export const PARALLEL_STORE_FINDING_MESSAGE_MAX_CHARS = 1_000;

const RUN_STATUSES: readonly ParallelRunStatus[] = [
	"planned",
	"running",
	"review_pending",
	"ready_to_integrate",
	"integrating",
	"integrated",
	"failed",
	"cancelled",
	"interrupted",
];

const SHARD_STATUSES: readonly ParallelShardStatus[] = [
	"pending",
	"running",
	"completed",
	"review_pending",
	"approved",
	"rejected",
	"failed",
	"cancelled",
	"interrupted",
];

const REVIEW_STATUSES: readonly ParallelReviewStatus[] = [
	"pending",
	"running",
	"approved",
	"rejected",
	"failed",
	"cancelled",
	"interrupted",
];

export interface ParallelRunRecord {
	runId: string;
	cwd: string;
	repoRoot: string;
	planHash: string;
	plan: ParallelWorkflowPlan;
	baseSha: string | null;
	status: ParallelRunStatus;
	lastError: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface ParallelShardRecord {
	runId: string;
	shardId: string;
	status: ParallelShardStatus;
	branchName: string | null;
	baseSha: string | null;
	outputExcerpt: string | null;
	error: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface ParallelReviewRecord {
	runId: string;
	shardId: string;
	agent: string;
	status: ParallelReviewStatus;
	summary: string | null;
	findings: readonly ParallelReviewFinding[];
	error: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface ParallelStoredRun {
	run: ParallelRunRecord;
	shards: readonly ParallelShardRecord[];
	reviews: readonly ParallelReviewRecord[];
}

export interface ParallelRunSummary {
	runId: string;
	runName: string;
	status: ParallelRunStatus;
	planHash: string;
	lastError: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface ParallelCreateRunInput {
	runId: string;
	plan: ParallelWorkflowPlan;
	cwd?: string;
	baseSha?: string | null;
}

export interface ParallelRunPatch {
	status?: ParallelRunStatus;
	baseSha?: string | null;
	lastError?: string | null;
}

export interface ParallelShardPatch {
	status?: ParallelShardStatus;
	branchName?: string | null;
	baseSha?: string | null;
	outputExcerpt?: string | null;
	error?: string | null;
}

export interface ParallelReviewPatch {
	status?: ParallelReviewStatus;
	agent?: string;
	summary?: string | null;
	findings?: readonly ParallelReviewFinding[];
	error?: string | null;
}

export interface ParallelWorkflowStoreOptions {
	/** Explicit database directory; overrides XDG resolution. Tests only. */
	stateDir?: string;
	/** Environment used for XDG resolution; defaults to process.env. */
	env?: Record<string, string | undefined>;
	/** Clock seam for deterministic timestamps. */
	now?: () => number;
	/** Owner PID recorded on claimed runs; defaults to process.pid. */
	ownerPid?: number;
	/** Liveness probe for foreign owner PIDs; defaults to `process.kill(pid, 0)`. */
	isProcessAlive?: (pid: number) => boolean;
}

export interface ParallelStoreConnectionSettings {
	journalMode: string;
	synchronous: number;
	foreignKeys: number;
	busyTimeoutMs: number;
	userVersion: number;
}

/** Persisted lease columns for one run; null fields mean the run is idle. */
export interface ParallelRunOwnership {
	ownerToken: string | null;
	ownerPid: number | null;
	claimedAt: number | null;
}

function storeError(message: string): Error {
	return new Error(`Parallel workflow store: ${message}`);
}

/**
 * Bounded default liveness probe: signal 0 never kills, EPERM still proves
 * the PID is alive, and any other failure means the process is gone.
 */
function defaultProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Clamp one stored string; a capped value keeps a trailing ellipsis marker. */
function boundText(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}\u2026`;
}

function requireBoundedString(value: unknown, label: string, maxChars: number): string {
	if (typeof value !== "string") throw storeError(`${label} must be a string`);
	const trimmed = value.trim();
	if (trimmed.length === 0) throw storeError(`${label} must not be blank`);
	return boundText(trimmed, maxChars);
}

/** Normalize one nullable bounded text field; null clears the column. */
function optionalBoundedText(value: string | null, label: string, maxChars: number): string | null {
	if (value === null) return null;
	if (typeof value !== "string") throw storeError(`${label} must be a string or null`);
	return boundText(value, maxChars);
}

function requireStatus<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
	if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
	throw storeError(`${label} has unknown status ${JSON.stringify(value)}`);
}

function requireTimestamp(value: unknown, label: string): number {
	const numeric = typeof value === "number" ? value : Number.NaN;
	if (!Number.isFinite(numeric)) throw storeError(`${label} has an invalid timestamp`);
	return numeric;
}

function asNullableString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

/**
 * Sanitize untrusted review findings: keep only object entries with string
 * path/message, drop invalid optional lines, and cap entry count and lengths.
 */
export function sanitizeParallelFindings(value: unknown): ParallelReviewFinding[] {
	if (!Array.isArray(value)) return [];
	const findings: ParallelReviewFinding[] = [];
	for (const entry of value) {
		if (findings.length >= PARALLEL_STORE_FINDINGS_MAX) break;
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
		const record = entry as Record<string, unknown>;
		const rawPath = record.path;
		const rawMessage = record.message;
		if (typeof rawPath !== "string" || rawPath.trim().length === 0) continue;
		if (typeof rawMessage !== "string" || rawMessage.trim().length === 0) continue;
		const finding: ParallelReviewFinding = {
			path: boundText(rawPath.trim(), PARALLEL_STORE_FINDING_PATH_MAX_CHARS),
			message: boundText(rawMessage.trim(), PARALLEL_STORE_FINDING_MESSAGE_MAX_CHARS),
		};
		const rawLine = record.line;
		if (typeof rawLine === "number" && Number.isInteger(rawLine) && rawLine >= 1) finding.line = rawLine;
		findings.push(finding);
	}
	return findings;
}

function parseFindingsJson(raw: unknown): ParallelReviewFinding[] {
	if (typeof raw !== "string" || raw.length === 0) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	return sanitizeParallelFindings(parsed);
}

/** Resolve the state base directory from XDG_STATE_HOME or ~/.local/state. */
function resolveParallelStateDir(env: Record<string, string | undefined>): string {
	const xdg = env.XDG_STATE_HOME?.trim();
	const base =
		xdg !== undefined && xdg.length > 0 && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".local", "state");
	return path.join(base, "omp", "parallel");
}

/**
 * Walk up from cwd to the nearest directory containing `.git`. Falls back to
 * the resolved cwd itself so non-Git projects still get a stable key.
 */
function resolveRepoRoot(cwd: string): string {
	let resolved = path.resolve(cwd);
	try {
		resolved = fs.realpathSync(resolved);
	} catch {
		// Missing path segments keep the resolved logical path.
	}
	let current = resolved;
	while (true) {
		if (fs.existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return resolved;
		current = parent;
	}
}

/** Derive the stable project filename key; never embeds the raw path. */
export function parallelProjectKey(repoRoot: string): string {
	return createHash("sha256").update(repoRoot).digest("hex").slice(0, PARALLEL_STORE_PROJECT_KEY_CHARS);
}

const SCHEMA_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS workflow_runs (
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
		updated_at INTEGER NOT NULL,
		owner_token TEXT,
		owner_pid INTEGER,
		owner_claimed_at INTEGER
	)`,
	`CREATE TABLE IF NOT EXISTS workflow_shards (
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
	`CREATE TABLE IF NOT EXISTS workflow_reviews (
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
] as const;

/** In-place upgrade from schema version 1: add the per-run lease columns. */
const SCHEMA_V2_MIGRATION_STATEMENTS = [
	"ALTER TABLE workflow_runs ADD COLUMN owner_token TEXT",
	"ALTER TABLE workflow_runs ADD COLUMN owner_pid INTEGER",
	"ALTER TABLE workflow_runs ADD COLUMN owner_claimed_at INTEGER",
] as const;

interface RunRow {
	run_id: string;
	cwd: string;
	repo_root: string;
	plan_hash: string;
	plan_json: string;
	source_path: string;
	base_sha: string | null;
	status: string;
	last_error: string | null;
	created_at: number;
	updated_at: number;
	owner_token: string | null;
	owner_pid: number | null;
	owner_claimed_at: number | null;
}

interface ShardRow {
	run_id: string;
	shard_id: string;
	status: string;
	branch_name: string | null;
	base_sha: string | null;
	output_excerpt: string | null;
	error: string | null;
	created_at: number;
	updated_at: number;
}

interface ReviewRow {
	run_id: string;
	shard_id: string;
	agent: string;
	status: string;
	summary: string | null;
	findings_json: string;
	error: string | null;
	created_at: number;
	updated_at: number;
}

/**
 * Plugin-owned durable state for parallel workflow runs. One database per
 * repository root under the XDG state directory; the filename is a stable
 * hash key so raw user paths never appear in state filenames.
 */
export class ParallelWorkflowStore {
	readonly cwd: string;
	readonly repoRoot: string;
	readonly databasePath: string;
	private readonly db: Database;
	private readonly now: () => number;
	/** Unique per-instance lease token; never persisted across opens. */
	readonly ownerToken: string;
	private readonly ownerPid: number;
	private readonly processAlive: (pid: number) => boolean;

	private constructor(
		cwd: string,
		repoRoot: string,
		databasePath: string,
		db: Database,
		now: () => number,
		ownerPid: number,
		processAlive: (pid: number) => boolean,
	) {
		this.cwd = cwd;
		this.repoRoot = repoRoot;
		this.databasePath = databasePath;
		this.db = db;
		this.now = now;
		this.ownerToken = randomUUID();
		this.ownerPid = ownerPid;
		this.processAlive = processAlive;
	}

	/**
	 * Open (creating on demand) the project database for one working
	 * directory and run migrations. Opening never mutates run rows: recovery
	 * from a dead owner happens per run inside {@link claimRun}, so
	 * status/read-only opens can never disturb a run owned by a live process.
	 */
	static openForCwd(cwd: string, options: ParallelWorkflowStoreOptions = {}): ParallelWorkflowStore {
		const resolvedCwd = path.resolve(cwd);
		const repoRoot = resolveRepoRoot(resolvedCwd);
		const stateDir = options.stateDir ?? resolveParallelStateDir(options.env ?? process.env);
		fs.mkdirSync(stateDir, { recursive: true });
		const databasePath = path.join(stateDir, `${parallelProjectKey(repoRoot)}.sqlite`);
		const now = options.now ?? Date.now;
		const ownerPid = options.ownerPid ?? process.pid;
		const processAlive = options.isProcessAlive ?? defaultProcessAlive;

		const db = new Database(databasePath, { create: true });
		try {
			db.exec("PRAGMA journal_mode = WAL");
			db.exec("PRAGMA synchronous = NORMAL");
			db.exec("PRAGMA foreign_keys = ON");
			db.exec(`PRAGMA busy_timeout = ${PARALLEL_STORE_BUSY_TIMEOUT_MS}`);
			migrate(db);
			const store = new ParallelWorkflowStore(resolvedCwd, repoRoot, databasePath, db, now, ownerPid, processAlive);
			return store;
		} catch (error) {
			db.close();
			throw error;
		}
	}

	/** Per-connection pragma snapshot for diagnostics and tests. */
	connectionSettings(): ParallelStoreConnectionSettings {
		const pragma = (name: string): unknown => {
			const row = this.db.query(`PRAGMA ${name}`).get() as Record<string, unknown> | null;
			return row === null ? undefined : Object.values(row)[0];
		};
		return {
			journalMode: String(pragma("journal_mode")),
			synchronous: Number(pragma("synchronous")),
			foreignKeys: Number(pragma("foreign_keys")),
			busyTimeoutMs: Number(pragma("busy_timeout")),
			userVersion: Number(pragma("user_version")),
		};
	}

	/**
	 * Persist one immutable validated plan with its initial shard and review
	 * rows in a single transaction. The run starts `planned`, shards
	 * `pending`, and declared reviews `pending`.
	 */
	createRun(input: ParallelCreateRunInput): ParallelStoredRun {
		const runId = requireBoundedString(input.runId, "runId", PARALLEL_STORE_RUN_ID_MAX_CHARS);
		const plan = input.plan;
		const planJson = canonicalParallelPlan(plan);
		const planHash = createHash("sha256").update(planJson).digest("hex");
		if (plan.planHash !== planHash) {
			throw storeError(`plan hash mismatch for run "${runId}": plan does not match its canonical form`);
		}
		const cwd =
			input.cwd === undefined ? this.cwd : requireBoundedString(input.cwd, "cwd", PARALLEL_STORE_PATH_MAX_CHARS);
		const baseSha = optionalBoundedText(input.baseSha ?? null, "baseSha", PARALLEL_STORE_SHA_MAX_CHARS);
		const timestamp = this.now();

		const existing = this.db.query("SELECT run_id FROM workflow_runs WHERE run_id = $runId").get({ $runId: runId });
		if (existing !== null) throw storeError(`run "${runId}" already exists`);

		const insertRun = this.db.query(
			`INSERT INTO workflow_runs (run_id, cwd, repo_root, plan_hash, plan_json, source_path, base_sha, status, last_error, created_at, updated_at)
			 VALUES ($runId, $cwd, $repoRoot, $planHash, $planJson, $sourcePath, $baseSha, 'planned', NULL, $timestamp, $timestamp)`,
		);
		const insertShard = this.db.query(
			`INSERT INTO workflow_shards (run_id, shard_id, position, status, branch_name, base_sha, output_excerpt, error, created_at, updated_at)
			 VALUES ($runId, $shardId, $position, 'pending', NULL, NULL, NULL, NULL, $timestamp, $timestamp)`,
		);
		const insertReview = this.db.query(
			`INSERT INTO workflow_reviews (run_id, shard_id, position, agent, status, summary, findings_json, error, created_at, updated_at)
			 VALUES ($runId, $shardId, $position, $agent, 'pending', NULL, '[]', NULL, $timestamp, $timestamp)`,
		);

		this.db.transaction(() => {
			insertRun.run({
				$runId: runId,
				$cwd: cwd,
				$repoRoot: this.repoRoot,
				$planHash: planHash,
				$planJson: planJson,
				$sourcePath: boundText(plan.sourcePath, PARALLEL_STORE_PATH_MAX_CHARS),
				$baseSha: baseSha,
				$timestamp: timestamp,
			});
			plan.shards.forEach((shard, position) => {
				insertShard.run({ $runId: runId, $shardId: shard.id, $position: position, $timestamp: timestamp });
				if (shard.review !== undefined) {
					insertReview.run({
						$runId: runId,
						$shardId: shard.id,
						$position: position,
						$agent: shard.review.agent,
						$timestamp: timestamp,
					});
				}
			});
		})();

		const stored = this.getRun(runId);
		if (stored === null) throw storeError(`run "${runId}" vanished after creation`);
		return stored;
	}

	/** Load one run with its shard and review rows, or null when unknown. */
	getRun(runId: string): ParallelStoredRun | null {
		const runRow = this.db
			.query("SELECT * FROM workflow_runs WHERE run_id = $runId")
			.get({ $runId: runId }) as RunRow | null;
		if (runRow === null) return null;
		const shardRows = this.db
			.query("SELECT * FROM workflow_shards WHERE run_id = $runId ORDER BY position ASC, shard_id ASC")
			.all({ $runId: runId }) as ShardRow[];
		const reviewRows = this.db
			.query("SELECT * FROM workflow_reviews WHERE run_id = $runId ORDER BY position ASC, shard_id ASC")
			.all({ $runId: runId }) as ReviewRow[];
		return {
			run: this.parseRunRow(runRow),
			shards: shardRows.map(row => parseShardRow(row)),
			reviews: reviewRows.map(row => parseReviewRow(row)),
		};
	}

	/** Bounded run summaries, newest first. */
	listRuns(): readonly ParallelRunSummary[] {
		const rows = this.db
			.query(
				`SELECT run_id, plan_json, plan_hash, status, last_error, created_at, updated_at
				 FROM workflow_runs ORDER BY created_at DESC, run_id ASC`,
			)
			.all() as Array<
			Pick<RunRow, "run_id" | "plan_json" | "plan_hash" | "status" | "last_error" | "created_at" | "updated_at">
		>;
		return rows.map(row => ({
			runId: row.run_id,
			runName: extractRunName(row.plan_json),
			status: requireStatus(row.status, RUN_STATUSES, `run "${row.run_id}"`),
			planHash: row.plan_hash,
			lastError: asNullableString(row.last_error),
			createdAt: requireTimestamp(row.created_at, `run "${row.run_id}"`),
			updatedAt: requireTimestamp(row.updated_at, `run "${row.run_id}"`),
		}));
	}

	/** Patch mutable run fields. Plan JSON and plan hash are never writable. */
	updateRun(runId: string, patch: ParallelRunPatch): void {
		const assignments: string[] = [];
		const params: Record<string, string | number | null> = { $runId: runId };
		if (patch.status !== undefined) {
			assignments.push("status = $status");
			params.$status = requireStatus(patch.status, RUN_STATUSES, "updateRun status");
		}
		if (patch.baseSha !== undefined) {
			assignments.push("base_sha = $baseSha");
			params.$baseSha = optionalBoundedText(patch.baseSha, "baseSha", PARALLEL_STORE_SHA_MAX_CHARS);
		}
		if (patch.lastError !== undefined) {
			assignments.push("last_error = $lastError");
			params.$lastError = optionalBoundedText(patch.lastError, "lastError", PARALLEL_STORE_ERROR_MAX_CHARS);
		}
		this.applyPatch("workflow_runs", "run", runId, assignments, params, "run_id = $runId");
	}

	/** Patch mutable shard fields for one run. */
	updateShard(runId: string, shardId: string, patch: ParallelShardPatch): void {
		const assignments: string[] = [];
		const params: Record<string, string | number | null> = { $runId: runId, $shardId: shardId };
		if (patch.status !== undefined) {
			assignments.push("status = $status");
			params.$status = requireStatus(patch.status, SHARD_STATUSES, "updateShard status");
		}
		if (patch.branchName !== undefined) {
			assignments.push("branch_name = $branchName");
			params.$branchName = optionalBoundedText(patch.branchName, "branchName", PARALLEL_STORE_BRANCH_MAX_CHARS);
		}
		if (patch.baseSha !== undefined) {
			assignments.push("base_sha = $baseSha");
			params.$baseSha = optionalBoundedText(patch.baseSha, "baseSha", PARALLEL_STORE_SHA_MAX_CHARS);
		}
		if (patch.outputExcerpt !== undefined) {
			assignments.push("output_excerpt = $outputExcerpt");
			params.$outputExcerpt = optionalBoundedText(
				patch.outputExcerpt,
				"outputExcerpt",
				PARALLEL_STORE_OUTPUT_MAX_CHARS,
			);
		}
		if (patch.error !== undefined) {
			assignments.push("error = $error");
			params.$error = optionalBoundedText(patch.error, "error", PARALLEL_STORE_ERROR_MAX_CHARS);
		}
		this.applyPatch(
			"workflow_shards",
			`shard "${shardId}" in run`,
			runId,
			assignments,
			params,
			"run_id = $runId AND shard_id = $shardId",
		);
	}

	/** Patch mutable review fields for one shard's review row. */
	updateReview(runId: string, shardId: string, patch: ParallelReviewPatch): void {
		const assignments: string[] = [];
		const params: Record<string, string | number | null> = { $runId: runId, $shardId: shardId };
		if (patch.status !== undefined) {
			assignments.push("status = $status");
			params.$status = requireStatus(patch.status, REVIEW_STATUSES, "updateReview status");
		}
		if (patch.agent !== undefined) {
			assignments.push("agent = $agent");
			params.$agent = requireBoundedString(patch.agent, "agent", PARALLEL_STORE_BRANCH_MAX_CHARS);
		}
		if (patch.summary !== undefined) {
			assignments.push("summary = $summary");
			params.$summary = optionalBoundedText(patch.summary, "summary", PARALLEL_STORE_SUMMARY_MAX_CHARS);
		}
		if (patch.findings !== undefined) {
			assignments.push("findings_json = $findings");
			params.$findings = JSON.stringify(sanitizeParallelFindings(patch.findings as unknown));
		}
		if (patch.error !== undefined) {
			assignments.push("error = $error");
			params.$error = optionalBoundedText(patch.error, "error", PARALLEL_STORE_ERROR_MAX_CHARS);
		}
		this.applyPatch(
			"workflow_reviews",
			`review for shard "${shardId}" in run`,
			runId,
			assignments,
			params,
			"run_id = $runId AND shard_id = $shardId",
		);
	}

	/**
	 * Atomically claim exclusive ownership of one run for this store
	 * instance. Claiming is reentrant for the current owner. A run owned by
	 * a live foreign process is rejected. Any fresh claim — takeover from a
	 * dead owner or a legacy/unowned run — first marks only that run's
	 * mid-flight rows `interrupted` (a live driver would hold the lease), so
	 * branch artifacts survive for `resume`.
	 */
	claimRun(runId: string): void {
		const timestamp = this.now();
		this.db.transaction(() => {
			const row = this.db
				.query("SELECT owner_token, owner_pid FROM workflow_runs WHERE run_id = $runId")
				.get({ $runId: runId }) as { owner_token: string | null; owner_pid: number | null } | null;
			if (row === null) throw storeError(`run "${runId}" not found`);
			if (row.owner_token === this.ownerToken) return;
			if (row.owner_token !== null) {
				const pid = typeof row.owner_pid === "number" ? row.owner_pid : null;
				if (pid !== null && this.processAlive(pid)) {
					throw storeError(`run "${runId}" is claimed by live process ${pid}`);
				}
			}
			this.markRunInterrupted(runId, timestamp);
			this.db
				.query(
					`UPDATE workflow_runs SET owner_token = $token, owner_pid = $pid, owner_claimed_at = $timestamp
					 WHERE run_id = $runId`,
				)
				.run({ $token: this.ownerToken, $pid: this.ownerPid, $timestamp: timestamp, $runId: runId });
		})();
	}

	/** Release one run's lease; a no-op unless this instance is the owner. */
	releaseRun(runId: string): void {
		this.db
			.query(
				`UPDATE workflow_runs SET owner_token = NULL, owner_pid = NULL, owner_claimed_at = NULL
				 WHERE run_id = $runId AND owner_token = $token`,
			)
			.run({ $runId: runId, $token: this.ownerToken });
	}

	/** Current persisted lease for one run, or null when the run is unknown. */
	runOwnership(runId: string): ParallelRunOwnership | null {
		const row = this.db
			.query("SELECT owner_token, owner_pid, owner_claimed_at FROM workflow_runs WHERE run_id = $runId")
			.get({ $runId: runId }) as {
			owner_token: string | null;
			owner_pid: number | null;
			owner_claimed_at: number | null;
		} | null;
		if (row === null) return null;
		return {
			ownerToken: asNullableString(row.owner_token),
			ownerPid: typeof row.owner_pid === "number" ? row.owner_pid : null,
			claimedAt: typeof row.owner_claimed_at === "number" ? row.owner_claimed_at : null,
		};
	}

	close(): void {
		this.db.close();
	}

	private applyPatch(
		table: string,
		label: string,
		runId: string,
		assignments: string[],
		params: Record<string, string | number | null>,
		where: string,
	): void {
		if (assignments.length === 0) throw storeError(`empty patch for ${label} "${runId}"`);
		assignments.push("updated_at = $updatedAt");
		params.$updatedAt = this.now();
		const result = this.db.query(`UPDATE ${table} SET ${assignments.join(", ")} WHERE ${where}`).run(params);
		if (result.changes === 0) throw storeError(`${label} "${runId}" not found`);
	}

	/** Mark one run's rows abandoned mid-flight by a dead owner; artifacts survive. */
	private markRunInterrupted(runId: string, timestamp: number): void {
		this.db
			.query(
				`UPDATE workflow_reviews SET status = 'interrupted', updated_at = $timestamp
				 WHERE run_id = $runId AND status = 'running'`,
			)
			.run({ $runId: runId, $timestamp: timestamp });
		this.db
			.query(
				`UPDATE workflow_shards SET status = 'interrupted', updated_at = $timestamp
				 WHERE run_id = $runId AND status = 'running'`,
			)
			.run({ $runId: runId, $timestamp: timestamp });
		this.db
			.query(
				`UPDATE workflow_runs SET status = 'interrupted', updated_at = $timestamp
				 WHERE run_id = $runId AND status IN ('running', 'integrating')`,
			)
			.run({ $runId: runId, $timestamp: timestamp });
	}

	private parseRunRow(row: RunRow): ParallelRunRecord {
		let parsedPlan: unknown;
		try {
			parsedPlan = JSON.parse(row.plan_json);
		} catch {
			throw storeError(`run "${row.run_id}" has corrupt plan JSON`);
		}
		let plan: ParallelWorkflowPlan;
		try {
			plan = validateParallelWorkflowManifest(parsedPlan, row.source_path);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw storeError(`run "${row.run_id}" has an invalid stored plan: ${detail}`);
		}
		if (plan.planHash !== row.plan_hash) {
			throw storeError(`run "${row.run_id}" stored plan does not match its recorded plan hash`);
		}
		return {
			runId: row.run_id,
			cwd: row.cwd,
			repoRoot: row.repo_root,
			planHash: row.plan_hash,
			plan,
			baseSha: asNullableString(row.base_sha),
			status: requireStatus(row.status, RUN_STATUSES, `run "${row.run_id}"`),
			lastError: asNullableString(row.last_error),
			createdAt: requireTimestamp(row.created_at, `run "${row.run_id}"`),
			updatedAt: requireTimestamp(row.updated_at, `run "${row.run_id}"`),
		};
	}
}

function migrate(db: Database): void {
	const row = db.query("PRAGMA user_version").get() as { user_version?: unknown } | null;
	const version = Number(row?.user_version ?? 0);
	if (version === PARALLEL_STORE_SCHEMA_VERSION) return;
	if (version !== 0 && version !== 1) {
		throw storeError(
			`unknown schema version ${version}; this build supports version ${PARALLEL_STORE_SCHEMA_VERSION}`,
		);
	}
	db.transaction(() => {
		if (version === 0) {
			for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
		} else {
			for (const statement of SCHEMA_V2_MIGRATION_STATEMENTS) db.exec(statement);
		}
		db.exec(`PRAGMA user_version = ${PARALLEL_STORE_SCHEMA_VERSION}`);
	})();
}

function parseShardRow(row: ShardRow): ParallelShardRecord {
	return {
		runId: row.run_id,
		shardId: row.shard_id,
		status: requireStatus(row.status, SHARD_STATUSES, `shard "${row.shard_id}"`),
		branchName: asNullableString(row.branch_name),
		baseSha: asNullableString(row.base_sha),
		outputExcerpt: asNullableString(row.output_excerpt),
		error: asNullableString(row.error),
		createdAt: requireTimestamp(row.created_at, `shard "${row.shard_id}"`),
		updatedAt: requireTimestamp(row.updated_at, `shard "${row.shard_id}"`),
	};
}

function parseReviewRow(row: ReviewRow): ParallelReviewRecord {
	return {
		runId: row.run_id,
		shardId: row.shard_id,
		agent: row.agent,
		status: requireStatus(row.status, REVIEW_STATUSES, `review for shard "${row.shard_id}"`),
		summary: asNullableString(row.summary),
		findings: parseFindingsJson(row.findings_json),
		error: asNullableString(row.error),
		createdAt: requireTimestamp(row.created_at, `review for shard "${row.shard_id}"`),
		updatedAt: requireTimestamp(row.updated_at, `review for shard "${row.shard_id}"`),
	};
}

/** Best-effort run name from stored plan JSON for summaries; never throws. */
function extractRunName(planJson: string): string {
	try {
		const parsed = JSON.parse(planJson);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			typeof (parsed as Record<string, unknown>).run === "string"
		) {
			return (parsed as Record<string, unknown>).run as string;
		}
	} catch {
		// Corrupt JSON falls through to the placeholder.
	}
	return "(unknown)";
}
