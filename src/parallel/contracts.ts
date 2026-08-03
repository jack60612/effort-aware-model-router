import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";

/** Shared ID grammar for run names, contract IDs, and shard IDs. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Windows drive prefixes are absolute paths even without a leading slash. */
const DRIVE_PREFIX_PATTERN = /^[a-zA-Z]:/;

export const PARALLEL_MAX_CONCURRENCY_MIN = 1;
export const PARALLEL_MAX_CONCURRENCY_MAX = 32;
export const PARALLEL_MODEL_MAX_CHARS = 200;
export const PARALLEL_KIND_MAX_CHARS = 64;
export const PARALLEL_AGENT_MAX_CHARS = 128;
export const PARALLEL_DESCRIPTION_MAX_CHARS = 500;
export const PARALLEL_PROMPT_MAX_CHARS = 20_000;
export const PARALLEL_PATH_MAX_CHARS = 512;

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

function fail(sourcePath: string, message: string): never {
	throw new Error(`Invalid parallel workflow manifest (${sourcePath}): ${message}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read an own property only; inherited values are invisible to validation. */
function ownValue(record: Record<string, unknown>, key: string): unknown {
	return Object.hasOwn(record, key) ? record[key] : undefined;
}

function rejectUnknownKeys(
	record: Record<string, unknown>,
	allowed: readonly string[],
	sourcePath: string,
	label: string,
): void {
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) {
			fail(sourcePath, `${label} has unknown key "${key}"; allowed keys are ${allowed.join(", ")}`);
		}
	}
}

function requireRecord(value: unknown, sourcePath: string, label: string): Record<string, unknown> {
	if (!isPlainRecord(value)) {
		fail(sourcePath, `${label} must be an object mapping, got ${describeValue(value)}`);
	}
	return value;
}

function describeValue(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	return `a ${typeof value}`;
}

function requireString(value: unknown, sourcePath: string, label: string, maxChars: number): string {
	if (typeof value !== "string") {
		fail(sourcePath, `${label} must be a string, got ${describeValue(value)}`);
	}
	const trimmed = value.trim();
	if (trimmed === "") fail(sourcePath, `${label} must not be blank`);
	if (trimmed.length > maxChars) {
		fail(sourcePath, `${label} exceeds the ${maxChars}-character bound (got ${trimmed.length})`);
	}
	return trimmed;
}

function requireId(value: unknown, sourcePath: string, label: string): string {
	if (typeof value !== "string") {
		fail(sourcePath, `${label} must be a string, got ${describeValue(value)}`);
	}
	const trimmed = value.trim();
	if (!ID_PATTERN.test(trimmed)) {
		fail(
			sourcePath,
			`${label} must match ${ID_PATTERN.source} (lowercase letters, digits, and hyphens; 1-64 characters), got "${trimmed}"`,
		);
	}
	return trimmed;
}

function requireStringArray(value: unknown, sourcePath: string, label: string): readonly unknown[] {
	if (!Array.isArray(value)) {
		fail(sourcePath, `${label} must be an array, got ${describeValue(value)}`);
	}
	return value;
}

function requireIdList(value: unknown, sourcePath: string, label: string): string[] {
	const entries = requireStringArray(value, sourcePath, label);
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const [index, entry] of entries.entries()) {
		const id = requireId(entry, sourcePath, `${label}[${index}]`);
		if (seen.has(id)) fail(sourcePath, `${label} lists "${id}" more than once`);
		seen.add(id);
		ids.push(id);
	}
	return ids;
}

/**
 * Normalize one owned path to project-relative POSIX form. Trims whitespace,
 * drops "." segments and empty segments, and rejects absolute paths, drive
 * letters, backslashes, traversal, and paths that normalize to nothing.
 */
function normalizeOwnedPath(value: unknown, sourcePath: string, label: string): string {
	if (typeof value !== "string") {
		fail(sourcePath, `${label} must be a string path, got ${describeValue(value)}`);
	}
	const trimmed = value.trim();
	if (trimmed === "") fail(sourcePath, `${label} must not be blank`);
	if (trimmed.length > PARALLEL_PATH_MAX_CHARS) {
		fail(sourcePath, `${label} exceeds the ${PARALLEL_PATH_MAX_CHARS}-character bound`);
	}
	if (trimmed.includes("\\")) {
		fail(sourcePath, `${label} must use POSIX separators; backslashes are not allowed ("${trimmed}")`);
	}
	if (trimmed.startsWith("/") || DRIVE_PREFIX_PATTERN.test(trimmed)) {
		fail(sourcePath, `${label} must be project-relative; absolute paths are not allowed ("${trimmed}")`);
	}
	const segments = trimmed.split("/").filter(segment => segment !== "" && segment !== ".");
	if (segments.includes("..")) {
		fail(sourcePath, `${label} must not traverse outside the project ("${trimmed}")`);
	}
	if (segments.length === 0) {
		fail(sourcePath, `${label} normalizes to an empty path ("${trimmed}")`);
	}
	return segments.join("/");
}

function validateReview(value: unknown, sourcePath: string, label: string): ParallelReviewSpec {
	const record = requireRecord(value, sourcePath, label);
	rejectUnknownKeys(record, ["agent", "required"], sourcePath, label);
	const agent = requireString(ownValue(record, "agent"), sourcePath, `${label}.agent`, PARALLEL_AGENT_MAX_CHARS);
	const required = ownValue(record, "required");
	if (typeof required !== "boolean") {
		fail(sourcePath, `${label}.required must be a boolean, got ${describeValue(required)}`);
	}
	return { agent, required };
}

function validateContract(value: unknown, sourcePath: string, label: string): ParallelContractSpec {
	const record = requireRecord(value, sourcePath, label);
	rejectUnknownKeys(record, ["id", "description", "owner"], sourcePath, label);
	return {
		id: requireId(ownValue(record, "id"), sourcePath, `${label}.id`),
		description: requireString(
			ownValue(record, "description"),
			sourcePath,
			`${label}.description`,
			PARALLEL_DESCRIPTION_MAX_CHARS,
		),
		owner: requireId(ownValue(record, "owner"), sourcePath, `${label}.owner`),
	};
}

function validateShard(value: unknown, sourcePath: string, label: string): ParallelShardSpec {
	const record = requireRecord(value, sourcePath, label);
	rejectUnknownKeys(
		record,
		["id", "kind", "agent", "prompt", "owns", "produces", "requires", "dependsOn", "review"],
		sourcePath,
		label,
	);
	const owns: string[] = [];
	const seenOwns = new Set<string>();
	for (const [index, entry] of requireStringArray(ownValue(record, "owns"), sourcePath, `${label}.owns`).entries()) {
		const normalized = normalizeOwnedPath(entry, sourcePath, `${label}.owns[${index}]`);
		if (seenOwns.has(normalized)) {
			fail(sourcePath, `${label}.owns lists "${normalized}" more than once`);
		}
		seenOwns.add(normalized);
		owns.push(normalized);
	}
	const shard: ParallelShardSpec = {
		id: requireId(ownValue(record, "id"), sourcePath, `${label}.id`),
		kind: requireString(ownValue(record, "kind"), sourcePath, `${label}.kind`, PARALLEL_KIND_MAX_CHARS),
		agent: requireString(ownValue(record, "agent"), sourcePath, `${label}.agent`, PARALLEL_AGENT_MAX_CHARS),
		prompt: requireString(ownValue(record, "prompt"), sourcePath, `${label}.prompt`, PARALLEL_PROMPT_MAX_CHARS),
		owns,
		produces: requireIdList(ownValue(record, "produces"), sourcePath, `${label}.produces`),
		requires: requireIdList(ownValue(record, "requires"), sourcePath, `${label}.requires`),
		dependsOn: requireIdList(ownValue(record, "dependsOn"), sourcePath, `${label}.dependsOn`),
	};
	const review = ownValue(record, "review");
	if (review !== undefined) shard.review = validateReview(review, sourcePath, `${label}.review`);
	return shard;
}

function validateContractOwnership(
	contracts: readonly ParallelContractSpec[],
	shardsById: ReadonlyMap<string, ParallelShardSpec>,
	sourcePath: string,
): void {
	const contractsById = new Map<string, ParallelContractSpec>();
	for (const contract of contracts) {
		if (contractsById.has(contract.id)) {
			fail(sourcePath, `contract "${contract.id}" is declared more than once`);
		}
		contractsById.set(contract.id, contract);
	}
	for (const contract of contracts) {
		const owner = shardsById.get(contract.owner);
		if (owner === undefined) {
			fail(sourcePath, `contract "${contract.id}" names unknown owner shard "${contract.owner}"`);
		}
		if (!owner.produces.includes(contract.id)) {
			fail(
				sourcePath,
				`contract "${contract.id}" is owned by shard "${contract.owner}" but that shard does not list it in produces`,
			);
		}
	}
	for (const shard of shardsById.values()) {
		for (const produced of shard.produces) {
			const contract = contractsById.get(produced);
			if (contract === undefined) {
				fail(sourcePath, `shard "${shard.id}" produces unknown contract "${produced}"`);
			}
			if (contract.owner !== shard.id) {
				fail(
					sourcePath,
					`shard "${shard.id}" produces contract "${produced}" owned by shard "${contract.owner}"`,
				);
			}
		}
		for (const required of shard.requires) {
			const contract = contractsById.get(required);
			if (contract === undefined) {
				fail(sourcePath, `shard "${shard.id}" requires unknown contract "${required}"`);
			}
			if (!shard.dependsOn.includes(contract.owner)) {
				fail(
					sourcePath,
					`shard "${shard.id}" requires contract "${required}" but does not list its owner "${contract.owner}" in dependsOn; implicit dependency edges are rejected`,
				);
			}
		}
	}
}

function validateDependencies(shards: readonly ParallelShardSpec[], sourcePath: string): void {
	const shardIds = new Set(shards.map(shard => shard.id));
	for (const shard of shards) {
		for (const dependency of shard.dependsOn) {
			if (dependency === shard.id) {
				fail(sourcePath, `shard "${shard.id}" depends on itself`);
			}
			if (!shardIds.has(dependency)) {
				fail(sourcePath, `shard "${shard.id}" depends on unknown shard "${dependency}"`);
			}
		}
	}
	const resolved = new Set<string>();
	let remaining = shards;
	while (remaining.length > 0) {
		const next = remaining.filter(shard => !shard.dependsOn.every(dependency => resolved.has(dependency)));
		if (next.length === remaining.length) {
			const cycle = remaining.map(shard => shard.id).join(", ");
			fail(sourcePath, `dependency cycle detected involving shards: ${cycle}`);
		}
		for (const shard of remaining) {
			if (shard.dependsOn.every(dependency => resolved.has(dependency))) resolved.add(shard.id);
		}
		remaining = next;
	}
}

function validateOwnershipOverlap(shards: readonly ParallelShardSpec[], sourcePath: string): void {
	const ownerByPath = new Map<string, string>();
	const claimedPrefixes = new Map<string, string>();
	for (const shard of shards) {
		for (const owned of shard.owns) {
			const existing = ownerByPath.get(owned);
			if (existing !== undefined) {
				fail(sourcePath, `path "${owned}" is owned by both shard "${existing}" and shard "${shard.id}"`);
			}
			ownerByPath.set(owned, shard.id);
		}
	}
	for (const [owned, ownerId] of ownerByPath) {
		const segments = owned.split("/");
		for (let end = 1; end < segments.length; end += 1) {
			const prefix = segments.slice(0, end).join("/");
			const prefixOwner = ownerByPath.get(prefix);
			if (prefixOwner !== undefined) {
				fail(
					sourcePath,
					`path "${owned}" (shard "${ownerId}") overlaps ancestor path "${prefix}" (shard "${prefixOwner}")`,
				);
			}
			if (!claimedPrefixes.has(prefix)) claimedPrefixes.set(prefix, ownerId);
		}
	}
	for (const [owned, ownerId] of ownerByPath) {
		const descendantOwner = claimedPrefixes.get(owned);
		if (descendantOwner !== undefined && descendantOwner !== ownerId) {
			fail(
				sourcePath,
				`path "${owned}" (shard "${ownerId}") overlaps a descendant path owned by shard "${descendantOwner}"`,
			);
		}
	}
}

function deepFreezePlan(plan: ParallelWorkflowPlan): ParallelWorkflowPlan {
	for (const contract of plan.contracts) Object.freeze(contract);
	Object.freeze(plan.contracts);
	for (const shard of plan.shards) {
		Object.freeze(shard.owns);
		Object.freeze(shard.produces);
		Object.freeze(shard.requires);
		Object.freeze(shard.dependsOn);
		if (shard.review !== undefined) Object.freeze(shard.review);
		Object.freeze(shard);
	}
	Object.freeze(plan.shards);
	return Object.freeze(plan);
}

/**
 * Serialize one normalized manifest into its canonical JSON representation.
 * Key order is fixed, optional fields are omitted when absent, and every
 * collection keeps stable manifest order, so equivalent normalized manifests
 * always produce byte-identical output.
 */
export function canonicalParallelPlan(plan: ParallelWorkflowManifest): string {
	return JSON.stringify({
		run: plan.run,
		...(plan.model === undefined ? {} : { model: plan.model }),
		maxConcurrency: plan.maxConcurrency,
		contracts: plan.contracts.map(contract => ({
			id: contract.id,
			description: contract.description,
			owner: contract.owner,
		})),
		shards: plan.shards.map(shard => ({
			id: shard.id,
			kind: shard.kind,
			agent: shard.agent,
			prompt: shard.prompt,
			owns: [...shard.owns],
			produces: [...shard.produces],
			requires: [...shard.requires],
			dependsOn: [...shard.dependsOn],
			...(shard.review === undefined
				? {}
				: { review: { agent: shard.review.agent, required: shard.review.required } }),
		})),
	});
}

/** Validate one untrusted manifest value and return the immutable hashed plan. */
export function validateParallelWorkflowManifest(input: unknown, sourcePath: string): ParallelWorkflowPlan {
	const record = requireRecord(input, sourcePath, "manifest");
	rejectUnknownKeys(record, ["run", "model", "maxConcurrency", "contracts", "shards"], sourcePath, "manifest");

	const run = requireId(ownValue(record, "run"), sourcePath, "run");
	const modelValue = ownValue(record, "model");
	const model =
		modelValue === undefined
			? undefined
			: requireString(modelValue, sourcePath, "model", PARALLEL_MODEL_MAX_CHARS);
	const maxConcurrency = ownValue(record, "maxConcurrency");
	if (
		typeof maxConcurrency !== "number" ||
		!Number.isInteger(maxConcurrency) ||
		maxConcurrency < PARALLEL_MAX_CONCURRENCY_MIN ||
		maxConcurrency > PARALLEL_MAX_CONCURRENCY_MAX
	) {
		fail(
			sourcePath,
			`maxConcurrency must be an integer from ${PARALLEL_MAX_CONCURRENCY_MIN} through ${PARALLEL_MAX_CONCURRENCY_MAX}, got ${JSON.stringify(maxConcurrency)}`,
		);
	}

	const contractEntries = requireStringArray(ownValue(record, "contracts"), sourcePath, "contracts");
	const contracts = contractEntries.map((entry, index) => validateContract(entry, sourcePath, `contracts[${index}]`));

	const shardEntries = requireStringArray(ownValue(record, "shards"), sourcePath, "shards");
	if (shardEntries.length === 0) fail(sourcePath, "shards must declare at least one shard");
	const shards = shardEntries.map((entry, index) => validateShard(entry, sourcePath, `shards[${index}]`));

	const shardsById = new Map<string, ParallelShardSpec>();
	for (const shard of shards) {
		if (shardsById.has(shard.id)) fail(sourcePath, `shard "${shard.id}" is declared more than once`);
		shardsById.set(shard.id, shard);
	}

	validateContractOwnership(contracts, shardsById, sourcePath);
	validateDependencies(shards, sourcePath);
	validateOwnershipOverlap(shards, sourcePath);

	const manifest: ParallelWorkflowManifest = {
		run,
		...(model === undefined ? {} : { model }),
		maxConcurrency,
		contracts,
		shards,
	};
	const planHash = createHash("sha256").update(canonicalParallelPlan(manifest)).digest("hex");
	return deepFreezePlan({ ...manifest, sourcePath, planHash });
}

/** Parse one YAML (or JSON-shaped) manifest document and validate it. */
export function parseParallelWorkflowManifest(text: string, sourcePath: string): ParallelWorkflowPlan {
	let value: unknown;
	try {
		value = Bun.YAML.parse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		fail(sourcePath, `unable to parse YAML: ${message}`);
	}
	return validateParallelWorkflowManifest(value, sourcePath);
}

/** Read one manifest file from disk, then parse and validate it. */
export async function loadParallelWorkflowManifest(sourcePath: string): Promise<ParallelWorkflowPlan> {
	let text: string;
	try {
		text = await fs.readFile(sourcePath, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		fail(sourcePath, `unable to read manifest file: ${message}`);
	}
	return parseParallelWorkflowManifest(text, sourcePath);
}

/**
 * Group shards into dependency waves: every shard in wave N depends only on
 * shards in earlier waves. Wave membership keeps stable manifest shard order.
 */
export function getParallelDependencyWaves(plan: ParallelWorkflowPlan): readonly (readonly ParallelShardSpec[])[] {
	const waves: ParallelShardSpec[][] = [];
	const resolved = new Set<string>();
	let remaining = [...plan.shards];
	while (remaining.length > 0) {
		const wave = remaining.filter(shard => shard.dependsOn.every(dependency => resolved.has(dependency)));
		if (wave.length === 0) {
			const cycle = remaining.map(shard => shard.id).join(", ");
			fail(plan.sourcePath, `dependency cycle detected involving shards: ${cycle}`);
		}
		for (const shard of wave) resolved.add(shard.id);
		remaining = remaining.filter(shard => !resolved.has(shard.id));
		waves.push(wave);
	}
	return waves;
}
