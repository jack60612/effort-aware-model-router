import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ROUTER_EFFORTS,
	type RouteEffort,
	type RouterConfig,
	type RouterDelegationConfig,
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
	delegation: RouterDelegationConfig;
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

function parseNonNegativeInteger(value: string): number | undefined {
	const parsed = Number(value.trim());
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function modelSelector(model: RouterSetupModel): string | undefined {
	const provider = model.provider.trim();
	const id = model.id.trim();
	return provider.length > 0 && id.length > 0 ? `${provider}/${id}` : undefined;
}
/** OMP's built-in role aliases; the public model query has no role enumeration. */
export const BUILTIN_MODEL_ROLE_SELECTORS = [
	"@default",
	"@smol",
	"@slow",
	"@vision",
	"@plan",
	"@designer",
	"@commit",
	"@tiny",
	"@task",
	"@advisor",
] as const;

interface CooldownChoice {
	label: string;
	milliseconds: number;
}

const COOLDOWN_CHOICES: readonly CooldownChoice[] = [
	{ label: "No wait — classify every eligible prompt", milliseconds: 0 },
	{ label: "1 second — wait after each classification", milliseconds: 1_000 },
	{ label: "5 seconds — wait after each classification", milliseconds: 5_000 },
	{ label: "30 seconds — wait after each classification", milliseconds: 30_000 },
	{ label: "1 minute — wait after each classification", milliseconds: 60_000 },
	{ label: "5 minutes — wait after each classification", milliseconds: 300_000 },
];

function formatCooldown(milliseconds: number): string {
	if (milliseconds === 0) return "no wait";
	if (milliseconds % 60_000 === 0) {
		const minutes = milliseconds / 60_000;
		return `${minutes} minute${minutes === 1 ? "" : "s"}`;
	}
	if (milliseconds >= 1_000) {
		const seconds = Number((milliseconds / 1_000).toFixed(1));
		return `${seconds} second${seconds === 1 ? "" : "s"}`;
	}
	return `${milliseconds} milliseconds`;
}

function cooldownChoices(current: number): CooldownChoice[] {
	if (COOLDOWN_CHOICES.some(choice => choice.milliseconds === current)) return [...COOLDOWN_CHOICES];
	return [{ label: `Keep current — ${formatCooldown(current)}`, milliseconds: current }, ...COOLDOWN_CHOICES];
}

async function selectOrderedModels(
	context: RouterSetupContext,
	title: string,
	current: readonly string[] | undefined,
	available: readonly string[],
): Promise<string[] | undefined | null> {
	const remaining = [...new Set([...(current ?? []), ...available])];
	const selected: string[] = [];
	while (true) {
		const choice = await context.ui.select(title, [...remaining, "done"]);
		if (choice === undefined) return null;
		if (choice === "done") return selected.length > 0 ? selected : current ? [...current] : undefined;
		if (!remaining.includes(choice)) return undefined;
		selected.push(choice);
		remaining.splice(remaining.indexOf(choice), 1);
		if (remaining.length === 0) return selected;
		if (!(await context.ui.confirm(`Add another ${title.toLowerCase()}?`, "Selections are tried in this order."))) {
			return selected;
		}
	}
}

async function selectThresholdCandidates(
	context: RouterSetupContext,
	effort: RouteEffort,
	current: readonly string[] | undefined,
	available: readonly string[],
): Promise<string[] | undefined | null> {
	return selectOrderedModels(context, `${effort} threshold candidate`, current, available);
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
	const mergedProfiles: Record<string, unknown> = Object.create(null);
	Object.assign(mergedProfiles, existingProfiles);
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
		delegation: {
			...(typeof existing.delegation === "object" && existing.delegation !== null && !Array.isArray(existing.delegation)
				? (existing.delegation as Record<string, unknown>)
				: {}),
			enabled: values.delegation.enabled,
			plannerTimeoutMs: values.delegation.plannerTimeoutMs,
			agents: [...values.delegation.agents],
		},
	};
	await fileSystem.mkdir(path.dirname(file));
	await fileSystem.writeFile(file, `${JSON.stringify(output, null, 2)}\n`);
}

function notify(context: RouterSetupContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	context.ui.notify?.(message, type);
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
		"Skip prompts shorter than this many characters",
		String(config.classifierMinPromptChars),
	);
	if (minimumInput === undefined) return { status: "cancelled" };
	const classifierMinPromptChars = parseNonNegativeInteger(minimumInput);
	if (classifierMinPromptChars === undefined) {
		notify(context, "Minimum prompt length must be a non-negative safe integer", "warning");
		return { status: "error", error: new Error("invalid minimum prompt length") };
	}

	const cooldownSelection = cooldownChoices(config.classifierCooldownMs);
	const cooldownChoice = await context.ui.select(
		"Wait between automatic classifications",
		cooldownSelection.map(choice => choice.label),
	);
	if (cooldownChoice === undefined) return { status: "cancelled" };
	const selectedCooldown = cooldownSelection.find(choice => choice.label === cooldownChoice);
	if (!selectedCooldown) return { status: "error", error: new Error("invalid cooldown choice") };
	const classifierCooldownMs = selectedCooldown.milliseconds;

	const available = [
		...new Set([
			...BUILTIN_MODEL_ROLE_SELECTORS,
			...config.classifierModels,
			...context.models
				.list()
				.map(modelSelector)
				.filter((selector): selector is string => selector !== undefined),
		]),
	];
	const selectedClassifierModels = await selectOrderedModels(
		context,
		"Classifier model candidate",
		config.classifierModels,
		available,
	);
	if (selectedClassifierModels === null) return { status: "cancelled" };
	const classifierModels = selectedClassifierModels ?? [...config.classifierModels];
	if (classifierModels.length === 0) {
		notify(context, "At least one classifier model must be selected", "warning");
		return { status: "error", error: new Error("invalid classifier selectors") };
	}

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

	const profileOptions = [...new Set([...available, ...Object.keys(config.thinkingProfiles)])];
	const profileChoice = await context.ui.select("Optional model-specific thinking profile", [
		"none",
		...profileOptions,
	]);
	if (profileChoice === undefined) return { status: "cancelled" };
	const thinkingProfiles = cloneProfiles(config.thinkingProfiles);
	if (profileChoice !== "none") {
		const normalizedModel = profileChoice.trim();
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

	const delegationEnabled = await context.ui.confirm(
		"Enable self-contained subagent delegation?",
		`Currently ${config.delegation.enabled ? "enabled" : "disabled"}. When enabled, the routed model plans eligible requests and runs them through a subagent.`,
	);

	const values: RouterSetupValues = {
		enabled: enabledChoice === "enabled",
		thresholds,
		classifierModels,
		classifierMinPromptChars,
		classifierCooldownMs,
		thinkingProfiles,
		delegation: {
			enabled: delegationEnabled,
			plannerTimeoutMs: config.delegation.plannerTimeoutMs,
			agents: [...config.delegation.agents],
		},
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
