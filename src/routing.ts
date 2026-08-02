import { ROUTER_EFFORTS, type RouteEffort } from "./config";

export type ThinkingEffort = "minimal" | RouteEffort;

export interface RoutableModel {
	provider: string;
	id: string;
	name?: string;
	reasoning: boolean;
	thinking?: {
		efforts?: readonly string[];
	};
	contextWindow: number | null;
}

const THINKING_EFFORTS: readonly ThinkingEffort[] = ["minimal", ...ROUTER_EFFORTS];

/** Select exactly one route: the greatest configured threshold not above the classified effort. */
export function selectThresholdSelector(classified: RouteEffort, thresholds: unknown): string | undefined {
	if (typeof thresholds !== "object" || thresholds === null || Array.isArray(thresholds)) return undefined;
	const values = thresholds as Record<string, unknown>;
	const classifiedIndex = ROUTER_EFFORTS.indexOf(classified);
	for (let index = classifiedIndex; index >= 0; index -= 1) {
		const effort = ROUTER_EFFORTS[index];
		if (!Object.hasOwn(values, effort)) continue;
		const selector = values[effort];
		if (typeof selector === "string" && selector.trim().length > 0) return selector.trim();
	}
	return undefined;
}

/** Format the selector understood by OMP's public model resolver. */
export function formatModelSelector(model: Pick<RoutableModel, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

/** Compare the stable model identity rather than model object or display-name identity. */
export function modelsEqual(
	left: Pick<RoutableModel, "provider" | "id"> | undefined,
	right: Pick<RoutableModel, "provider" | "id"> | undefined,
): boolean {
	if (left === undefined || right === undefined) return left === right;
	return left.provider === right.provider && left.id === right.id;
}

/** Clamp a classified effort to the target model's explicit controllable effort surface. */
export function clampEffortToModel(
	requested: RouteEffort,
	model: RoutableModel | undefined,
): ThinkingEffort | undefined {
	if (model?.reasoning !== true || !Array.isArray(model.thinking?.efforts)) return undefined;

	const supported: Partial<Record<ThinkingEffort, true>> = {};
	for (const effort of model.thinking.efforts) {
		if (THINKING_EFFORTS.some(candidate => candidate === effort)) supported[effort as ThinkingEffort] = true;
	}
	if (supported[requested]) return requested;

	const requestedIndex = THINKING_EFFORTS.indexOf(requested);
	for (let index = requestedIndex; index >= 0; index -= 1) {
		const effort = THINKING_EFFORTS[index];
		if (supported[effort]) return effort;
	}
	for (const effort of THINKING_EFFORTS) {
		if (supported[effort]) return effort;
	}
	return undefined;
}

/** Approximate prompt tokens without invoking a provider tokenizer. */
export function estimatePromptTokens(prompt: string): number {
	return Math.ceil(prompt.length / 4);
}

/** Check whether existing context plus the estimated incoming prompt fits the target window. */
export function hasContextCapacity(
	model: Pick<RoutableModel, "contextWindow">,
	contextTokens: number,
	promptTokens: number,
): boolean {
	const contextWindow = model.contextWindow;
	if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return false;
	if (!Number.isFinite(contextTokens) || contextTokens < 0) return false;
	if (!Number.isFinite(promptTokens) || promptTokens < 0) return false;
	return contextTokens + promptTokens <= contextWindow;
}
