import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { loadParallelWorkflowManifest } from "./contracts";
import {
	ParallelCoordinator,
	type ParallelCoordinatorHost,
	type ParallelExec,
	type ParallelRunSnapshot,
	type ParallelSubagentRunner,
} from "./coordinator";
import {
	ParallelWorkflowStore,
	type ParallelRunSummary,
	type ParallelStoredRun,
	type ParallelWorkflowStoreOptions,
} from "./storage";

/** Registered slash-command name: `/parallel …`. */
export const PARALLEL_COMMAND_NAME = "parallel";

export const PARALLEL_COMMAND_USAGE =
	"Usage: /parallel plan <manifest.yaml> [--json] | status [run-id] [--json] | " +
	"resume <run-id> [--wait] [--json] | review <run-id> [--wait] [--json] | " +
	"integrate <run-id> [--wait] [--json] | cancel <run-id> [--json]";

/** Bounded display caps so one status notification can never flood the UI. */
export const PARALLEL_STATUS_MAX_RUNS = 20;
export const PARALLEL_STATUS_MAX_ROWS = 50;
export const PARALLEL_STATUS_TEXT_MAX_CHARS = 200;

const SUBCOMMANDS = ["plan", "status", "resume", "review", "integrate", "cancel"] as const;
type ParallelSubcommand = (typeof SUBCOMMANDS)[number];

const RUN_ID_SUBCOMMANDS: readonly ParallelSubcommand[] = ["status", "resume", "review", "integrate", "cancel"];
const WAITABLE_SUBCOMMANDS: readonly ParallelSubcommand[] = ["resume", "review", "integrate"];

const PARALLEL_COMMAND_COMPLETIONS = [
	{ label: "plan", value: "plan", description: "Validate a manifest and create a run (never dispatches)" },
	{ label: "status", value: "status", description: "Show every stored run, or one run in detail" },
	{ label: "resume", value: "resume", description: "Dispatch ready shards for a run (background unless --wait)" },
	{ label: "review", value: "review", description: "Retry non-approved reviews for completed shards" },
	{ label: "integrate", value: "integrate", description: "Explicitly merge one fully approved run" },
	{ label: "cancel", value: "cancel", description: "Abort active work and mark the run cancelled" },
];

/** One parsed `/parallel` invocation; produced by pure tokenization, never a shell. */
export type ParallelParsedCommand =
	| { action: "plan"; manifestPath: string; json: boolean }
	| { action: "status"; runId: string | undefined; json: boolean }
	| { action: "resume" | "review" | "integrate"; runId: string; wait: boolean; json: boolean }
	| { action: "cancel"; runId: string; json: boolean };

export interface ParallelParseError {
	error: string;
}

function parseError(error: string): ParallelParseError {
	return { error };
}

function isSubcommand(value: string): value is ParallelSubcommand {
	return (SUBCOMMANDS as readonly string[]).includes(value);
}

/**
 * Parse `/parallel` arguments by whitespace tokenization only. Flags are the
 * literal tokens `--wait` and `--json`; everything else is positional. No
 * quoting, expansion, or shell evaluation of any kind is performed.
 */
export function parseParallelCommandArgs(args: string): ParallelParsedCommand | ParallelParseError {
	const tokens = args.trim().split(/\s+/).filter(token => token.length > 0);
	const positionals: string[] = [];
	let wait = false;
	let json = false;
	for (const token of tokens) {
		if (token === "--wait") {
			wait = true;
			continue;
		}
		if (token === "--json") {
			json = true;
			continue;
		}
		if (token.startsWith("--")) return parseError(`unknown flag "${token}"`);
		positionals.push(token);
	}

	const subcommand = positionals[0]?.toLowerCase() ?? "status";
	if (!isSubcommand(subcommand)) return parseError(`unknown subcommand "${positionals[0]}"`);
	if (wait && !WAITABLE_SUBCOMMANDS.includes(subcommand)) {
		return parseError(`--wait is only valid for ${WAITABLE_SUBCOMMANDS.join("/")}`);
	}

	const operands = positionals.slice(1);
	if (subcommand === "plan") {
		if (operands.length !== 1) return parseError("plan requires exactly one manifest path");
		return { action: "plan", manifestPath: operands[0], json };
	}
	if (subcommand === "status") {
		if (operands.length > 1) return parseError("status accepts at most one run ID");
		return { action: "status", runId: operands[0], json };
	}
	if (operands.length !== 1) return parseError(`${subcommand} requires exactly one run ID`);
	if (subcommand === "cancel") return { action: "cancel", runId: operands[0], json };
	return { action: subcommand, runId: operands[0], wait, json };
}

/**
 * Completions for `/parallel`: subcommands on the first word, then known run
 * IDs for every subcommand that takes one. Manifest paths are not completed.
 */
export function parallelArgumentCompletions(
	argumentPrefix: string,
	runIds: readonly string[],
): Array<{ label: string; value: string; description: string }> | null {
	const trimmed = argumentPrefix.trimStart();
	const firstWhitespace = trimmed.search(/\s/);
	if (firstWhitespace === -1) {
		const normalized = trimmed.toLowerCase();
		return PARALLEL_COMMAND_COMPLETIONS.filter(item => item.label.startsWith(normalized));
	}

	const command = trimmed.slice(0, firstWhitespace).toLowerCase();
	if (!isSubcommand(command) || !RUN_ID_SUBCOMMANDS.includes(command)) return null;
	const rest = trimmed.slice(firstWhitespace).trimStart();
	if (/\s/.test(rest)) return null;
	const prefix = rest.toLowerCase();
	return runIds
		.filter(runId => runId.toLowerCase().startsWith(prefix))
		.map(runId => ({
			label: runId,
			value: `${command} ${runId}`,
			description: `Run ${runId}`,
		}));
}

/** Clip one display string; a capped value keeps a trailing ellipsis marker. */
function clip(value: string, maxChars = PARALLEL_STATUS_TEXT_MAX_CHARS): string {
	return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}\u2026`;
}

function overflowLine(total: number, shown: number, label: string): string[] {
	return total > shown ? [`  \u2026and ${total - shown} more ${label}`] : [];
}

/** Bounded human-readable listing of stored run summaries, newest first. */
export function formatParallelRunSummaries(summaries: readonly ParallelRunSummary[]): string {
	if (summaries.length === 0) {
		return "Parallel workflows: no stored runs. Create one with /parallel plan <manifest.yaml>.";
	}
	const shown = summaries.slice(0, PARALLEL_STATUS_MAX_RUNS);
	const lines = shown.map(summary => {
		const error = summary.lastError === null ? "" : ` \u2014 ${clip(summary.lastError)}`;
		return `  ${summary.runId}  ${summary.runName}  ${summary.status}${error}`;
	});
	return [
		`Parallel runs (${summaries.length}):`,
		...lines,
		...overflowLine(summaries.length, shown.length, "runs"),
	].join("\n");
}

/** Bounded human-readable detail view of one stored run. */
export function formatParallelRunSnapshot(stored: ParallelStoredRun): string {
	const run = stored.run;
	const lines = [`Parallel run ${run.runId} (${run.plan.run}): ${run.status}`];
	if (run.lastError !== null) lines.push(`  last error: ${clip(run.lastError)}`);

	const shards = stored.shards.slice(0, PARALLEL_STATUS_MAX_ROWS);
	for (const shard of shards) {
		const branch = shard.branchName === null ? "" : ` [${shard.branchName}]`;
		const error = shard.error === null ? "" : ` \u2014 ${clip(shard.error)}`;
		lines.push(`  shard ${shard.shardId}: ${shard.status}${branch}${error}`);
	}
	lines.push(...overflowLine(stored.shards.length, shards.length, "shards"));

	const reviews = stored.reviews.slice(0, PARALLEL_STATUS_MAX_ROWS);
	for (const review of reviews) {
		const summary = review.summary === null ? "" : ` \u2014 ${clip(review.summary)}`;
		const error = review.error === null ? "" : ` \u2014 ${clip(review.error)}`;
		lines.push(`  review ${review.shardId} (${review.agent}): ${review.status}${summary}${error}`);
	}
	lines.push(...overflowLine(stored.reviews.length, reviews.length, "reviews"));
	return lines.join("\n");
}

/** Bounded JSON view of one stored run; excerpts stay clipped for the UI. */
export function parallelSnapshotToJson(stored: ParallelStoredRun): string {
	return JSON.stringify({
		runId: stored.run.runId,
		name: stored.run.plan.run,
		status: stored.run.status,
		planHash: stored.run.planHash,
		cwd: stored.run.cwd,
		repoRoot: stored.run.repoRoot,
		baseSha: stored.run.baseSha,
		lastError: stored.run.lastError === null ? null : clip(stored.run.lastError),
		createdAt: stored.run.createdAt,
		updatedAt: stored.run.updatedAt,
		shardsTotal: stored.shards.length,
		shards: stored.shards.slice(0, PARALLEL_STATUS_MAX_ROWS).map(shard => ({
			shardId: shard.shardId,
			status: shard.status,
			branchName: shard.branchName,
			baseSha: shard.baseSha,
			error: shard.error === null ? null : clip(shard.error),
		})),
		reviewsTotal: stored.reviews.length,
		reviews: stored.reviews.slice(0, PARALLEL_STATUS_MAX_ROWS).map(review => ({
			shardId: review.shardId,
			agent: review.agent,
			status: review.status,
			summary: review.summary === null ? null : clip(review.summary),
			findingsCount: review.findings.length,
			error: review.error === null ? null : clip(review.error),
		})),
	});
}

/** Bounded JSON view of stored run summaries. */
export function parallelSummariesToJson(summaries: readonly ParallelRunSummary[]): string {
	return JSON.stringify(
		summaries.slice(0, PARALLEL_STATUS_MAX_RUNS).map(summary => ({
			runId: summary.runId,
			runName: summary.runName,
			status: summary.status,
			planHash: summary.planHash,
			lastError: summary.lastError === null ? null : clip(summary.lastError),
			createdAt: summary.createdAt,
			updatedAt: summary.updatedAt,
		})),
	);
}

/** Coordinator methods the command layer drives; satisfied by `ParallelCoordinator`. */
export type ParallelCommandCoordinator = Pick<
	ParallelCoordinator,
	"createRun" | "resume" | "review" | "cancel" | "integrate" | "status" | "wait"
>;

/** One cached per-cwd runtime: a coordinator plus its completion/model seams. */
export interface ParallelCommandRuntime {
	coordinator: ParallelCommandCoordinator;
	/** Known run IDs for completions; must never throw. */
	listRunIds(): readonly string[];
	/** Refresh the router-selected model used when a manifest omits `model`. */
	setCurrentModelSelector(selector: string | undefined): void;
}

export interface ParallelCommandDependencies {
	/** Replace runtime construction wholesale; keyed by resolved cwd. Tests only. */
	createRuntime?: (cwd: string) => ParallelCommandRuntime;
	loadManifest?: typeof loadParallelWorkflowManifest;
	/** Store construction options for the default runtime (state dir, clock). */
	storeOptions?: ParallelWorkflowStoreOptions;
	discover?: typeof discoverAgents;
	execute?: typeof runSubprocess;
	runSubagent?: ParallelSubagentRunner;
}

/**
 * Default per-cwd runtime: one SQLite-backed store and one coordinator whose
 * host runs git through `pi.exec` argv arrays, discovers agents via the
 * public task API, and dispatches shards via the public subprocess executor.
 */
function createDefaultRuntime(
	pi: ExtensionAPI,
	cwd: string,
	dependencies: ParallelCommandDependencies,
): ParallelCommandRuntime {
	const store = ParallelWorkflowStore.openForCwd(cwd, dependencies.storeOptions);
	const discover = dependencies.discover ?? discoverAgents;
	const execute = dependencies.execute ?? runSubprocess;
	const exec: ParallelExec = async (command, args, options) => {
		const result = await pi.exec(command, args, options?.cwd === undefined ? undefined : { cwd: options.cwd });
		return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
	};
	const host: ParallelCoordinatorHost = {
		cwd,
		exec,
		discover: async directory => ({ agents: (await discover(directory)).agents }),
		runSubagent:
			dependencies.runSubagent ??
			(request =>
				execute({
					cwd: request.cwd,
					worktree: request.worktree,
					agent: request.agent,
					task: request.task,
					index: request.index,
					id: request.id,
					modelOverride: request.modelOverride,
					signal: request.signal,
					keepAlive: false,
				})),
	};
	const coordinator = new ParallelCoordinator(host, { store });
	return {
		coordinator,
		listRunIds: () => store.listRuns().map(summary => summary.runId),
		setCurrentModelSelector: selector => {
			host.currentModelSelector = selector;
		},
	};
}

function statusNotifyType(snapshot: ParallelRunSnapshot): "info" | "warning" {
	return snapshot.run.status === "failed" ? "warning" : "info";
}

function renderSnapshot(snapshot: ParallelRunSnapshot, json: boolean): string {
	return json ? parallelSnapshotToJson(snapshot) : formatParallelRunSnapshot(snapshot);
}

/**
 * Register the `/parallel` command. All failures surface as UI warnings; the
 * handler never throws. Long-running resume/review/integrate calls return
 * control immediately and notify on settlement unless `--wait` is supplied.
 */
export function registerParallelCommand(pi: ExtensionAPI, dependencies: ParallelCommandDependencies = {}): void {
	const loadManifest = dependencies.loadManifest ?? loadParallelWorkflowManifest;
	const runtimes = new Map<string, ParallelCommandRuntime>();
	const runtimeFor = (cwd: string): ParallelCommandRuntime => {
		const key = path.resolve(cwd);
		let runtime = runtimes.get(key);
		if (runtime === undefined) {
			runtime = dependencies.createRuntime?.(key) ?? createDefaultRuntime(pi, key, dependencies);
			runtimes.set(key, runtime);
		}
		return runtime;
	};
	const knownRunIds = (): string[] => {
		const ids = new Set<string>();
		for (const runtime of runtimes.values()) {
			try {
				for (const runId of runtime.listRunIds()) ids.add(runId);
			} catch {
				// Completions are best-effort; a broken store never breaks typing.
			}
		}
		return [...ids];
	};

	const handle = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const parsed = parseParallelCommandArgs(args);
		if ("error" in parsed) {
			ctx.ui.notify(`Parallel workflows: ${parsed.error}\n${PARALLEL_COMMAND_USAGE}`, "warning");
			return;
		}
		const runtime = runtimeFor(ctx.cwd);
		const model = ctx.models.current() ?? ctx.model;
		runtime.setCurrentModelSelector(model === undefined ? undefined : `${model.provider}/${model.id}`);
		const coordinator = runtime.coordinator;

		if (parsed.action === "plan") {
			const manifestPath = path.isAbsolute(parsed.manifestPath)
				? parsed.manifestPath
				: path.resolve(ctx.cwd, parsed.manifestPath);
			const plan = await loadManifest(manifestPath);
			const snapshot = await coordinator.createRun(plan);
			if (parsed.json) {
				ctx.ui.notify(parallelSnapshotToJson(snapshot), "info");
				return;
			}
			ctx.ui.notify(
				`Parallel run ${snapshot.run.runId} created from "${plan.run}" ` +
					`(${plan.shards.length} shard${plan.shards.length === 1 ? "" : "s"}, status ${snapshot.run.status}). ` +
					`Start it with /parallel resume ${snapshot.run.runId}.`,
				"info",
			);
			return;
		}

		if (parsed.action === "status") {
			const result = await coordinator.status(parsed.runId);
			if (Array.isArray(result)) {
				const summaries = result as readonly ParallelRunSummary[];
				ctx.ui.notify(parsed.json ? parallelSummariesToJson(summaries) : formatParallelRunSummaries(summaries), "info");
				return;
			}
			const snapshot = result as ParallelRunSnapshot;
			ctx.ui.notify(renderSnapshot(snapshot, parsed.json), statusNotifyType(snapshot));
			return;
		}

		if (parsed.action === "cancel") {
			const snapshot = await coordinator.cancel(parsed.runId);
			ctx.ui.notify(
				parsed.json
					? parallelSnapshotToJson(snapshot)
					: `Parallel run ${parsed.runId} cancelled (status ${snapshot.run.status}).`,
				"info",
			);
			return;
		}

		const operation: Promise<ParallelRunSnapshot> =
			parsed.action === "resume"
				? coordinator.resume(parsed.runId)
				: parsed.action === "review"
					? coordinator.review(parsed.runId)
					: coordinator.integrate(parsed.runId);
		if (parsed.wait) {
			const snapshot = await operation;
			ctx.ui.notify(renderSnapshot(snapshot, parsed.json), statusNotifyType(snapshot));
			return;
		}
		void operation
			.then(snapshot => ctx.ui.notify(renderSnapshot(snapshot, parsed.json), statusNotifyType(snapshot)))
			.catch(error =>
				ctx.ui.notify(
					`Parallel ${parsed.action} for ${parsed.runId} failed: ${clip(error instanceof Error ? error.message : String(error))}`,
					"warning",
				),
			);
		ctx.ui.notify(
			`Parallel ${parsed.action} started for ${parsed.runId}; ` +
				`it runs in the background \u2014 check /parallel status ${parsed.runId}.`,
			"info",
		);
	};

	pi.registerCommand(PARALLEL_COMMAND_NAME, {
		description: "Run contract-first parallel agent workflows in isolated worktrees",
		getArgumentCompletions: argumentPrefix => parallelArgumentCompletions(argumentPrefix, knownRunIds()),
		async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
			try {
				await handle(args, ctx);
			} catch (error) {
				ctx.ui.notify(
					`Parallel workflows: ${clip(error instanceof Error ? error.message : String(error))}`,
					"warning",
				);
			}
		},
	});
}
