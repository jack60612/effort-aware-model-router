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
	selectThresholdSelector,
	type ThinkingEffort,
} from "./routing";
import {
	createRouterState,
	encodeRouterState,
	MODEL_ROUTER_STATE_ENTRY,
	type ModelIdentity,
	parseRouterState,
	type RouterFailureReason,
	type RouterState,
} from "./state";

const STATUS_KEY = "model-router";
const COMMAND_USAGE = "Usage: /route auto | manual [selector] | off | status | reload";

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
}

function identityOf(model: Pick<Model, "provider" | "id"> | undefined): ModelIdentity | null {
	return model ? { provider: model.provider, id: model.id } : null;
}

function modelLabel(model: ModelIdentity | null): string {
	return model ? `${model.provider}/${model.id}` : "unavailable";
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
		thresholds: { ...DEFAULT_ROUTER_CONFIG.thresholds },
		classifierModels: [...DEFAULT_ROUTER_CONFIG.classifierModels],
		maxEffort: DEFAULT_ROUTER_CONFIG.maxEffort,
		classifierTimeoutMs: DEFAULT_ROUTER_CONFIG.classifierTimeoutMs,
	};
}

/** Build an extension factory with narrow seams for direct behavior tests. */
export function createModelRouterExtension(
	dependencies: Partial<ModelRouterExtensionDependencies> = {},
): ExtensionFactory {
	const readConfig = dependencies.loadConfig ?? loadRouterConfig;
	const classify = dependencies.classify ?? classifyPromptEffort;

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
			reason: RouterFailureReason,
			warning: string,
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
					runtime.lastDecision = {
						effort,
						selector,
						target: observed,
						thinking: undefined,
						outcome: "baseline",
						reason,
					};
				}
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
			runtime.lastDecision = {
				effort,
				selector,
				target: { provider: fallbackModel.provider, id: fallbackModel.id },
				thinking: undefined,
				outcome: "baseline",
				reason,
			};
			persist(ctx);
		};

		const routePrompt = async (event: InputEvent, ctx: ExtensionContext): Promise<void> => {
			const runtime = ensureState(ctx);
			if (runtime.mode !== "auto") return;
			const activeModel = currentModel(ctx);
			const activeIdentity = identityOf(activeModel);
			const changedFromObserved = !modelsEqual(activeIdentity ?? undefined, runtime.observedModel ?? undefined);
			const differsFromLastAutomatic = !modelsEqual(activeIdentity ?? undefined, runtime.lastAutoModel ?? undefined);
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

			let effort: RouteEffort;
			try {
				effort = await classify(event.text, config, {
					models: ctx.models,
					modelRegistry: ctx.modelRegistry,
					sessionId: ctx.sessionManager.getSessionId(),
				});
			} catch {
				await fallbackToBaseline(
					ctx,
					undefined,
					undefined,
					"classifier",
					"Model router classifier failed; returned to baseline",
				);
				return;
			}

			const selector = selectThresholdSelector(effort, config.thresholds);
			if (!selector) {
				await fallbackToBaseline(
					ctx,
					effort,
					undefined,
					"threshold",
					"Model router found no matching threshold; returned to baseline",
				);
				return;
			}
			const target = ctx.models.resolve(selector);
			if (!target) {
				await fallbackToBaseline(
					ctx,
					effort,
					selector,
					"selector",
					`Model router could not resolve ${selector}; returned to baseline`,
				);
				return;
			}
			const usage = ctx.getContextUsage();
			if (!usage || !hasContextCapacity(target, usage.tokens, estimatePromptTokens(event.text))) {
				await fallbackToBaseline(
					ctx,
					effort,
					selector,
					"context",
					`Model router target ${selector} has insufficient context; returned to baseline`,
				);
				return;
			}
			if (!modelsEqual(activeModel, target) && !(await switchModel(target))) {
				await fallbackToBaseline(
					ctx,
					effort,
					selector,
					"auth",
					`Model router target ${selector} failed authentication; returned to baseline`,
				);
				return;
			}
			const thinking = clampEffortToModel(effort, target);
			if (thinking) pi.setThinkingLevel(THINKING_LEVEL_BY_EFFORT[thinking]);
			const targetIdentity = identityOf(target);
			if (!targetIdentity) return;
			runtime.observedModel = targetIdentity;
			runtime.lastAutoModel = targetIdentity;
			runtime.lastDecision = {
				effort,
				selector,
				target: targetIdentity,
				thinking,
				outcome: "routed",
				reason: null,
			};
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
