import { ROUTER_EFFORTS, type RouteEffort } from "./config";
import type { RoutableModel, ThinkingEffort } from "./routing";

export const MODEL_ROUTER_STATE_ENTRY = "model-router-state";
export const MODEL_ROUTER_STATE_VERSION = 1 as const;

export type RouterMode = "auto" | "manual" | "off";
export type RouterFailureReason = "classifier" | "threshold" | "selector" | "auth" | "context" | "baseline";

export interface ModelIdentity {
	provider: string;
	id: string;
}

export interface RouterDecision {
	effort: RouteEffort | undefined;
	selector: string | undefined;
	target: ModelIdentity;
	thinking: ThinkingEffort | undefined;
	outcome: "routed" | "baseline";
	reason: RouterFailureReason | null;
}

export interface RouterState {
	version: typeof MODEL_ROUTER_STATE_VERSION;
	mode: RouterMode;
	baseline: ModelIdentity | null;
	observedModel: ModelIdentity | null;
	lastAutoModel: ModelIdentity | null;
	lastDecision: RouterDecision | null;
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

function parseDecision(value: unknown): RouterDecision | null | undefined {
	if (value === null) return null;
	if (typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as {
		effort?: unknown;
		selector?: unknown;
		target?: unknown;
		thinking?: unknown;
		outcome?: unknown;
		reason?: unknown;
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
	return {
		effort: effort as RouteEffort | undefined,
		selector,
		target,
		thinking: thinking as ThinkingEffort | undefined,
		outcome: input.outcome,
		reason: reason as RouterFailureReason | null,
	};
}

function identityOf(model: Pick<RoutableModel, "provider" | "id"> | undefined): ModelIdentity | null {
	if (!model || model.provider.trim().length === 0 || model.id.trim().length === 0) return null;
	return { provider: model.provider, id: model.id };
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
		warningKeys: [],
	};
}

/** Validate and detach one untrusted persisted state value. */
export function parseRouterState(value: unknown): RouterState | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const input = value as {
		version?: unknown;
		mode?: unknown;
		baseline?: unknown;
		observedModel?: unknown;
		lastAutoModel?: unknown;
		lastDecision?: unknown;
		warningKeys?: unknown;
	};
	if (input.version !== MODEL_ROUTER_STATE_VERSION) return undefined;
	if (!ROUTER_MODES.some(candidate => candidate === input.mode)) return undefined;
	const baseline = parseIdentity(input.baseline);
	const observedModel = parseIdentity(input.observedModel);
	const lastAutoModel = parseIdentity(input.lastAutoModel);
	const lastDecision = parseDecision(input.lastDecision);
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
	return {
		version: MODEL_ROUTER_STATE_VERSION,
		mode: input.mode as RouterMode,
		baseline,
		observedModel,
		lastAutoModel,
		lastDecision,
		warningKeys,
	};
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
