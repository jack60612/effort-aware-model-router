import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ROUTER_EFFORTS,
	type RouteEffort,
	type RouterConfig,
	type RouterThinkingEffort,
	type RouterThinkingProfiles,
	type RouterThresholds,
} from "./config";

export interface RouterSetupModel {
	provider: string;
	id: string;
	name?: string;
}

export interface RouterSetupUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	notify?(message: string, type?: "info" | "warning" | "error"): void;
}

export interface RouterSetupContext {
	cwd: string;
	homeDir?: string;
	hasUI: boolean;
	ui: RouterSetupUI;
	models: { list(): readonly RouterSetupModel[] };
}

export interface RouterSetupValues {
	enabled: boolean;
	thresholds: RouterThresholds;
	classifierModels: readonly string[];
	classifierMinPromptChars: number;
	classifierCooldownMs: number;
	thinkingProfiles: RouterThinkingProfiles;
}

export interface RouterSetupFileSystem {
	readFile(file: string): Promise<string>;
	writeFile(file: string, contents: string): Promise<void>;
	mkdir(directory: string): Promise<void>;
}

export type RouterSetupResult =
	| { status: "written"; path: string }
	| { status: "cancelled" | "unsupported" }
	| { status: "error"; error: Error };

const nodeFileSystem: RouterSetupFileSystem = {
	readFile: file => fs.readFile(file, "utf8"),
	writeFile: (file, contents) => fs.writeFile(file, contents, "utf8"),
	mkdir: directory => fs.mkdir(directory, { recursive: true }).then(() => undefined),
};

function configPath(scope: "user" | "project", cwd: string, homeDir: string): string {
	return scope === "user"
		? path.join(homeDir, ".omp", "agent", "model-router.json")
		: path.join(cwd, ".omp", "model-router.json");
}

function selectorsFromInput(value: string): string[] | undefined {
	const selectors = value
		.split(/[\n,]/u)
		.map(selector => selector.trim())
		.filter(selector => selector.length > 0);
	return selectors.length > 0 ? selectors : undefined;
}

function parseNonNegativeInteger(value: string): number | undefined {
	const parsed = Number(value.trim());
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function modelSelector(model: RouterSetupModel): string | undefined {
	const provider = model.provider.trim();
	const id = model.id.trim();
	return provider.length > 0 && id.length > 0 ? `${provider}/${id}` : undefined;
}

function cloneThresholds(thresholds: RouterThresholds): RouterThresholds {
	return Object.fromEntries(
		Object.entries(thresholds).map(([effort, candidates]) => [effort, [...(candidates ?? [])]]),
	) as RouterThresholds;
}

function cloneProfiles(profiles: RouterThinkingProfiles): RouterThinkingProfiles {
	return Object.fromEntries(Object.entries(profiles).map(([modelKey, profile]) => [modelKey, { ...profile }]));
}

/** Write only router-owned fields while preserving unrelated JSON data. */
export async function writeRouterConfigLayer(
	file: string,
	values: RouterSetupValues,
	fileSystem: RouterSetupFileSystem = nodeFileSystem,
): Promise<void> {
	let existing: Record<string, unknown> = {};
	try {
		const raw = await fileSystem.readFile(file);
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("existing model-router config is not a JSON object");
		}
		existing = parsed as Record<string, unknown>;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			existing = {};
		} else {
			throw new Error(`model-router: refusing to overwrite invalid config ${file}`, { cause: error });
		}
	}

	const existingThresholds =
		typeof existing.thresholds === "object" && existing.thresholds !== null && !Array.isArray(existing.thresholds)
			? (existing.thresholds as Record<string, unknown>)
			: {};
	const existingProfiles =
		typeof existing.thinkingProfiles === "object" &&
		existing.thinkingProfiles !== null &&
		!Array.isArray(existing.thinkingProfiles)
			? (existing.thinkingProfiles as Record<string, unknown>)
			: {};
	const mergedProfiles: Record<string, unknown> = { ...existingProfiles };
	for (const [modelKey, profile] of Object.entries(values.thinkingProfiles)) {
		const previous =
			typeof mergedProfiles[modelKey] === "object" &&
			mergedProfiles[modelKey] !== null &&
			!Array.isArray(mergedProfiles[modelKey])
				? (mergedProfiles[modelKey] as Record<string, unknown>)
				: {};
		mergedProfiles[modelKey] = { ...previous, ...profile };
	}
	const output = {
		...existing,
		enabled: values.enabled,
		thresholds: { ...existingThresholds, ...cloneThresholds(values.thresholds) },
		classifierModels: [...values.classifierModels],
		classifierMinPromptChars: values.classifierMinPromptChars,
		classifierCooldownMs: values.classifierCooldownMs,
		thinkingProfiles: mergedProfiles,
	};
	await fileSystem.mkdir(path.dirname(file));
	await fileSystem.writeFile(file, `${JSON.stringify(output, null, 2)}\n`);
}

function notify(context: RouterSetupContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	context.ui.notify?.(message, type);
}

async function selectThresholdCandidates(
	context: RouterSetupContext,
	effort: RouteEffort,
	current: readonly string[] | undefined,
	available: readonly string[],
): Promise<string[] | undefined | null> {
	const candidates: string[] = [];
	while (true) {
		const selected = await context.ui.select(`${effort} threshold candidate`, [
			...available,
			"custom selector",
			"done",
		]);
		if (selected === undefined) return null;
		if (selected === "done") break;
		if (selected === "custom selector") {
			const custom = await context.ui.input(
				`Custom ${effort} selector(s)`,
				current?.join(", ") ?? "provider/model, fallback/provider-model",
			);
			if (custom === undefined) return null;
			const parsed = selectorsFromInput(custom);
			if (!parsed) {
				notify(context, `No valid selectors were entered for the ${effort} threshold`, "warning");
				return undefined;
			}
			candidates.push(...parsed);
		} else {
			candidates.push(selected);
		}
		if (!(await context.ui.confirm(`Add another ${effort} candidate?`, "Candidates are tried in this order."))) break;
	}
	return candidates.length > 0 ? candidates : undefined;
}

/** Run the public-dialog setup flow and write only after final confirmation. */
export async function runRouterSetup(
	context: RouterSetupContext,
	config: RouterConfig,
	options: { fileSystem?: RouterSetupFileSystem } = {},
): Promise<RouterSetupResult> {
	if (
		!context.hasUI ||
		!context.ui ||
		typeof context.ui.select !== "function" ||
		typeof context.ui.input !== "function" ||
		typeof context.ui.confirm !== "function"
	) {
		notify(context, "Model router setup requires an interactive UI surface", "warning");
		return { status: "unsupported" };
	}

	const scope = await context.ui.select("Model router config scope", ["project", "user"]);
	if (scope === undefined) return { status: "cancelled" };
	if (scope !== "project" && scope !== "user") return { status: "error", error: new Error("invalid config scope") };

	const enabledChoice = await context.ui.select("Automatic routing", ["enabled", "disabled"]);
	if (enabledChoice === undefined) return { status: "cancelled" };
	if (enabledChoice !== "enabled" && enabledChoice !== "disabled") {
		return { status: "error", error: new Error("invalid enabled choice") };
	}

	const minimumInput = await context.ui.input(
		"Minimum prompt length before classification",
		String(config.classifierMinPromptChars),
	);
	if (minimumInput === undefined) return { status: "cancelled" };
	const classifierMinPromptChars = parseNonNegativeInteger(minimumInput);
	if (classifierMinPromptChars === undefined) {
		notify(context, "Minimum prompt length must be a non-negative safe integer", "warning");
		return { status: "error", error: new Error("invalid minimum prompt length") };
	}

	const cooldownInput = await context.ui.input(
		"Classifier cooldown in milliseconds",
		String(config.classifierCooldownMs),
	);
	if (cooldownInput === undefined) return { status: "cancelled" };
	const classifierCooldownMs = parseNonNegativeInteger(cooldownInput);
	if (classifierCooldownMs === undefined) {
		notify(context, "Classifier cooldown must be a non-negative safe integer", "warning");
		return { status: "error", error: new Error("invalid classifier cooldown") };
	}

	const classifierInput = await context.ui.input(
		"Classifier model selectors (comma-separated, in priority order)",
		config.classifierModels.join(", "),
	);
	if (classifierInput === undefined) return { status: "cancelled" };
	const classifierModels = selectorsFromInput(classifierInput);
	if (!classifierModels) {
		notify(context, "At least one classifier selector is required", "warning");
		return { status: "error", error: new Error("invalid classifier selectors") };
	}

	const available = [
		...new Set(
			context.models
				.list()
				.map(modelSelector)
				.filter((selector): selector is string => selector !== undefined),
		),
	];
	const thresholds = cloneThresholds(config.thresholds);
	while (true) {
		const currentSummary = ROUTER_EFFORTS.map(
			effort => `${effort}=${thresholds[effort]?.join(" → ") ?? "unset"}`,
		).join(", ");
		const effort = await context.ui.select(`Choose a threshold to configure (${currentSummary})`, [
			"done",
			...ROUTER_EFFORTS,
		]);
		if (effort === undefined) return { status: "cancelled" };
		if (effort === "done") break;
		if (!ROUTER_EFFORTS.some(candidate => candidate === effort)) {
			return { status: "error", error: new Error("invalid threshold choice") };
		}
		const selectedEffort = effort as RouteEffort;
		const candidates = await selectThresholdCandidates(
			context,
			selectedEffort,
			thresholds[selectedEffort],
			available,
		);
		if (candidates === null) return { status: "cancelled" };
		if (candidates === undefined && thresholds[selectedEffort] === undefined) {
			notify(context, `No candidates configured for the ${selectedEffort} threshold`, "warning");
			return { status: "error", error: new Error("missing threshold candidates") };
		}
		if (candidates !== undefined) thresholds[selectedEffort] = candidates;
	}

	const profileChoice = await context.ui.select("Optional model-specific thinking profile", [
		"none",
		...available,
		"custom selector",
	]);
	if (profileChoice === undefined) return { status: "cancelled" };
	const thinkingProfiles = cloneProfiles(config.thinkingProfiles);
	if (profileChoice !== "none") {
		const profileModel =
			profileChoice === "custom selector"
				? await context.ui.input("Model identity for thinking profile", "provider/model")
				: profileChoice;
		if (profileModel === undefined) return { status: "cancelled" };
		const normalizedModel = profileModel.trim();
		if (normalizedModel.length === 0) {
			return { status: "error", error: new Error("invalid thinking profile model") };
		}
		const profile: Record<string, RouterThinkingEffort> = {};
		const defaultEffort = await context.ui.select("Default thinking effort", ["minimal", ...ROUTER_EFFORTS]);
		if (defaultEffort === undefined) return { status: "cancelled" };
		if (!(["minimal", ...ROUTER_EFFORTS] as string[]).includes(defaultEffort)) {
			return { status: "error", error: new Error("invalid profile default") };
		}
		profile.default = defaultEffort as RouterThinkingEffort;
		for (const override of ["xhigh", "max"] as const) {
			const selected = await context.ui.select(`${override} thinking override`, [
				"inherit",
				"minimal",
				...ROUTER_EFFORTS,
			]);
			if (selected === undefined) return { status: "cancelled" };
			if (selected !== "inherit") {
				if (!(["minimal", ...ROUTER_EFFORTS] as string[]).includes(selected)) {
					return { status: "error", error: new Error(`invalid ${override} profile override`) };
				}
				profile[override] = selected as RouterThinkingEffort;
			}
		}
		thinkingProfiles[normalizedModel] = profile;
	}

	const values: RouterSetupValues = {
		enabled: enabledChoice === "enabled",
		thresholds,
		classifierModels,
		classifierMinPromptChars,
		classifierCooldownMs,
		thinkingProfiles,
	};
	const summary = JSON.stringify(values, null, 2);
	if (!(await context.ui.confirm("Write model router configuration?", summary))) return { status: "cancelled" };

	const file = configPath(scope, context.cwd, context.homeDir ?? os.homedir());
	try {
		await writeRouterConfigLayer(file, values, options.fileSystem);
	} catch (error) {
		const cause = error instanceof Error ? error : new Error(String(error));
		notify(context, cause.message, "error");
		return { status: "error", error: cause };
	}
	notify(context, `Model router configuration written to ${file}`);
	return { status: "written", path: file };
}
