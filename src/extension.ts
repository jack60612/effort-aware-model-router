import type { Model } from "@oh-my-pi/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	InputEvent,
	InputEventResult,
	SessionBranchEvent,
	SessionStartEvent,
	SessionSwitchEvent,
	SessionTreeEvent,
} from "@oh-my-pi/pi-coding-agent";
import { classifyPromptEffort } from "./classifier";
import { DEFAULT_ROUTER_CONFIG, loadRouterConfig, type RouteEffort, type RouterConfig } from "./config";
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
import {
	armOneShotSelector,
	consumeOneShotSelector,
	createRouterState,
	encodeRouterState,
	isClassifierCoolingDown,
	MODEL_ROUTER_STATE_ENTRY,
	type ModelIdentity,
	parseRouterState,
	recordRouterDecision,
	type RouterCandidateAttempt,
	type RouterDecision,
	type RouterFailureReason,
	type RouterState,
} from "./state";

const STATUS_KEY = "model-router";
const COMMAND_USAGE =
	"Usage: /route auto | manual [selector] | off | status | explain | history | once <selector> | reload";

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
}

function identityOf(model: Pick<Model, "provider" | "id"> | undefined): ModelIdentity | null {
	return model ? { provider: model.provider, id: model.id } : null;
}

function modelLabel(model: ModelIdentity | null): string {
	return model ? `${model.provider}/${model.id}` : "unavailable";
}

function formatDecisionExplanation(state: RouterState): string {
	const decision = state.lastDecision;
	if (!decision) return `No routing decision yet. Baseline: ${modelLabel(state.baseline)}`;
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
		`Classified at: ${state.lastClassifiedAt ?? "never"}`,
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
	return `route:${state.mode} · ${effort} → ${modelLabel(decision.target)} · ${decision.outcome}`;
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
	};
}

/** Build an extension factory with narrow seams for direct behavior tests. */
export function createModelRouterExtension(
	dependencies: Partial<ModelRouterExtensionDependencies> = {},
): ExtensionFactory {
	const readConfig = dependencies.loadConfig ?? loadRouterConfig;
	const classify = dependencies.classify ?? classifyPromptEffort;
	const now = dependencies.now ?? Date.now;

	return (pi: ExtensionAPI): void => {
		let config = defaultConfig();
		let state: RouterState | undefined;

		const persist = (ctx: ExtensionContext): void => {
			if (!state) return;
			pi.appendEntry(MODEL_ROUTER_STATE_ENTRY, encodeRouterState(state));
			ctx.ui.setStatus(STATUS_KEY, routeStatus(state));
		};
		const switchModel = async (model: Model): Promise<boolean> => {
			try {
				return await pi.setModel(model);
			} catch {
				return false;
			}
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
			else ctx.ui.setStatus(STATUS_KEY, routeStatus(state));
		};

		const transitionAuto = (ctx: ExtensionContext): void => {
			const runtime = ensureState(ctx);
			const current = identityOf(currentModel(ctx));
			if (runtime.mode === "auto" && modelsEqual(runtime.baseline ?? undefined, current ?? undefined)) {
				ctx.ui.setStatus(STATUS_KEY, routeStatus(runtime));
				return;
			}
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
			runtime.mode = "manual";
			runtime.baseline = manual;
			runtime.observedModel = manual;
			runtime.lastAutoModel = null;
			runtime.lastDecision = null;
			persist(ctx);
			ctx.ui.notify(`Manual routing pinned to ${modelLabel(manual)}`, "info");
		};

		const fallbackToBaseline = async (
			ctx: ExtensionContext,
			effort: RouteEffort | undefined,
			selector: string | undefined,
			candidates: readonly string[],
			attempts: readonly RouterCandidateAttempt[],
			reason: RouterFailureReason,
			warning: string,
			consumeOneShot: boolean,
		): Promise<void> => {
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
			if (!modelsEqual(actualCurrent, fallbackModel) && !(await switchModel(fallbackModel))) {
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

		const routePrompt = async (event: InputEvent, ctx: ExtensionContext): Promise<void> => {
			const runtime = ensureState(ctx);
			const oneShotSelector = runtime.oneShotSelector;
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
					runtime.lastClassifiedAt = now();
				} catch {
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
				if (!modelsEqual(activeModel, candidateModel) && !(await switchModel(candidateModel))) {
					attempts.push({ selector: candidate, outcome: "auth" });
					continue;
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
				);
				return;
			}

			const targetIdentity = identityOf(target);
			if (!targetIdentity) return;
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
		};

		pi.registerCommand("route", {
			description: "Control effort-aware automatic model routing",
			async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
				const parts = args.trim().split(/\s+/).filter(Boolean);
				const command = parts[0] ?? "status";
				if (command === "auto" && parts.length === 1) {
					transitionAuto(ctx);
					return;
				}
				if (command === "manual" && parts.length <= 2) {
					await transitionManual(ctx, parts[1]);
					return;
				}
				if (command === "off" && parts.length === 1) {
					transitionOff(ctx);
					return;
				}
				if (command === "status" && parts.length === 1) {
					const runtime = ensureState(ctx);
					ctx.ui.setStatus(STATUS_KEY, routeStatus(runtime));
					ctx.ui.notify(routeStatus(runtime), "info");
					return;
				}
				if (command === "explain" && parts.length === 1) {
					ctx.ui.notify(formatDecisionExplanation(ensureState(ctx)), "info");
					return;
				}
				if (command === "history" && parts.length === 1) {
					ctx.ui.notify(formatDecisionHistory(ensureState(ctx)), "info");
					return;
				}
				if (command === "once" && parts.length === 2) {
					const selector = parts[1];
					if (!ctx.models.resolve(selector)) {
						ctx.ui.notify(`Model router could not resolve one-shot selector ${selector}`, "warning");
						return;
					}
					const runtime = ensureState(ctx);
					armOneShotSelector(runtime, selector);
					persist(ctx);
					ctx.ui.notify(`One-shot routing armed for ${selector}`, "info");
					return;
				}
				if (command === "reload" && parts.length === 1) {
					config = await readConfig({ cwd: ctx.cwd });
					const runtime = ensureState(ctx);
					if (!config.enabled && runtime.mode === "auto") {
						runtime.mode = "off";
						persist(ctx);
					} else {
						ctx.ui.setStatus(STATUS_KEY, routeStatus(runtime));
					}
					ctx.ui.notify("Model router configuration reloaded", "info");
					return;
				}
				ctx.ui.notify(COMMAND_USAGE, "warning");
			},
		});

		const handleSessionLifecycle = (
			_event: SessionStartEvent | SessionBranchEvent | SessionTreeEvent,
			ctx: ExtensionContext,
		): Promise<void> => rehydrate(ctx);
		const handleSessionSwitch = (_event: SessionSwitchEvent, ctx: ExtensionContext): Promise<void> =>
			rehydrate(ctx, true);
		pi.on("session_start", handleSessionLifecycle);
		pi.on("session_switch", handleSessionSwitch);
		pi.on("session_branch", handleSessionLifecycle);
		pi.on("session_tree", handleSessionLifecycle);

		pi.on("input", async (event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult | void> => {
			if (!isMainIdleInput(event, ctx)) return;
			if (event.text === "/model auto") {
				transitionAuto(ctx);
				return { handled: true };
			}
			const text = event.text.trim();
			if (text.length === 0 || text.startsWith("/") || text.startsWith("->") || text.startsWith("=>")) return;
			await routePrompt(event, ctx);
		});
	};
}

const modelRouterExtension = createModelRouterExtension();
export default modelRouterExtension;
