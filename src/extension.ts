import type { Model } from "@oh-my-pi/pi-ai";
import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	InputEvent,
	InputEventResult,
	MessageEndEvent,
	SessionBranchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionSwitchEvent,
	SessionTreeEvent,
} from "@oh-my-pi/pi-coding-agent";
import { type AgentDefinition, discoverAgents } from "@oh-my-pi/pi-coding-agent/task";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { Text } from "@oh-my-pi/pi-tui";
import { classifyPromptEffort } from "./classifier";
import { DEFAULT_ROUTER_CONFIG, loadRouterConfig, type RouteEffort, type RouterConfig } from "./config";
import { type DelegationPlan, loadRepositoryAgentIndex, planDelegation } from "./delegation";
import { aggregateUsage, shouldSampleShadow, snapshotUsage, type UsageSnapshot } from "./measurement";
import { type ParallelCommandDependencies, registerParallelCommand } from "./parallel/commands";
import {
	clampEffortToModel,
	estimatePromptTokens,
	formatModelSelector,
	hasContextCapacity,
	modelsEqual,
	resolveThinkingEffort,
	selectThresholdCandidates,
	type ThinkingEffort,
} from "./routing";
import { BUILTIN_MODEL_ROLE_SELECTORS, type RouterSetupContext, runRouterSetup } from "./setup";
import {
	armOneShotSelector,
	consumeOneShotSelector,
	createRouterState,
	encodeRouterState,
	isClassifierCoolingDown,
	MODEL_ROUTER_STATE_ENTRY,
	type ModelIdentity,
	parseRouterState,
	type RouterCandidateAttempt,
	type RouterFailureReason,
	type RouterState,
	recordRouterDecision,
} from "./state";

const STATUS_KEY = "model-router";
/** State-only session entries recording each delegation workflow transition. */
export const MODEL_ROUTER_DELEGATION_ENTRY = "model-router-delegation";
/** Visible custom message carrying a delegated request/result exchange. */
export const MODEL_ROUTER_DELEGATION_MESSAGE = "model-router-delegation-result";
const COMMAND_USAGE =
	"Usage: /route auto | manual [selector] | off | status | explain | history | once <selector> | cancel | setup | reload";

const ROUTE_COMMAND_COMPLETIONS = [
	{ label: "auto", value: "auto", description: "Enable automatic effort-aware routing" },
	{ label: "manual", value: "manual", description: "Pin a baseline model selector" },
	{ label: "off", value: "off", description: "Disable automatic routing" },
	{ label: "status", value: "status", description: "Show the current routing mode and target" },
	{ label: "explain", value: "explain", description: "Show the latest routing decision details" },
	{ label: "history", value: "history", description: "Show recent routing decisions" },
	{ label: "once", value: "once", description: "Route the next prompt to a model selector" },
	{ label: "cancel", value: "cancel", description: "Cancel the active delegation workflow" },
	{ label: "setup", value: "setup", description: "Configure routing interactively" },
	{ label: "reload", value: "reload", description: "Reload routing configuration from disk" },
];

function configuredRouteSelectors(config: RouterConfig): string[] {
	const selectors = new Set([...BUILTIN_MODEL_ROLE_SELECTORS, ...config.classifierModels]);
	for (const candidates of Object.values(config.thresholds)) {
		for (const selector of candidates ?? []) selectors.add(selector);
	}
	for (const selector of Object.keys(config.thinkingProfiles)) selectors.add(selector);
	return [...selectors];
}

function routeArgumentCompletions(argumentPrefix: string, config: RouterConfig) {
	const trimmed = argumentPrefix.trimStart();
	const firstWhitespace = trimmed.search(/\s/);
	if (firstWhitespace === -1) {
		const normalized = trimmed.toLowerCase();
		return ROUTE_COMMAND_COMPLETIONS.filter(item => item.label.startsWith(normalized));
	}

	const command = trimmed.slice(0, firstWhitespace).toLowerCase();
	if (command !== "manual" && command !== "once") return null;
	const selectorPrefix = trimmed.slice(firstWhitespace).trimStart().toLowerCase();
	const description =
		command === "once" ? "Route the next prompt to this model selector" : "Use this model selector as the baseline";
	return configuredRouteSelectors(config)
		.filter(selector => selector.toLowerCase().startsWith(selectorPrefix))
		.map(selector => ({ label: selector, value: `${command} ${selector}`, description }));
}

type LoadConfig = typeof loadRouterConfig;
type Classify = typeof classifyPromptEffort;
type ExtensionThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

const THINKING_LEVEL_BY_EFFORT = {
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
} as Record<ThinkingEffort, ExtensionThinkingLevel>;

export interface ModelRouterExtensionDependencies {
	loadConfig: LoadConfig;
	classify: Classify;
	now?: () => number;
	setup?: typeof runRouterSetup;
	plan?: typeof planDelegation;
	discover?: typeof discoverAgents;
	execute?: typeof runSubprocess;
	loadAgentIndex?: typeof loadRepositoryAgentIndex;
	random?: () => number;
	/** Seams for the `/parallel` workflow command; defaults build the real per-cwd coordinator. */
	parallel?: ParallelCommandDependencies;
}

/** Successfully applied route: the model now active for the prompt plus its applied efforts. */
export interface RoutedPrompt {
	model: Model;
	effort?: RouteEffort;
	thinking?: ExtensionThinkingLevel;
	/** Ephemeral identity for a detached restore; never persisted or rendered. */
	automaticRouteToken?: number;
}

/**
 * Fence for a route applied on behalf of a claimed delegation: the delegation
 * generation and abort signal captured at claim time. A queued route checks it
 * before starting, after every await, and before every side effect so a
 * session/tree/branch switch (or cancel) makes the stale route a strict no-op.
 */
interface RouteGuard {
	readonly generation: number;
	readonly signal: AbortSignal;
	/** Main-session input, rather than a detached delegation route. */
	readonly automaticMainTurn?: boolean;
	/** Existing detached automatic route owner inherited by a short/no-route input. */
	readonly inheritedAutomaticRouteToken?: number;
}

interface AutomaticMainTurn {
	readonly generation: number;
	readonly routeToken?: number;
	stale: boolean;
	/** True once the router proactively restored this token before its event arrived. */
	settled: boolean;
}

type DelegationEntryStatus = "pending" | "delegated" | "completed" | "failed" | "cancelled" | "passed-through";

interface DelegationWorkflow {
	runId: string;
	index: number;
	controller: AbortController;
	request: string;
	startedAt: number;
	/** Delegation generation captured at claim; a lifecycle bump orphans the workflow. */
	generation: number;
	parentContextTokens: number | null;
	plannerUsage: UsageSnapshot | null;
	childUsage: UsageSnapshot | null;
}

/** Five-minute cap for an armed parent correlation that never confirms or settles. */
const PARENT_CORRELATION_TIMEOUT_MS = 300_000;

/**
 * One armed parent-turn correlation: confirmed by a matching user
 * `message_end`, filled by assistant `message_end` usage snapshots, settled
 * only at a terminal `agent_end`.
 */
type PendingParentMeasurement = {
	runId: string;
	expectedPrefix: string;
	/** Sampled prompts must match exactly; replays only prefix the delivered follow-up text. */
	match: "exact" | "prefix";
	phase: "awaiting-user" | "collecting-assistant";
	assistantUsage: UsageSnapshot[];
	timer: ReturnType<typeof setTimeout>;
	onComplete: (usage: UsageSnapshot | null) => void;
};

function agentMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (
			typeof part === "object" &&
			part !== null &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string"
		) {
			parts.push((part as { text: string }).text);
		}
	}
	return parts.join("\n");
}

function identityOf(model: Pick<Model, "provider" | "id"> | undefined): ModelIdentity | null {
	return model ? { provider: model.provider, id: model.id } : null;
}

function modelLabel(model: ModelIdentity | null): string {
	return model ? `${model.provider}/${model.id}` : "unavailable";
}

function formatDecisionExplanation(state: RouterState, config: RouterConfig): string {
	const classifierGuards = [
		`Classifier minimum: ${config.classifierMinPromptChars} characters`,
		`Classifier cooldown: ${config.classifierCooldownMs} ms`,
		`Last classified at: ${state.lastClassifiedAt ?? "never"}`,
	];
	const decision = state.lastDecision;
	if (!decision) {
		return [`No routing decision yet.`, `Baseline: ${modelLabel(state.baseline)}`, ...classifierGuards].join("\n");
	}
	const attempts =
		decision.attempts.length > 0
			? decision.attempts.map(attempt => `${attempt.selector}=${attempt.outcome}`).join(", ")
			: "none";
	return [
		`Latest decision: ${decision.outcome} (${decision.effort ?? "one-shot"})`,
		`Baseline: ${modelLabel(state.baseline)}`,
		`Candidates: ${decision.candidates.length > 0 ? decision.candidates.join(" → ") : "none"}`,
		`Attempts: ${attempts}`,
		`Selected: ${decision.selectedCandidate ?? "none"}`,
		`Profile effort: ${decision.profileEffort ?? "none"}`,
		`Applied thinking: ${decision.thinking ?? "none"}`,
		`Reason: ${decision.reason ?? "none"}`,
		...classifierGuards,
	].join("\n");
}

function formatDecisionHistory(state: RouterState): string {
	if (state.history.length === 0) return "Model router history: empty";
	const rows = state.history
		.slice()
		.reverse()
		.map(
			(decision, index) =>
				`${index + 1}. ${decision.timestamp} ${decision.effort ?? "one-shot"} → ${modelLabel(decision.target)} · ${decision.outcome}${decision.reason ? ` (${decision.reason})` : ""}`,
		);
	return `Model router history:\n${rows.join("\n")}`;
}

function routeStatus(state: RouterState): string {
	const decision = state.lastDecision;
	if (!decision) return `route:${state.mode} · baseline ${modelLabel(state.baseline)}`;
	const effort = decision.effort ?? "failed";
	return `route:${state.mode} · baseline ${modelLabel(state.baseline)} · ${effort} → ${modelLabel(decision.target)} · ${decision.outcome}`;
}

function currentModel(ctx: ExtensionContext): Model | undefined {
	return ctx.models.current() ?? ctx.model;
}

function isMainIdleInput(event: InputEvent, ctx: ExtensionContext): boolean {
	return (
		event.source === "interactive" &&
		ctx.isIdle() &&
		!ctx.hasPendingMessages() &&
		ctx.sessionManager.getHeader()?.parentSession === undefined
	);
}

function defaultConfig(): RouterConfig {
	return {
		enabled: DEFAULT_ROUTER_CONFIG.enabled,
		thresholds: Object.fromEntries(
			Object.entries(DEFAULT_ROUTER_CONFIG.thresholds).map(([effort, candidates]) => [
				effort,
				[...(candidates ?? [])],
			]),
		) as RouterConfig["thresholds"],
		classifierModels: [...DEFAULT_ROUTER_CONFIG.classifierModels],
		maxEffort: DEFAULT_ROUTER_CONFIG.maxEffort,
		classifierTimeoutMs: DEFAULT_ROUTER_CONFIG.classifierTimeoutMs,
		classifierMinPromptChars: DEFAULT_ROUTER_CONFIG.classifierMinPromptChars,
		classifierCooldownMs: DEFAULT_ROUTER_CONFIG.classifierCooldownMs,
		thinkingProfiles: Object.fromEntries(
			Object.entries(DEFAULT_ROUTER_CONFIG.thinkingProfiles).map(([modelKey, profile]) => [
				modelKey,
				{ ...profile },
			]),
		),
		delegation: {
			enabled: DEFAULT_ROUTER_CONFIG.delegation.enabled,
			plannerTimeoutMs: DEFAULT_ROUTER_CONFIG.delegation.plannerTimeoutMs,
			agents: [...DEFAULT_ROUTER_CONFIG.delegation.agents],
			measurement: { ...DEFAULT_ROUTER_CONFIG.delegation.measurement },
		},
	};
}

/** Bound failure diagnostics so raw planner/child payloads never flood logs, entries, or the UI. */
function conciseReason(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

/** Build an extension factory with narrow seams for direct behavior tests. */
export function createModelRouterExtension(
	dependencies: Partial<ModelRouterExtensionDependencies> = {},
): ExtensionFactory {
	const readConfig = dependencies.loadConfig ?? loadRouterConfig;
	const classify = dependencies.classify ?? classifyPromptEffort;
	const now = dependencies.now ?? Date.now;
	const setup = dependencies.setup ?? runRouterSetup;
	const planWorkflow = dependencies.plan ?? planDelegation;
	const discover = dependencies.discover ?? discoverAgents;
	const execute = dependencies.execute ?? runSubprocess;
	const loadAgentIndex = dependencies.loadAgentIndex ?? loadRepositoryAgentIndex;
	const random = dependencies.random ?? Math.random;

	return (pi: ExtensionAPI): void => {
		let config = defaultConfig();
		let state: RouterState | undefined;
		let activeDelegation: DelegationWorkflow | undefined;
		let delegationRunSequence = 0;
		/** Bumped on session start/switch/branch/tree so an in-flight workflow can never write into a successor session. */
		let delegationGeneration = 0;
		let automaticRouteGeneration: number | undefined;
		let automaticRouteTokenSequence = 0;
		let automaticRouteToken: number | undefined;
		/** FIFO turn fence because public agent_end has no turn/session identifier. */
		const automaticMainTurns: AutomaticMainTurn[] = [];
		/** Serializes router-owned baseline restores with later router controls and inputs. */
		let automaticRestorePromise: Promise<void> = Promise.resolve();
		let shadowRunSequence = 0;
		let shadowController: AbortController | undefined;
		/** Bumped on every session reset so a stale detached shadow can never append into a successor session. */
		let measurementGeneration = 0;
		let pendingParentMeasurements: PendingParentMeasurement[] = [];
		const delegationStatus = (): string => {
			const measurement = config.delegation.measurement;
			const measurementText = measurement.enabled
				? `measurement on (${Math.round(measurement.sampleRate * 100)}%)`
				: "measurement off";
			return `delegation ${config.delegation.enabled ? "on" : "off"} (${activeDelegation ? "active" : "idle"}) · ${measurementText}`;
		};
		/** The one status-bar string: route summary plus the delegation suffix, everywhere. */
		const routerStatus = (runtime: RouterState): string => `${routeStatus(runtime)} · ${delegationStatus()}`;

		const persist = (ctx: ExtensionContext): void => {
			if (!state) return;
			pi.appendEntry(MODEL_ROUTER_STATE_ENTRY, encodeRouterState(state));
			ctx.ui.setStatus(STATUS_KEY, routerStatus(state));
		};
		const switchModel = async (model: Model): Promise<boolean> => {
			try {
				return await pi.setModel(model);
			} catch {
				return false;
			}
		};
		const invalidateAutomaticRoute = (): void => {
			automaticRouteGeneration = undefined;
			automaticRouteToken = undefined;
		};
		const markAutomaticMainTurnsStale = (): void => {
			for (const turn of automaticMainTurns) turn.stale = true;
		};
		const queueAutomaticMainTurn = (generation: number, routeToken?: number): void => {
			markAutomaticMainTurnsStale();
			automaticMainTurns.push({ generation, routeToken, stale: false, settled: false });
		};
		const waitForAutomaticRestore = async (): Promise<void> => {
			await automaticRestorePromise;
		};

		const persistedBranchState = (ctx: ExtensionContext): RouterState | undefined => {
			const entries = ctx.sessionManager.getBranch();
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				const entry = entries[index];
				if (entry.type !== "custom" || entry.customType !== MODEL_ROUTER_STATE_ENTRY) continue;
				const restored = parseRouterState(entry.data);
				if (restored) return restored;
			}
			return undefined;
		};

		const ensureState = (ctx: ExtensionContext): RouterState => {
			if (!state) {
				const restored = persistedBranchState(ctx);
				state = restored ?? createRouterState(currentModel(ctx), config.enabled);
				if (!restored) persist(ctx);
			}
			return state;
		};

		const warnOnce = (ctx: ExtensionContext, key: string, message: string): void => {
			const runtime = ensureState(ctx);
			if (runtime.warningKeys.includes(key)) return;
			runtime.warningKeys.push(key);
			ctx.ui.notify(message, "warning");
			pi.logger.warn(message);
		};

		const rehydrate = async (ctx: ExtensionContext, deferMissingState = false): Promise<void> => {
			config = await readConfig({ cwd: ctx.cwd });
			const restored = persistedBranchState(ctx);
			if (!restored && deferMissingState) {
				state = undefined;
				ctx.ui.setStatus(STATUS_KEY, undefined);
				return;
			}
			state = restored ?? createRouterState(currentModel(ctx), config.enabled);
			let changed = false;
			if (!config.enabled && state.mode === "auto") {
				state.mode = "off";
				changed = true;
			}
			if (!restored || changed) persist(ctx);
			else ctx.ui.setStatus(STATUS_KEY, routerStatus(state));
		};

		const transitionAuto = (ctx: ExtensionContext): void => {
			const runtime = ensureState(ctx);
			const current = identityOf(currentModel(ctx));
			if (runtime.mode === "auto" && modelsEqual(runtime.baseline ?? undefined, current ?? undefined)) {
				ctx.ui.setStatus(STATUS_KEY, routerStatus(runtime));
				return;
			}
			markAutomaticMainTurnsStale();
			invalidateAutomaticRoute();
			runtime.mode = "auto";
			runtime.baseline = current;
			runtime.observedModel = current;
			runtime.lastAutoModel = null;
			runtime.lastDecision = null;
			persist(ctx);
			ctx.ui.notify(`Automatic routing enabled with baseline ${modelLabel(current)}`, "info");
		};

		const transitionOff = (ctx: ExtensionContext): void => {
			const runtime = ensureState(ctx);
			markAutomaticMainTurnsStale();
			invalidateAutomaticRoute();
			if (runtime.mode === "off") return;
			runtime.mode = "off";
			runtime.observedModel = identityOf(currentModel(ctx));
			runtime.lastAutoModel = null;
			persist(ctx);
			ctx.ui.notify("Automatic routing disabled", "info");
		};

		const transitionManual = async (ctx: ExtensionContext, selector: string | undefined): Promise<void> => {
			const runtime = ensureState(ctx);
			let selected = currentModel(ctx);
			if (selector) {
				selected = ctx.models.resolve(selector);
				if (!selected) {
					warnOnce(
						ctx,
						`manual-selector:${selector}`,
						`Model router could not resolve manual selector ${selector}`,
					);
					persist(ctx);
					return;
				}
				if (!modelsEqual(currentModel(ctx), selected) && !(await switchModel(selected))) {
					warnOnce(
						ctx,
						`manual-auth:${selector}`,
						`Model router could not authenticate manual selector ${selector}`,
					);
					persist(ctx);
					return;
				}
			}
			const manual = identityOf(selected);
			if (!manual) {
				warnOnce(ctx, "manual-model-unavailable", "Model router cannot pin manual mode without a current model");
				persist(ctx);
				return;
			}
			markAutomaticMainTurnsStale();
			invalidateAutomaticRoute();
			runtime.mode = "manual";
			runtime.baseline = manual;
			runtime.observedModel = manual;
			runtime.lastAutoModel = null;
			runtime.lastDecision = null;
			persist(ctx);
			ctx.ui.notify(`Manual routing pinned to ${modelLabel(manual)}`, "info");
		};
		const restoreAutomaticBaselineNow = async (
			ctx: ExtensionContext,
			generation: number,
			expectedToken?: number,
		): Promise<void> => {
			if (
				automaticRouteGeneration !== generation ||
				(expectedToken !== undefined && automaticRouteToken !== expectedToken)
			) {
				return;
			}
			if (
				expectedToken !== undefined &&
				automaticMainTurns.some(turn => !turn.stale && turn.routeToken === expectedToken)
			) {
				return;
			}
			const runtime = ensureState(ctx);
			if (runtime.mode !== "auto" || runtime.baseline === null || runtime.lastAutoModel === null) {
				return;
			}
			const activeModel = currentModel(ctx);
			const lastAutomaticModel = ctx.models.resolve(formatModelSelector(runtime.lastAutoModel));
			if (!modelsEqual(activeModel, lastAutomaticModel)) return;
			const baselineModel = ctx.models.resolve(formatModelSelector(runtime.baseline));
			if (!baselineModel) {
				warnOnce(ctx, "baseline", "Model router could not resolve its stored baseline model");
				persist(ctx);
				invalidateAutomaticRoute();
				return;
			}
			const baselineIdentity = identityOf(baselineModel);
			if (modelsEqual(activeModel, baselineModel)) {
				runtime.observedModel = baselineIdentity;
				runtime.lastAutoModel = baselineIdentity;
				persist(ctx);
				invalidateAutomaticRoute();
				return;
			}
			const switched = await switchModel(baselineModel);
			if (
				automaticRouteGeneration !== generation ||
				(expectedToken !== undefined && automaticRouteToken !== expectedToken) ||
				runtime.mode !== "auto" ||
				!modelsEqual(runtime.lastAutoModel ?? undefined, identityOf(activeModel) ?? undefined)
			) {
				return;
			}
			if (switched) {
				if (!modelsEqual(currentModel(ctx), baselineModel)) return;
				runtime.observedModel = baselineIdentity;
				runtime.lastAutoModel = baselineIdentity;
				persist(ctx);
				invalidateAutomaticRoute();
				return;
			}
			if (!modelsEqual(currentModel(ctx), activeModel)) return;
			warnOnce(ctx, "baseline-auth", "Model router could not authenticate its stored baseline model");
			persist(ctx);
			invalidateAutomaticRoute();
		};
		const restoreAutomaticBaseline = (
			ctx: ExtensionContext,
			generation: number,
			expectedToken?: number,
		): Promise<void> => {
			const run = automaticRestorePromise.then(() =>
				restoreAutomaticBaselineNow(ctx, generation, expectedToken),
			);
			automaticRestorePromise = run.catch(() => undefined);
			return run;
		};
		/**
		 * A terminal event can be queued behind a successor input. Settle the
		 * active automatic token before routing that successor, but retain a
		 * settled stale sentinel so the delayed terminal event cannot consume
		 * the successor token.
		 */
		const settlePendingAutomaticMainTurn = async (ctx: ExtensionContext): Promise<void> => {
			if (!ctx.isIdle()) return;
			while (automaticMainTurns[0]?.stale && automaticMainTurns[0].settled) {
				automaticMainTurns.shift();
			}
			const pending = automaticMainTurns[0];
			if (!pending || pending.stale) return;
			pending.stale = true;
			pending.settled = true;
			await restoreAutomaticBaseline(ctx, pending.generation, pending.routeToken);
		};

		/** True once a guarded route was superseded: aborted, or claimed under an older delegation generation. */
		const routeSuperseded = (guard: RouteGuard | undefined): boolean =>
			guard !== undefined && (guard.signal.aborted || guard.generation !== delegationGeneration);

		const fallbackToBaseline = async (
			ctx: ExtensionContext,
			effort: RouteEffort | undefined,
			selector: string | undefined,
			candidates: readonly string[],
			attempts: readonly RouterCandidateAttempt[],
			reason: RouterFailureReason,
			warning: string,
			consumeOneShot: boolean,
			guard?: RouteGuard,
		): Promise<void> => {
			if (routeSuperseded(guard)) return;
			const runtime = ensureState(ctx);
			warnOnce(ctx, reason, warning);
			const baseline = runtime.baseline;
			const actualCurrent = currentModel(ctx);
			let fallbackModel: Model | undefined;
			if (baseline) fallbackModel = ctx.models.resolve(formatModelSelector(baseline));
			if (!fallbackModel) {
				warnOnce(ctx, "baseline", "Model router could not resolve its stored baseline model");
				const observed = identityOf(actualCurrent);
				runtime.observedModel = observed;
				runtime.lastAutoModel = observed;
				if (observed) {
					recordRouterDecision(runtime, {
						effort,
						selector,
						target: observed,
						thinking: undefined,
						outcome: "baseline",
						reason,
						timestamp: now(),
						candidates: [...candidates],
						attempts: [...attempts],
						selectedCandidate: undefined,
						profileEffort: undefined,
					});
				}
				if (consumeOneShot) consumeOneShotSelector(runtime);
				persist(ctx);
				return;
			}
			let switched = true;
			if (!modelsEqual(actualCurrent, fallbackModel)) {
				switched = await switchModel(fallbackModel);
				if (routeSuperseded(guard)) return;
			}
			if (!switched) {
				warnOnce(ctx, "baseline-auth", "Model router could not authenticate its stored baseline model");
				const observed = identityOf(currentModel(ctx));
				runtime.observedModel = observed;
				runtime.lastAutoModel = observed;
			} else {
				runtime.observedModel = identityOf(fallbackModel);
				runtime.lastAutoModel = identityOf(fallbackModel);
			}
			recordRouterDecision(runtime, {
				effort,
				selector,
				target: { provider: fallbackModel.provider, id: fallbackModel.id },
				thinking: undefined,
				outcome: "baseline",
				reason,
				timestamp: now(),
				candidates: [...candidates],
				attempts: [...attempts],
				selectedCandidate: undefined,
				profileEffort: undefined,
			});
			if (consumeOneShot) consumeOneShotSelector(runtime);
			persist(ctx);
		};

		const applyRoutePrompt = async (
			event: InputEvent,
			ctx: ExtensionContext,
			guard?: RouteGuard,
		): Promise<RoutedPrompt | undefined> => {
			// The queue may dequeue this route long after its delegation was
			// invalidated; a superseded route must not touch the successor session.
			if (routeSuperseded(guard)) return;
			const runtime = ensureState(ctx);
			const oneShotSelector = runtime.oneShotSelector;
			if (
				guard?.automaticMainTurn === true &&
				guard.inheritedAutomaticRouteToken === undefined
			) {
				markAutomaticMainTurnsStale();
			}
			if (oneShotSelector !== undefined) {
				markAutomaticMainTurnsStale();
				invalidateAutomaticRoute();
			}
			if (oneShotSelector === undefined && runtime.mode !== "auto") return;
			const activeModel = currentModel(ctx);
			const activeIdentity = identityOf(activeModel);
			if (oneShotSelector === undefined) {
				const changedFromObserved = !modelsEqual(activeIdentity ?? undefined, runtime.observedModel ?? undefined);
				const differsFromLastAutomatic = !modelsEqual(
					activeIdentity ?? undefined,
					runtime.lastAutoModel ?? undefined,
				);
				if (activeIdentity && changedFromObserved && differsFromLastAutomatic) {
					invalidateAutomaticRoute();
					runtime.mode = "manual";
					runtime.baseline = activeIdentity;
					runtime.observedModel = activeIdentity;
					runtime.lastAutoModel = null;
					runtime.lastDecision = null;
					persist(ctx);
					ctx.ui.notify(`External model change detected; routing pinned to ${modelLabel(activeIdentity)}`, "info");
					return;
				}
				if (event.text.trim().length < config.classifierMinPromptChars) return;
				if (isClassifierCoolingDown(runtime, now(), config.classifierCooldownMs)) return;
			}

			let effort: RouteEffort | undefined;
			let candidates: string[];
			if (oneShotSelector !== undefined) {
				candidates = [oneShotSelector];
			} else {
				try {
					effort = await classify(event.text, config, {
						models: ctx.models,
						modelRegistry: ctx.modelRegistry,
						sessionId: ctx.sessionManager.getSessionId(),
					});
					if (routeSuperseded(guard)) return;
					runtime.lastClassifiedAt = now();
				} catch {
					if (routeSuperseded(guard)) return;
					runtime.lastClassifiedAt = now();
					await fallbackToBaseline(
						ctx,
						undefined,
						undefined,
						[],
						[],
						"classifier",
						"Model router classifier failed; returned to baseline",
						false,
						guard,
					);
					return;
				}
				candidates = selectThresholdCandidates(effort, config.thresholds);
				if (candidates.length === 0) {
					await fallbackToBaseline(
						ctx,
						effort,
						undefined,
						[],
						[],
						"threshold",
						"Model router found no matching threshold; returned to baseline",
						false,
						guard,
					);
					return;
				}
			}

			const attempts: RouterCandidateAttempt[] = [];
			let target: Model | undefined;
			let selectedCandidate: string | undefined;
			for (const candidate of candidates) {
				const candidateModel = ctx.models.resolve(candidate);
				if (!candidateModel) {
					attempts.push({ selector: candidate, outcome: "selector" });
					continue;
				}
				const usage = ctx.getContextUsage();
				if (!usage || !hasContextCapacity(candidateModel, usage.tokens, estimatePromptTokens(event.text))) {
					attempts.push({ selector: candidate, outcome: "context" });
					continue;
				}
				if (!modelsEqual(activeModel, candidateModel)) {
					if (routeSuperseded(guard)) return;
					const switched = await switchModel(candidateModel);
					if (routeSuperseded(guard)) return;
					if (!switched) {
						attempts.push({ selector: candidate, outcome: "auth" });
						continue;
					}
				}
				if (!identityOf(candidateModel)) {
					attempts.push({ selector: candidate, outcome: "selector" });
					continue;
				}
				attempts.push({ selector: candidate, outcome: "selected" });
				target = candidateModel;
				selectedCandidate = candidate;
				break;
			}

			if (!target || !selectedCandidate) {
				const reason: RouterFailureReason = attempts.some(attempt => attempt.outcome === "auth")
					? "auth"
					: attempts.some(attempt => attempt.outcome === "context")
						? "context"
						: "selector";
				const warning =
					reason === "auth"
						? `Model router candidates ${candidates.join(", ")} failed authentication; returned to baseline`
						: reason === "context"
							? `Model router candidates ${candidates.join(", ")} have insufficient context; returned to baseline`
							: `Model router could not resolve candidates ${candidates.join(", ")}; returned to baseline`;
				await fallbackToBaseline(
					ctx,
					effort,
					candidates[0],
					candidates,
					attempts,
					reason,
					warning,
					oneShotSelector !== undefined,
					guard,
				);
				return;
			}

			if (routeSuperseded(guard)) return;
			const targetIdentity = identityOf(target);
			if (!targetIdentity) return;
			const appliedAutomaticRouteToken =
				oneShotSelector === undefined ? ++automaticRouteTokenSequence : undefined;
			if (appliedAutomaticRouteToken !== undefined) {
				automaticRouteToken = appliedAutomaticRouteToken;
				automaticRouteGeneration = delegationGeneration;
				if (guard?.automaticMainTurn === true) {
					queueAutomaticMainTurn(delegationGeneration, appliedAutomaticRouteToken);
				}
			}
			const profileEffort = effort
				? resolveThinkingEffort(effort, config.thinkingProfiles[formatModelSelector(target)])
				: undefined;
			const thinking = profileEffort ? clampEffortToModel(profileEffort, target) : undefined;
			if (thinking) pi.setThinkingLevel(THINKING_LEVEL_BY_EFFORT[thinking]);
			runtime.observedModel = targetIdentity;
			runtime.lastAutoModel = targetIdentity;
			recordRouterDecision(runtime, {
				effort,
				selector: candidates[0],
				target: targetIdentity,
				thinking,
				outcome: "routed",
				reason: null,
				timestamp: now(),
				candidates: [...candidates],
				attempts,
				selectedCandidate,
				profileEffort,
			});
			if (oneShotSelector !== undefined) consumeOneShotSelector(runtime);
			persist(ctx);
			return {
				model: target,
				effort,
				thinking: thinking ? THINKING_LEVEL_BY_EFFORT[thinking] : undefined,
				automaticRouteToken: appliedAutomaticRouteToken,
			};
		};

		/**
		 * Serialize every route application: the detached delegation pipeline and a
		 * later main-path prompt share model/thinking/router state, so concurrent
		 * applyRoutePrompt runs would interleave setModel and decision records.
		 */
		let routeTurn: Promise<unknown> = Promise.resolve();
		const routePrompt = (
			event: InputEvent,
			ctx: ExtensionContext,
			guard?: RouteGuard,
		): Promise<RoutedPrompt | undefined> => {
			const run = routeTurn.then(() => applyRoutePrompt(event, ctx, guard));
			routeTurn = run.then(
				() => undefined,
				() => undefined,
			);
			return run;
		};

		const releaseDelegation = (runId: string, ctx: ExtensionContext): void => {
			if (activeDelegation?.runId !== runId) return;
			activeDelegation = undefined;
			// The workflow just went active -> idle; without a refresh the bar keeps saying "active".
			if (state) ctx.ui.setStatus(STATUS_KEY, routerStatus(state));
		};

		/**
		 * Session lifecycle fence: orphan the in-flight workflow so none of its
		 * record/replay/message paths can reach the successor session. Unlike
		 * `/route cancel` and shutdown, an invalidated workflow records nothing —
		 * not even a `cancelled` entry.
		 */
		const invalidateDelegation = (reason: string): void => {
			delegationGeneration += 1;
			markAutomaticMainTurnsStale();
			invalidateAutomaticRoute();
			const stale = activeDelegation;
			if (!stale) return;
			activeDelegation = undefined;
			stale.controller.abort(new Error(reason));
		};

		/** Measurement metadata must never fail routing, delegation, or replay. */
		const appendMeasurementEntry = (data: Record<string, unknown>): void => {
			try {
				pi.appendEntry(MODEL_ROUTER_DELEGATION_ENTRY, data);
			} catch (error) {
				pi.logger.warn(`model-router: measurement entry failed: ${conciseReason(error)}`);
			}
		};

		const armParentMeasurement = (
			runId: string,
			expectedPrefix: string,
			match: PendingParentMeasurement["match"],
		): void => {
			const record: PendingParentMeasurement = {
				runId,
				expectedPrefix,
				match,
				phase: "awaiting-user",
				assistantUsage: [],
				timer: setTimeout(() => {
					pendingParentMeasurements = pendingParentMeasurements.filter(pending => pending !== record);
				}, PARENT_CORRELATION_TIMEOUT_MS),
				onComplete: usage => appendMeasurementEntry({ status: "measured", runId, parentUsage: usage }),
			};
			record.timer.unref();
			pendingParentMeasurements.push(record);
		};

		/** Abort measurement work so a prior session can never consume later lifecycle events. */
		const resetMeasurement = (reason: string): void => {
			measurementGeneration += 1;
			shadowController?.abort(new Error(reason));
			shadowController = undefined;
			for (const record of pendingParentMeasurements) clearTimeout(record.timer);
			pendingParentMeasurements = [];
		};

		/** Synchronous gate; MUST NOT await so eligible input is claimed before any provider call. */
		const delegationEligible = (event: InputEvent, runtime: RouterState): boolean =>
			config.delegation.enabled &&
			runtime.mode === "auto" &&
			runtime.oneShotSelector === undefined &&
			activeDelegation === undefined &&
			(event.images === undefined || event.images.length === 0) &&
			event.text.trim().length >= config.classifierMinPromptChars;

		const processDelegation = async (
			event: InputEvent,
			ctx: ExtensionContext,
			workflow: DelegationWorkflow,
		): Promise<void> => {
			/** Keep cancellation entries behind the awaited restore/release settlement. */
			let cancelledDetail: Record<string, unknown> | undefined;
			let replayOriginalPending = false;
			let automaticRouteApplied = false;
			let automaticRouteAppliedToken: number | undefined;
			/** True once a session lifecycle reset orphaned this workflow; every append/replay/message path bails. */
			const invalidated = (): boolean => workflow.generation !== delegationGeneration;
			const record = (status: DelegationEntryStatus, detail: Record<string, unknown> = {}): void => {
				if (invalidated()) return;
				pi.appendEntry(MODEL_ROUTER_DELEGATION_ENTRY, {
					status,
					runId,
					request: workflow.request,
					startedAt: workflow.startedAt,
					measurement: {
						parentContextTokens: workflow.parentContextTokens,
						plannerUsage: workflow.plannerUsage,
						childUsage: workflow.childUsage,
					},
					...detail,
				});
			};
			const cancelled = (detail: Record<string, unknown> = {}): void => {
				if (invalidated()) return;
				cancelledDetail = { reason: String(controller.signal.reason ?? "cancelled"), ...detail };
			};
			const replayOriginal = (status: DelegationEntryStatus, reason: string): void => {
				if (invalidated()) return;
				if (automaticRouteApplied) {
					queueAutomaticMainTurn(workflow.generation, automaticRouteAppliedToken);
				}
				record(status, { reason });
				releaseDelegation(runId, ctx);
				armParentMeasurement(runId, workflow.request, "prefix");
				replayOriginalPending = true;
				pi.sendUserMessage(workflow.request, { deliverAs: "followUp" });
			};
			let delegated: { agent: AgentDefinition; task: string; model: string } | undefined;
			const childFailure = (rawReason: string): void => {
				if (!delegated || invalidated()) return;
				const reason = conciseReason(rawReason);
				record("failed", { agent: delegated.agent.name, task: delegated.task, model: delegated.model, reason });
				pi.sendMessage(
					{
						customType: MODEL_ROUTER_DELEGATION_MESSAGE,
						content: `Delegation to ${delegated.agent.name} failed: ${reason}\n\nRequest: ${workflow.request}`,
						display: true,
						details: { runId, agent: delegated.agent.name, task: delegated.task, model: delegated.model },
					},
					{ triggerTurn: false },
				);
				armParentMeasurement(runId, workflow.request, "prefix");
				pi.sendUserMessage(
					`${workflow.request}\n\nWarning: a delegated subagent attempt failed and may have produced side effects; inspect the current state before repeating work.`,
					{ deliverAs: "followUp" },
				);
			};
			try {
				const routed = await routePrompt(event, ctx, {
					generation: workflow.generation,
					signal: controller.signal,
				});
				if (controller.signal.aborted) return cancelled();
				if (!routed) return replayOriginal("passed-through", "no automatic route was applied");
				automaticRouteApplied = true;
				automaticRouteAppliedToken = routed.automaticRouteToken;
				const selector = formatModelSelector(routed.model);
				const discovery = await discover(ctx.cwd);
				if (controller.signal.aborted) return cancelled();
				const allowed = new Set(config.delegation.agents);
				const eligibleAgents = discovery.agents.filter(agent => allowed.has(agent.name));
				const repositoryIndex = await loadAgentIndex(ctx.cwd);
				if (controller.signal.aborted) return cancelled();
				const plan: DelegationPlan = await planWorkflow(
					workflow.request,
					routed.model,
					eligibleAgents.map(agent => ({ name: agent.name, description: agent.description })),
					repositoryIndex,
					config.delegation,
					{
						modelRegistry: ctx.modelRegistry,
						sessionId: ctx.sessionManager.getSessionId(),
						signal: controller.signal,
					},
				);
				workflow.plannerUsage = snapshotUsage(plan.usage);
				if (controller.signal.aborted) return cancelled();
				if (!plan.delegate) return replayOriginal("passed-through", plan.reason);
				const definition = eligibleAgents.find(agent => agent.name === plan.agent);
				if (!definition) return replayOriginal("failed", `planned agent ${plan.agent} is not available`);
				if (plan.task.trim().length === 0) return replayOriginal("failed", "planned task is empty");
				delegated = { agent: definition, task: plan.task, model: selector };
				record("delegated", {
					agent: definition.name,
					task: plan.task,
					model: selector,
					effort: routed.effort,
				});
				const result = await execute({
					cwd: ctx.cwd,
					agent: definition,
					task: plan.task,
					index: workflow.index,
					id: runId,
					modelOverride: selector,
					thinkingLevel: routed.thinking,
					signal: controller.signal,
					keepAlive: false,
				});
				workflow.childUsage = snapshotUsage(result.usage);
				if (controller.signal.aborted || invalidated()) return cancelled({ agent: definition.name });
				if (result.aborted) {
					return childFailure(result.abortReason ?? result.error ?? "subagent aborted before completion");
				}
				if (result.exitCode !== 0 || result.error) {
					return childFailure(result.error ?? `subagent exited with code ${result.exitCode}`);
				}
				record("completed", {
					agent: definition.name,
					task: plan.task,
					model: selector,
					effort: routed.effort,
				});
				pi.sendMessage(
					{
						customType: MODEL_ROUTER_DELEGATION_MESSAGE,
						content: `Delegated to ${definition.name}: ${workflow.request}\n\n${result.output}`,
						display: true,
						details: {
							runId,
							agent: definition.name,
							task: plan.task,
							model: selector,
							exitCode: result.exitCode,
							durationMs: result.durationMs,
						},
					},
					{ triggerTurn: false },
				);
			} catch (error) {
				if (controller.signal.aborted) return cancelled();
				const reason = conciseReason(error);
				pi.logger.warn(`model-router: delegation workflow ${runId} failed: ${reason}`);
				if (delegated) return childFailure(reason);
				return replayOriginal("failed", reason);
			} finally {
				if (!replayOriginalPending && automaticRouteAppliedToken !== undefined) {
					await restoreAutomaticBaseline(ctx, workflow.generation, automaticRouteAppliedToken);
				}
				releaseDelegation(runId, ctx);
				if (cancelledDetail) record("cancelled", cancelledDetail);
			}
		};

		/** Claim one workflow synchronously and start the async pipeline detached. */
		const claimDelegation = (event: InputEvent, ctx: ExtensionContext): InputEventResult => {
			delegationRunSequence += 1;
			const workflow: DelegationWorkflow = {
				runId: `model-router-delegation-${delegationRunSequence}`,
				index: delegationRunSequence,
				controller: new AbortController(),
				generation: delegationGeneration,
				request: event.text,
				startedAt: now(),
				parentContextTokens: ctx.getContextUsage()?.tokens ?? null,
				plannerUsage: null,
				childUsage: null,
			};
			activeDelegation = workflow;
			pi.appendEntry(MODEL_ROUTER_DELEGATION_ENTRY, {
				status: "pending",
				runId: workflow.runId,
				request: workflow.request,
				startedAt: workflow.startedAt,
				measurement: {
					parentContextTokens: workflow.parentContextTokens,
					plannerUsage: null,
					childUsage: null,
				},
			});
			void processDelegation(event, ctx, workflow).catch((error: unknown) => {
				pi.logger.warn(`model-router: delegation workflow ${workflow.runId} crashed: ${conciseReason(error)}`);
				releaseDelegation(workflow.runId, ctx);
			});
			return { handled: true };
		};

		/** Detached planner shadow for a sampled main-path prompt; never touches the main turn. */
		const startShadowMeasurement = (
			event: InputEvent,
			ctx: ExtensionContext,
			routed: RoutedPrompt | undefined,
		): void => {
			const measurement = config.delegation.measurement;
			if (!measurement.enabled) return;
			if (event.images !== undefined && event.images.length > 0) return;
			if (event.text.trim().length < config.classifierMinPromptChars) return;
			const model = routed?.model ?? currentModel(ctx);
			if (!model) return;
			const parentContextTokens = ctx.getContextUsage()?.tokens ?? null;
			if (!shouldSampleShadow(measurement.sampleRate, random())) return;
			shadowRunSequence += 1;
			const runId = `model-router-shadow-${shadowRunSequence}`;
			const startedAt = now();
			const generation = measurementGeneration;
			const recordShadow = (outcome: string, detail: Record<string, unknown> = {}): void => {
				if (generation !== measurementGeneration) return;
				appendMeasurementEntry({
					status: "shadow",
					runId,
					startedAt,
					outcome,
					model: formatModelSelector(model),
					parentContextTokens,
					sampleRate: measurement.sampleRate,
					durationMs: now() - startedAt,
					...detail,
				});
			};
			if (shadowController !== undefined) {
				recordShadow("skipped", { reason: "shadow active" });
				return;
			}
			const controller = new AbortController();
			shadowController = controller;
			armParentMeasurement(runId, event.text, "exact");
			const run = async (): Promise<void> => {
				try {
					const discovery = await discover(ctx.cwd);
					if (controller.signal.aborted) return recordShadow("cancelled");
					const allowed = new Set(config.delegation.agents);
					const eligibleAgents = discovery.agents.filter(agent => allowed.has(agent.name));
					if (eligibleAgents.length === 0) {
						return recordShadow("skipped", { reason: "no eligible agents" });
					}
					const repositoryIndex = await loadAgentIndex(ctx.cwd);
					if (controller.signal.aborted) return recordShadow("cancelled");
					const plan: DelegationPlan = await planWorkflow(
						event.text,
						model,
						eligibleAgents.map(agent => ({ name: agent.name, description: agent.description })),
						repositoryIndex,
						config.delegation,
						{
							modelRegistry: ctx.modelRegistry,
							sessionId: ctx.sessionManager.getSessionId(),
							signal: controller.signal,
						},
					);
					if (controller.signal.aborted) return recordShadow("cancelled");
					const plannerUsage = snapshotUsage(plan.usage);
					if (plan.delegate) {
						recordShadow("delegate", { agent: plan.agent, taskChars: plan.task.length, plannerUsage });
					} else {
						recordShadow("decline", { plannerUsage });
					}
				} catch (error) {
					if (controller.signal.aborted) return recordShadow("cancelled");
					pi.logger.warn(`model-router: shadow measurement ${runId} failed: ${conciseReason(error)}`);
					// Planner failures can quote raw planner output; persisted shadow metadata stays metadata-only.
					recordShadow("failed", { reason: error instanceof Error ? error.name : typeof error });
				} finally {
					if (shadowController === controller) shadowController = undefined;
				}
			};
			void run();
		};

		pi.registerCommand("route", {
			description: "Control effort-aware automatic model routing",
			getArgumentCompletions: argumentPrefix => routeArgumentCompletions(argumentPrefix, config),
			async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
				const parts = args.trim().split(/\s+/).filter(Boolean);
				const command = parts[0] ?? "status";
				if (command === "auto" && parts.length === 1) {
					await waitForAutomaticRestore();
					await settlePendingAutomaticMainTurn(ctx);
					transitionAuto(ctx);
					return;
				}
				if (command === "manual" && parts.length <= 2) {
					await waitForAutomaticRestore();
					await settlePendingAutomaticMainTurn(ctx);
					await transitionManual(ctx, parts[1]);
					return;
				}
				if (command === "off" && parts.length === 1) {
					await waitForAutomaticRestore();
					await settlePendingAutomaticMainTurn(ctx);
					transitionOff(ctx);
					return;
				}
				if (command === "status" && parts.length === 1) {
					const runtime = ensureState(ctx);
					const status = routerStatus(runtime);
					ctx.ui.setStatus(STATUS_KEY, status);
					ctx.ui.notify(status, "info");
					return;
				}
				if (command === "cancel" && parts.length === 1) {
					if (!activeDelegation) {
						ctx.ui.notify("Model router has no active delegation workflow", "info");
						return;
					}
					activeDelegation.controller.abort(new Error("model-router: delegation cancelled by /route cancel"));
					ctx.ui.notify("Model router delegation workflow cancelled", "info");
					return;
				}
				if (command === "explain" && parts.length === 1) {
					ctx.ui.notify(formatDecisionExplanation(ensureState(ctx), config), "info");
					return;
				}
				if (command === "history" && parts.length === 1) {
					ctx.ui.notify(formatDecisionHistory(ensureState(ctx)), "info");
					return;
				}
				if (command === "once" && parts.length === 2) {
					await waitForAutomaticRestore();
					await settlePendingAutomaticMainTurn(ctx);
					const selector = parts[1];
					if (!ctx.models.resolve(selector)) {
						ctx.ui.notify(`Model router could not resolve one-shot selector ${selector}`, "warning");
						return;
					}
					const runtime = ensureState(ctx);
					markAutomaticMainTurnsStale();
					armOneShotSelector(runtime, selector);
					persist(ctx);
					ctx.ui.notify(`One-shot routing armed for ${selector}`, "info");
					return;
				}
				if (command === "setup" && parts.length === 1) {
					await waitForAutomaticRestore();
					await settlePendingAutomaticMainTurn(ctx);
					const setupContext: RouterSetupContext = {
						cwd: ctx.cwd,
						hasUI: ctx.hasUI,
						ui: {
							select: (title, options) => ctx.ui.select(title, options),
							input: (title, placeholder) => ctx.ui.input(title, placeholder),
							confirm: (title, message) => ctx.ui.confirm(title, message),
							notify: (message, type) => ctx.ui.notify(message, type),
						},
						models: {
							list: () =>
								ctx.models.list().map(model => ({
									provider: model.provider,
									id: model.id,
									name: model.name,
								})),
						},
					};
					const result = await setup(setupContext, config);
					if (result.status === "written") {
						config = await readConfig({ cwd: ctx.cwd });
						const runtime = ensureState(ctx);
						if (!config.enabled && runtime.mode === "auto") {
							markAutomaticMainTurnsStale();
							invalidateAutomaticRoute();
							runtime.mode = "off";
							persist(ctx);
						} else {
							ctx.ui.setStatus(STATUS_KEY, routerStatus(runtime));
						}
					}
					return;
				}
				if (command === "reload" && parts.length === 1) {
					await waitForAutomaticRestore();
					await settlePendingAutomaticMainTurn(ctx);
					config = await readConfig({ cwd: ctx.cwd });
					const runtime = ensureState(ctx);
					if (!config.enabled && runtime.mode === "auto") {
						markAutomaticMainTurnsStale();
						invalidateAutomaticRoute();
						runtime.mode = "off";
						persist(ctx);
					} else {
						ctx.ui.setStatus(STATUS_KEY, routerStatus(runtime));
					}
					ctx.ui.notify("Model router configuration reloaded", "info");
					return;
				}
				ctx.ui.notify(COMMAND_USAGE, "warning");
			},
		});

		// `/parallel` is fully independent of `/route`: contract-first parallel
		// workflows with one coordinator per working directory. It never touches
		// router session state, and every failure surfaces as a UI warning.
		registerParallelCommand(pi, dependencies.parallel);

		const handleSessionLifecycle = async (
			_event: SessionStartEvent | SessionBranchEvent | SessionTreeEvent,
			ctx: ExtensionContext,
		): Promise<void> => {
			invalidateDelegation("model-router: delegation invalidated by session lifecycle");
			resetMeasurement("model-router: shadow cancelled by session lifecycle");
			await waitForAutomaticRestore();
			await rehydrate(ctx);
		};
		const handleSessionSwitch = async (_event: SessionSwitchEvent, ctx: ExtensionContext): Promise<void> => {
			invalidateDelegation("model-router: delegation invalidated by session switch");
			resetMeasurement("model-router: shadow cancelled by session switch");
			await waitForAutomaticRestore();
			await rehydrate(ctx, true);
		};
		pi.on("session_start", handleSessionLifecycle);
		pi.on("session_switch", handleSessionSwitch);
		pi.on("session_branch", handleSessionLifecycle);
		pi.on("session_tree", handleSessionLifecycle);
		pi.on("session_shutdown", async (_event: SessionShutdownEvent): Promise<void> => {
			markAutomaticMainTurnsStale();
			invalidateAutomaticRoute();
			activeDelegation?.controller.abort(new Error("model-router: delegation cancelled by session shutdown"));
			resetMeasurement("model-router: shadow cancelled by session shutdown");
			await waitForAutomaticRestore();
		});

		pi.on("message_end", async (event: MessageEndEvent): Promise<void> => {
			const message = event.message;
			if (message.role === "user") {
				const text = agentMessageText(message.content);
				for (const record of pendingParentMeasurements) {
					if (record.phase !== "awaiting-user") continue;
					const matched =
						record.match === "exact" ? text === record.expectedPrefix : text.startsWith(record.expectedPrefix);
					if (matched) {
						record.phase = "collecting-assistant";
						break;
					}
				}
				return;
			}
			if (message.role !== "assistant") return;
			const snapshot = snapshotUsage(message.usage);
			if (!snapshot) return;
			for (const record of pendingParentMeasurements) {
				if (record.phase === "collecting-assistant") record.assistantUsage.push(snapshot);
			}
		});

		pi.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext): Promise<void> => {
			if (event.willContinue === true) return;
			const automaticMainTurn = automaticMainTurns.shift();
			const settled = pendingParentMeasurements.filter(record => record.phase === "collecting-assistant");
			if (settled.length > 0) {
				pendingParentMeasurements = pendingParentMeasurements.filter(
					record => record.phase !== "collecting-assistant",
				);
				for (const record of settled) {
					clearTimeout(record.timer);
					record.onComplete(aggregateUsage(record.assistantUsage));
				}
			}
			if (automaticMainTurn && !automaticMainTurn.stale) {
				await restoreAutomaticBaseline(ctx, automaticMainTurn.generation, automaticMainTurn.routeToken);
			}
		});

		pi.registerMessageRenderer(MODEL_ROUTER_DELEGATION_MESSAGE, message => {
			const content =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter(
								(part): part is Extract<(typeof message.content)[number], { type: "text" }> =>
									part.type === "text",
							)
							.map(part => part.text)
							.join("\n");
			return new Text(content);
		});

		pi.on("input", async (event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult | void> => {
			if (!isMainIdleInput(event, ctx)) return;
			if (event.text === "/model auto") {
				await waitForAutomaticRestore();
				await settlePendingAutomaticMainTurn(ctx);
				transitionAuto(ctx);
				return { handled: true };
			}
			const text = event.text.trim();
			if (text === "/model" || text.startsWith("/model ")) {
				await waitForAutomaticRestore();
				await settlePendingAutomaticMainTurn(ctx);
				return;
			}
			if (text.length === 0 || text.startsWith("/") || text.startsWith("->") || text.startsWith("=>")) return;
			await waitForAutomaticRestore();
			await settlePendingAutomaticMainTurn(ctx);
			const runtime = ensureState(ctx);
			const inheritedAutomaticRouteToken =
				runtime.mode === "auto" &&
				runtime.oneShotSelector === undefined &&
				automaticRouteToken !== undefined &&
				runtime.lastAutoModel !== null &&
				modelsEqual(
					currentModel(ctx),
					ctx.models.resolve(formatModelSelector(runtime.lastAutoModel)),
				)
					? automaticRouteToken
					: undefined;
			if (inheritedAutomaticRouteToken !== undefined) {
				queueAutomaticMainTurn(delegationGeneration, inheritedAutomaticRouteToken);
			}
			if (delegationEligible(event, runtime)) return claimDelegation(event, ctx);
			const guard: RouteGuard = {
				generation: delegationGeneration,
				signal: new AbortController().signal,
				automaticMainTurn: true,
				inheritedAutomaticRouteToken,
			};
			const routed = await routePrompt(event, ctx, guard);
			if (routeSuperseded(guard)) return;
			startShadowMeasurement(event, ctx, routed);
		});
	};
}

const modelRouterExtension = createModelRouterExtension();
export default modelRouterExtension;
