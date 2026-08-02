import { ROUTER_EFFORTS, type RouteEffort } from "./config";
import type { RoutableModel, ThinkingEffort } from "./routing";

export const MODEL_ROUTER_STATE_ENTRY = "model-router-state";
export const MODEL_ROUTER_STATE_VERSION = 2 as const;
export const MODEL_ROUTER_HISTORY_LIMIT = 8 as const;

export type RouterMode = "auto" | "manual" | "off";
export type RouterFailureReason = "classifier" | "threshold" | "selector" | "auth" | "context" | "baseline";
export type RouterCandidateOutcome = "selected" | "selector" | "context" | "auth";

export interface ModelIdentity {
	provider: string;
	id: string;
}

export interface RouterCandidateAttempt {
	selector: string;
	outcome: RouterCandidateOutcome;
}

export interface RouterDecision {
	effort: RouteEffort | undefined;
	selector: string | undefined;
	target: ModelIdentity;
	thinking: ThinkingEffort | undefined;
	outcome: "routed" | "baseline";
	reason: RouterFailureReason | null;
	timestamp: number;
	candidates: string[];
	attempts: RouterCandidateAttempt[];
	selectedCandidate: string | undefined;
	profileEffort: ThinkingEffort | undefined;
}

export interface RouterState {
	version: typeof MODEL_ROUTER_STATE_VERSION;
	mode: RouterMode;
	baseline: ModelIdentity | null;
	observedModel: ModelIdentity | null;
	lastAutoModel: ModelIdentity | null;
	lastDecision: RouterDecision | null;
	history: RouterDecision[];
	lastClassifiedAt: number | null;
	oneShotSelector?: string;
	warningKeys: string[];
}

const ROUTER_MODES: readonly RouterMode[] = ["auto", "manual", "off"];
const FAILURE_REASONS: readonly RouterFailureReason[] = [
	"classifier",
	"threshold",
	"selector",
	"auth",
	"context",
	"baseline",
];
const CANDIDATE_OUTCOMES: readonly RouterCandidateOutcome[] = ["selected", "selector", "context", "auth"];
const THINKING_EFFORTS: readonly ThinkingEffort[] = ["minimal", ...ROUTER_EFFORTS];

function parseIdentity(value: unknown): ModelIdentity | null | undefined {
	if (value === null) return null;
	if (typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as { provider?: unknown; id?: unknown };
	if (typeof input.provider !== "string" || input.provider.trim().length === 0) return undefined;
	if (typeof input.id !== "string" || input.id.trim().length === 0) return undefined;
	return { provider: input.provider, id: input.id };
}

function parseOptionalString(value: unknown): string | undefined | false {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim().length === 0) return false;
	return value.trim();
}

function parseTimestamp(value: unknown): number | null | undefined {
	if (value === undefined || value === null) return null;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
	return value;
}

function parseCandidates(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const candidates: string[] = [];
	for (let index = 0; index < value.length; index += 1) {
		if (!Object.hasOwn(value, index)) return undefined;
		if (typeof value[index] !== "string" || value[index].trim().length === 0) return undefined;
		candidates.push(value[index].trim());
	}
	return candidates;
}

function parseAttempts(value: unknown): RouterCandidateAttempt[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const attempts: RouterCandidateAttempt[] = [];
	for (let index = 0; index < value.length; index += 1) {
		if (!Object.hasOwn(value, index)) return undefined;
		const raw = value[index];
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
		const input = raw as { selector?: unknown; outcome?: unknown };
		if (typeof input.selector !== "string" || input.selector.trim().length === 0) return undefined;
		if (!CANDIDATE_OUTCOMES.some(outcome => outcome === input.outcome)) return undefined;
		attempts.push({
			selector: input.selector.trim(),
			outcome: input.outcome as RouterCandidateOutcome,
		});
	}
	return attempts;
}

function parseDecision(value: unknown, legacy = false): RouterDecision | null | undefined {
	if (value === null) return null;
	if (typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as {
		effort?: unknown;
		selector?: unknown;
		target?: unknown;
		thinking?: unknown;
		outcome?: unknown;
		reason?: unknown;
		timestamp?: unknown;
		candidates?: unknown;
		attempts?: unknown;
		selectedCandidate?: unknown;
		profileEffort?: unknown;
	};
	const effort = input.effort;
	if (effort !== undefined && !ROUTER_EFFORTS.some(candidate => candidate === effort)) return undefined;
	const selector = parseOptionalString(input.selector);
	if (selector === false) return undefined;
	const target = parseIdentity(input.target);
	if (target === undefined || target === null) return undefined;
	const thinking = input.thinking;
	if (thinking !== undefined && !THINKING_EFFORTS.some(candidate => candidate === thinking)) return undefined;
	if (input.outcome !== "routed" && input.outcome !== "baseline") return undefined;
	const reason = input.reason;
	if (reason !== null && !FAILURE_REASONS.some(candidate => candidate === reason)) return undefined;
	if (input.outcome === "routed" && reason !== null) return undefined;
	if (input.outcome === "baseline" && reason === null) return undefined;

	const timestamp = legacy ? 0 : parseTimestamp(input.timestamp);
	if (timestamp === undefined || (timestamp === null && !legacy)) return undefined;
	const candidates = legacy ? (selector ? [selector] : []) : parseCandidates(input.candidates);
	if (candidates === undefined) return undefined;
	const attempts = legacy ? [] : parseAttempts(input.attempts);
	if (attempts === undefined) return undefined;
	const selectedCandidateValue = legacy
		? input.outcome === "routed"
			? selector
			: undefined
		: parseOptionalString(input.selectedCandidate);
	if (selectedCandidateValue === false) return undefined;
	const profileEffortValue = legacy ? thinking : input.profileEffort;
	if (profileEffortValue !== undefined && !THINKING_EFFORTS.some(candidate => candidate === profileEffortValue)) {
		return undefined;
	}
	return {
		effort: effort as RouteEffort | undefined,
		selector,
		target,
		thinking: thinking as ThinkingEffort | undefined,
		outcome: input.outcome,
		reason: reason as RouterFailureReason | null,
		timestamp: timestamp as number,
		candidates,
		attempts,
		selectedCandidate: selectedCandidateValue,
		profileEffort: profileEffortValue as ThinkingEffort | undefined,
	};
}

function identityOf(model: Pick<RoutableModel, "provider" | "id"> | undefined): ModelIdentity | null {
	if (!model || model.provider.trim().length === 0 || model.id.trim().length === 0) return null;
	return { provider: model.provider, id: model.id };
}

function parseRouterStateValue(input: Record<string, unknown>, legacy: boolean): RouterState | undefined {
	if (!ROUTER_MODES.some(candidate => candidate === input.mode)) return undefined;
	const baseline = parseIdentity(input.baseline);
	const observedModel = parseIdentity(input.observedModel);
	const lastAutoModel = parseIdentity(input.lastAutoModel);
	const lastDecision = parseDecision(input.lastDecision, legacy);
	if (
		baseline === undefined ||
		observedModel === undefined ||
		lastAutoModel === undefined ||
		lastDecision === undefined ||
		!Array.isArray(input.warningKeys)
	) {
		return undefined;
	}

	const warningKeys: string[] = [];
	for (const warningKey of input.warningKeys) {
		if (typeof warningKey !== "string" || warningKey.trim().length === 0) return undefined;
		const normalized = warningKey.trim();
		if (!warningKeys.includes(normalized)) warningKeys.push(normalized);
	}

	const history = legacy ? [] : parseHistory(input.history);
	if (history === undefined) return undefined;
	const oneShotValue = legacy ? undefined : parseOptionalString(input.oneShotSelector);
	if (oneShotValue === false) return undefined;
	const lastClassifiedAt = legacy ? null : parseTimestamp(input.lastClassifiedAt);
	if (lastClassifiedAt === undefined) return undefined;

	const state: RouterState = {
		version: MODEL_ROUTER_STATE_VERSION,
		mode: input.mode as RouterMode,
		baseline,
		observedModel,
		lastAutoModel,
		lastDecision,
		history,
		lastClassifiedAt,
		warningKeys,
	};
	if (oneShotValue !== undefined) state.oneShotSelector = oneShotValue;
	return state;
}

function parseHistory(value: unknown): RouterDecision[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const history: RouterDecision[] = [];
	for (let index = 0; index < value.length; index += 1) {
		if (!Object.hasOwn(value, index)) return undefined;
		const decision = parseDecision(value[index]);
		if (decision === undefined || decision === null) return undefined;
		history.push(decision);
	}
	return history.slice(-MODEL_ROUTER_HISTORY_LIMIT);
}

/** Seed a new session using the current model as its safe fallback baseline. */
export function createRouterState(
	currentModel: Pick<RoutableModel, "provider" | "id"> | undefined,
	enabled = true,
): RouterState {
	const identity = identityOf(currentModel);
	return {
		version: MODEL_ROUTER_STATE_VERSION,
		mode: enabled ? "auto" : "off",
		baseline: identity,
		observedModel: identity,
		lastAutoModel: null,
		lastDecision: null,
		history: [],
		lastClassifiedAt: null,
		warningKeys: [],
	};
}

/** Validate and detach one untrusted persisted state value, upgrading v1 in memory. */
export function parseRouterState(value: unknown): RouterState | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	if (input.version === 1) return parseRouterStateValue(input, true);
	if (input.version !== MODEL_ROUTER_STATE_VERSION) return undefined;
	return parseRouterStateValue(input, false);
}

/** Keep only the newest validated decision and bounded history entries. */
export function recordRouterDecision(state: RouterState, decision: RouterDecision): void {
	const parsed = parseDecision(decision);
	if (!parsed) throw new TypeError("model-router: refusing to record invalid decision");
	state.lastDecision = parsed;
	state.history = [...state.history, parsed].slice(-MODEL_ROUTER_HISTORY_LIMIT);
}

/** Arm one explicit selector for the next eligible prompt. */
export function armOneShotSelector(state: RouterState, selector: string): boolean {
	const normalized = selector.trim();
	if (normalized.length === 0) return false;
	state.oneShotSelector = normalized;
	return true;
}

/** Consume the armed one-shot selector after an eligible prompt is handled. */
export function consumeOneShotSelector(state: RouterState): string | undefined {
	const selector = state.oneShotSelector;
	delete state.oneShotSelector;
	return selector;
}

/** Check whether classification is currently inside a configured cooldown window. */
export function isClassifierCoolingDown(state: RouterState, now: number, cooldownMs: number): boolean {
	if (cooldownMs <= 0 || state.lastClassifiedAt === null || now < state.lastClassifiedAt) return false;
	return now - state.lastClassifiedAt < cooldownMs;
}

/** Produce the validated plain-data snapshot written to a custom entry. */
export function encodeRouterState(state: RouterState): RouterState {
	const parsed = parseRouterState(state);
	if (!parsed) throw new TypeError("model-router: refusing to persist invalid state");
	return parsed;
}

/** Recover the latest valid router entry, or seed state from the current model. */
export function restoreRouterState(
	entries: readonly unknown[],
	currentModel: Pick<RoutableModel, "provider" | "id"> | undefined,
	enabled = true,
): RouterState {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const value = entries[index];
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const entry = value as { type?: unknown; customType?: unknown; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== MODEL_ROUTER_STATE_ENTRY) continue;
		const state = parseRouterState(entry.data);
		if (state) return state;
	}
	return createRouterState(currentModel, enabled);
}
