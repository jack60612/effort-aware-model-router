import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const ROUTER_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type RouteEffort = (typeof ROUTER_EFFORTS)[number];
export type RouterThresholds = Partial<Record<RouteEffort, string>>;

export interface RouterConfig {
	enabled: boolean;
	thresholds: RouterThresholds;
	classifierModels: readonly string[];
	maxEffort: RouteEffort;
	classifierTimeoutMs: number;
}

export type RouterConfigLayer = Partial<Omit<RouterConfig, "thresholds">> & {
	thresholds?: RouterThresholds;
};

export interface LoadRouterConfigOptions {
	cwd?: string;
	homeDir?: string;
	env?: Readonly<Record<string, string | undefined>>;
}

export const DEFAULT_ROUTER_CONFIG: Readonly<RouterConfig> = Object.freeze({
	enabled: true,
	thresholds: Object.freeze({
		low: "@smol",
		high: "@slow",
	}),
	classifierModels: Object.freeze(["@tiny", "@smol"]),
	maxEffort: "xhigh",
	classifierTimeoutMs: 4_000,
});

function hasOwn(record: object, key: PropertyKey): boolean {
	return Object.hasOwn(record, key);
}

function isRouteEffort(value: unknown): value is RouteEffort {
	return typeof value === "string" && ROUTER_EFFORTS.some(effort => effort === value);
}

function cleanSelector(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const selector = value.trim();
	return selector.length > 0 ? selector : undefined;
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
			const selector = cleanSelector(inputThresholds[effort]);
			if (selector !== undefined) thresholds[effort] = selector;
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
	return {
		enabled: layer.enabled ?? base.enabled,
		thresholds: { ...base.thresholds, ...layer.thresholds },
		classifierModels: layer.classifierModels ? [...layer.classifierModels] : [...base.classifierModels],
		maxEffort: layer.maxEffort ?? base.maxEffort,
		classifierTimeoutMs: layer.classifierTimeoutMs ?? base.classifierTimeoutMs,
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
		thresholds: { ...DEFAULT_ROUTER_CONFIG.thresholds },
		classifierModels: [...DEFAULT_ROUTER_CONFIG.classifierModels],
		maxEffort: DEFAULT_ROUTER_CONFIG.maxEffort,
		classifierTimeoutMs: DEFAULT_ROUTER_CONFIG.classifierTimeoutMs,
	};
	for (const file of files) {
		config = mergeConfig(config, await readConfigLayer(file));
	}
	return config;
}
