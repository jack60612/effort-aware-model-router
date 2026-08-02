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

/** Select the nearest configured threshold and preserve its ordered candidates. */
export function selectThresholdCandidates(classified: RouteEffort, thresholds: unknown): string[] {
	if (typeof thresholds !== "object" || thresholds === null || Array.isArray(thresholds)) return [];
	const values = thresholds as Record<string, unknown>;
	const classifiedIndex = ROUTER_EFFORTS.indexOf(classified);
	for (let index = classifiedIndex; index >= 0; index -= 1) {
		const effort = ROUTER_EFFORTS[index];
		if (!Object.hasOwn(values, effort)) continue;
		const value = values[effort];
		const rawCandidates = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
		const candidates: string[] = [];
		for (let candidateIndex = 0; candidateIndex < rawCandidates.length; candidateIndex += 1) {
			if (!Object.hasOwn(rawCandidates, candidateIndex)) continue;
			const candidate = rawCandidates[candidateIndex];
			if (typeof candidate !== "string" || candidate.trim().length === 0) continue;
			candidates.push(candidate.trim());
		}
		if (candidates.length > 0) return candidates;
	}
	return [];
}

/** Preserve the legacy single-selector view of threshold selection. */
export function selectThresholdSelector(classified: RouteEffort, thresholds: unknown): string | undefined {
	return selectThresholdCandidates(classified, thresholds)[0];
}

/** Resolve a model-specific thinking profile before model metadata clamping. */
export function resolveThinkingEffort(classified: RouteEffort, profile: unknown): ThinkingEffort {
	if (typeof profile !== "object" || profile === null || Array.isArray(profile)) return classified;
	const values = profile as Record<string, unknown>;
	const exact = values[classified];
	if (THINKING_EFFORTS.some(effort => effort === exact)) return exact as ThinkingEffort;
	const fallback = values.default;
	if (THINKING_EFFORTS.some(effort => effort === fallback)) return fallback as ThinkingEffort;
	return classified;
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
	requested: ThinkingEffort,
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
