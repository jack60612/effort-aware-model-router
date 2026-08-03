import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const ROUTER_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type RouteEffort = (typeof ROUTER_EFFORTS)[number];
export type RouterThinkingEffort = "minimal" | RouteEffort;
export type RouterThresholdInput = string | readonly string[];
export type RouterThresholds = Partial<Record<RouteEffort, readonly string[]>>;
export type RouterThinkingProfile = Partial<Record<"default" | RouteEffort, RouterThinkingEffort>>;
export type RouterThinkingProfiles = Record<string, RouterThinkingProfile>;

export const DEFAULT_DELEGATION_AGENTS = [
	"scout",
	"sonic",
	"task",
	"designer",
	"reviewer",
	"security-reviewer",
] as const;

export interface RouterDelegationConfig {
	enabled: boolean;
	plannerTimeoutMs: number;
	agents: readonly string[];
}

export const MAX_DELEGATION_PLANNER_TIMEOUT_MS = 120_000;

export interface RouterConfig {
	enabled: boolean;
	thresholds: RouterThresholds;
	classifierModels: readonly string[];
	maxEffort: RouteEffort;
	classifierTimeoutMs: number;
	classifierMinPromptChars: number;
	classifierCooldownMs: number;
	thinkingProfiles: RouterThinkingProfiles;
	delegation: RouterDelegationConfig;
}

export type RouterConfigLayer = Partial<Omit<RouterConfig, "thresholds" | "thinkingProfiles" | "delegation">> & {
	thresholds?: Partial<Record<RouteEffort, RouterThresholdInput>>;
	thinkingProfiles?: RouterThinkingProfiles;
	delegation?: Partial<RouterDelegationConfig>;
};

export interface LoadRouterConfigOptions {
	cwd?: string;
	homeDir?: string;
	env?: Readonly<Record<string, string | undefined>>;
}

export const DEFAULT_ROUTER_CONFIG: Readonly<RouterConfig> = Object.freeze({
	enabled: true,
	thresholds: Object.freeze({
		low: Object.freeze(["@smol"]),
		high: Object.freeze(["@slow"]),
	}),
	classifierModels: Object.freeze(["@tiny", "@smol"]),
	maxEffort: "xhigh",
	classifierTimeoutMs: 20_000,
	classifierMinPromptChars: 30,
	classifierCooldownMs: 30_000,
	thinkingProfiles: Object.freeze({}),
	delegation: Object.freeze({
		enabled: false,
		plannerTimeoutMs: 20_000,
		agents: Object.freeze([...DEFAULT_DELEGATION_AGENTS]),
	}),
});

function hasOwn(record: object, key: PropertyKey): boolean {
	return Object.hasOwn(record, key);
}

function isRouteEffort(value: unknown): value is RouteEffort {
	return typeof value === "string" && ROUTER_EFFORTS.some(effort => effort === value);
}

function isThinkingEffort(value: unknown): value is RouterThinkingEffort {
	return value === "minimal" || isRouteEffort(value);
}

function isSafeRecordKey(value: string): boolean {
	return value !== "__proto__" && value !== "constructor" && value !== "prototype";
}

function cleanSelector(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const selector = value.trim();
	return selector.length > 0 ? selector : undefined;
}

function cleanSelectors(value: unknown): string[] | undefined {
	if (typeof value === "string") {
		const selector = cleanSelector(value);
		return selector ? [selector] : undefined;
	}
	if (!Array.isArray(value)) return undefined;
	const selectors: string[] = [];
	for (let index = 0; index < value.length; index += 1) {
		if (!hasOwn(value, index)) continue;
		const selector = cleanSelector(value[index]);
		if (selector !== undefined) selectors.push(selector);
	}
	return selectors.length > 0 ? selectors : undefined;
}

/** Validate one untrusted config object without reading inherited properties. */
export function parseRouterConfigLayer(value: unknown): RouterConfigLayer {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const input = value as Record<string, unknown>;

	const layer: RouterConfigLayer = {};
	if (hasOwn(input, "enabled") && typeof input.enabled === "boolean") {
		layer.enabled = input.enabled;
	}

	if (
		hasOwn(input, "thresholds") &&
		typeof input.thresholds === "object" &&
		input.thresholds !== null &&
		!Array.isArray(input.thresholds)
	) {
		const inputThresholds = input.thresholds as Record<string, unknown>;
		const thresholds: RouterThresholds = {};
		for (const effort of ROUTER_EFFORTS) {
			if (!hasOwn(inputThresholds, effort)) continue;
			const selectors = cleanSelectors(inputThresholds[effort]);
			if (selectors !== undefined) thresholds[effort] = selectors;
		}
		layer.thresholds = thresholds;
	}

	if (hasOwn(input, "classifierModels") && Array.isArray(input.classifierModels)) {
		const classifierModels: string[] = [];
		for (let index = 0; index < input.classifierModels.length; index += 1) {
			if (!hasOwn(input.classifierModels, index)) continue;
			const selector = cleanSelector(input.classifierModels[index]);
			if (selector !== undefined) classifierModels.push(selector);
		}
		if (classifierModels.length > 0) layer.classifierModels = classifierModels;
	}

	if (hasOwn(input, "maxEffort") && isRouteEffort(input.maxEffort)) {
		layer.maxEffort = input.maxEffort;
	}

	if (
		hasOwn(input, "classifierTimeoutMs") &&
		typeof input.classifierTimeoutMs === "number" &&
		Number.isSafeInteger(input.classifierTimeoutMs) &&
		input.classifierTimeoutMs > 0
	) {
		layer.classifierTimeoutMs = input.classifierTimeoutMs;
	}

	for (const field of ["classifierMinPromptChars", "classifierCooldownMs"] as const) {
		if (
			hasOwn(input, field) &&
			typeof input[field] === "number" &&
			Number.isSafeInteger(input[field]) &&
			input[field] >= 0
		) {
			layer[field] = input[field];
		}
	}

	if (
		hasOwn(input, "thinkingProfiles") &&
		typeof input.thinkingProfiles === "object" &&
		input.thinkingProfiles !== null &&
		!Array.isArray(input.thinkingProfiles)
	) {
		const profiles: RouterThinkingProfiles = {};
		const inputProfiles = input.thinkingProfiles as Record<string, unknown>;
		for (const [modelKey, rawProfile] of Object.entries(inputProfiles)) {
			if (!hasOwn(inputProfiles, modelKey) || !isSafeRecordKey(modelKey)) continue;
			const normalizedModelKey = cleanSelector(modelKey);
			if (!normalizedModelKey || !isSafeRecordKey(normalizedModelKey)) continue;
			if (typeof rawProfile !== "object" || rawProfile === null || Array.isArray(rawProfile)) continue;
			const profile: RouterThinkingProfile = {};
			const inputProfile = rawProfile as Record<string, unknown>;
			for (const key of ["default", ...ROUTER_EFFORTS] as const) {
				if (!hasOwn(inputProfile, key)) continue;
				const effort = typeof inputProfile[key] === "string" ? inputProfile[key].trim() : undefined;
				if (!isThinkingEffort(effort)) continue;
				profile[key] = effort;
			}
			if (Object.keys(profile).length > 0) profiles[normalizedModelKey] = profile;
		}
		layer.thinkingProfiles = profiles;
	}

	if (
		hasOwn(input, "delegation") &&
		typeof input.delegation === "object" &&
		input.delegation !== null &&
		!Array.isArray(input.delegation)
	) {
		const inputDelegation = input.delegation as Record<string, unknown>;
		const delegation: Partial<RouterDelegationConfig> = {};
		if (hasOwn(inputDelegation, "enabled") && typeof inputDelegation.enabled === "boolean") {
			delegation.enabled = inputDelegation.enabled;
		}
		if (
			hasOwn(inputDelegation, "plannerTimeoutMs") &&
			typeof inputDelegation.plannerTimeoutMs === "number" &&
			Number.isSafeInteger(inputDelegation.plannerTimeoutMs) &&
			inputDelegation.plannerTimeoutMs > 0 &&
			inputDelegation.plannerTimeoutMs <= MAX_DELEGATION_PLANNER_TIMEOUT_MS
		) {
			delegation.plannerTimeoutMs = inputDelegation.plannerTimeoutMs;
		}
		if (hasOwn(inputDelegation, "agents")) {
			const agents = cleanSelectors(inputDelegation.agents);
			if (agents !== undefined) delegation.agents = agents;
		}
		layer.delegation = delegation;
	}

	return layer;
}

async function readConfigLayer(file: string): Promise<RouterConfigLayer> {
	try {
		const contents = await fs.readFile(file, "utf8");
		return parseRouterConfigLayer(JSON.parse(contents) as unknown);
	} catch {
		return {};
	}
}

function mergeConfig(base: RouterConfig, layer: RouterConfigLayer): RouterConfig {
	const thinkingProfiles: RouterThinkingProfiles = {};
	for (const [modelKey, profile] of Object.entries(base.thinkingProfiles)) {
		if (!isSafeRecordKey(modelKey)) continue;
		thinkingProfiles[modelKey] = { ...profile };
	}
	for (const [modelKey, profile] of Object.entries(layer.thinkingProfiles ?? {})) {
		if (!isSafeRecordKey(modelKey)) continue;
		thinkingProfiles[modelKey] = {
			...thinkingProfiles[modelKey],
			...profile,
		};
	}
	return {
		enabled: layer.enabled ?? base.enabled,
		thresholds: Object.fromEntries(
			ROUTER_EFFORTS.flatMap(effort =>
				(base.thresholds[effort] ?? layer.thresholds?.[effort])
					? [[effort, [...(layer.thresholds?.[effort] ?? base.thresholds[effort]!)] as readonly string[]]]
					: [],
			),
		) as RouterThresholds,
		classifierModels: layer.classifierModels ? [...layer.classifierModels] : [...base.classifierModels],
		maxEffort: layer.maxEffort ?? base.maxEffort,
		classifierTimeoutMs: layer.classifierTimeoutMs ?? base.classifierTimeoutMs,
		classifierMinPromptChars: layer.classifierMinPromptChars ?? base.classifierMinPromptChars,
		classifierCooldownMs: layer.classifierCooldownMs ?? base.classifierCooldownMs,
		thinkingProfiles,
		delegation: {
			enabled: layer.delegation?.enabled ?? base.delegation.enabled,
			plannerTimeoutMs: layer.delegation?.plannerTimeoutMs ?? base.delegation.plannerTimeoutMs,
			agents: [...(layer.delegation?.agents ?? base.delegation.agents)],
		},
	};
}

/** Load defaults, then user, project, and optional explicit config layers. */
export async function loadRouterConfig(options: LoadRouterConfigOptions = {}): Promise<RouterConfig> {
	const cwd = options.cwd ?? process.cwd();
	const homeDir = options.homeDir ?? os.homedir();
	const env = options.env ?? process.env;
	const files = [
		path.join(homeDir, ".omp", "agent", "model-router.json"),
		path.join(cwd, ".omp", "model-router.json"),
	];
	const explicitPath = cleanSelector(env.OMP_MODEL_ROUTER_CONFIG);
	if (explicitPath !== undefined) files.push(path.resolve(cwd, explicitPath));

	let config: RouterConfig = {
		enabled: DEFAULT_ROUTER_CONFIG.enabled,
		thresholds: Object.fromEntries(
			ROUTER_EFFORTS.flatMap(effort =>
				DEFAULT_ROUTER_CONFIG.thresholds[effort] ? [[effort, [...DEFAULT_ROUTER_CONFIG.thresholds[effort]!]]] : [],
			),
		) as RouterThresholds,
		classifierModels: [...DEFAULT_ROUTER_CONFIG.classifierModels],
		maxEffort: DEFAULT_ROUTER_CONFIG.maxEffort,
		classifierTimeoutMs: DEFAULT_ROUTER_CONFIG.classifierTimeoutMs,
		classifierMinPromptChars: DEFAULT_ROUTER_CONFIG.classifierMinPromptChars,
		classifierCooldownMs: DEFAULT_ROUTER_CONFIG.classifierCooldownMs,
		thinkingProfiles: {},
		delegation: {
			enabled: DEFAULT_ROUTER_CONFIG.delegation.enabled,
			plannerTimeoutMs: DEFAULT_ROUTER_CONFIG.delegation.plannerTimeoutMs,
			agents: [...DEFAULT_ROUTER_CONFIG.delegation.agents],
		},
	};
	for (const file of files) {
		config = mergeConfig(config, await readConfigLayer(file));
	}
	return config;
}
