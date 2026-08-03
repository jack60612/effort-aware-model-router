import type { Model } from "@oh-my-pi/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	InputEvent,
	InputEventResult,
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
}

/** Successfully applied route: the model now active for the prompt plus its applied efforts. */
export interface RoutedPrompt {
	model: Model;
	effort?: RouteEffort;
	thinking?: ExtensionThinkingLevel;
}

type DelegationEntryStatus = "pending" | "delegated" | "completed" | "failed" | "cancelled" | "passed-through";

interface DelegationWorkflow {
	runId: string;
	index: number;
	controller: AbortController;
	request: string;
	startedAt: number;
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

	return (pi: ExtensionAPI): void => {
		let config = defaultConfig();
		let state: RouterState | undefined;
		let activeDelegation: DelegationWorkflow | undefined;
		let delegationRunSequence = 0;

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

		const applyRoutePrompt = async (
			event: InputEvent,
			ctx: ExtensionContext,
		): Promise<RoutedPrompt | undefined> => {
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
			return {
				model: target,
				effort,
				thinking: thinking ? THINKING_LEVEL_BY_EFFORT[thinking] : undefined,
			};
		};

		/**
		 * Serialize every route application: the detached delegation pipeline and a
		 * later main-path prompt share model/thinking/router state, so concurrent
		 * applyRoutePrompt runs would interleave setModel and decision records.
		 */
		let routeTurn: Promise<unknown> = Promise.resolve();
		const routePrompt = (event: InputEvent, ctx: ExtensionContext): Promise<RoutedPrompt | undefined> => {
			const run = routeTurn.then(() => applyRoutePrompt(event, ctx));
			routeTurn = run.then(
				() => undefined,
				() => undefined,
			);
			return run;
		};

		const delegationStatus = (): string =>
			`delegation ${config.delegation.enabled ? "on" : "off"} (${activeDelegation ? "active" : "idle"})`;

		const releaseDelegation = (runId: string): void => {
			if (activeDelegation?.runId === runId) activeDelegation = undefined;
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
			const { runId, controller } = workflow;
			const record = (status: DelegationEntryStatus, detail: Record<string, unknown> = {}): void => {
				pi.appendEntry(MODEL_ROUTER_DELEGATION_ENTRY, {
					status,
					runId,
					request: workflow.request,
					startedAt: workflow.startedAt,
					...detail,
				});
			};
			const cancelled = (detail: Record<string, unknown> = {}): void => {
				record("cancelled", { reason: String(controller.signal.reason ?? "cancelled"), ...detail });
			};
			const replayOriginal = (status: DelegationEntryStatus, reason: string): void => {
				record(status, { reason });
				releaseDelegation(runId);
				pi.sendUserMessage(workflow.request, { deliverAs: "followUp" });
			};
			let delegated: { agent: AgentDefinition; task: string; model: string } | undefined;
			const childFailure = (rawReason: string): void => {
				if (!delegated) return;
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
				releaseDelegation(runId);
				pi.sendUserMessage(
					`${workflow.request}\n\nWarning: a delegated subagent attempt failed and may have produced side effects; inspect the current state before repeating work.`,
					{ deliverAs: "followUp" },
				);
			};
			try {
				const routed = await routePrompt(event, ctx);
				if (controller.signal.aborted) return cancelled();
				if (!routed) return replayOriginal("passed-through", "no automatic route was applied");
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
				if (controller.signal.aborted) return cancelled({ agent: definition.name });
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
				releaseDelegation(runId);
			}
		};

		/** Claim one workflow synchronously and start the async pipeline detached. */
		const claimDelegation = (event: InputEvent, ctx: ExtensionContext): InputEventResult => {
			delegationRunSequence += 1;
			const workflow: DelegationWorkflow = {
				runId: `model-router-delegation-${delegationRunSequence}`,
				index: delegationRunSequence,
				controller: new AbortController(),
				request: event.text,
				startedAt: now(),
			};
			activeDelegation = workflow;
			pi.appendEntry(MODEL_ROUTER_DELEGATION_ENTRY, {
				status: "pending",
				runId: workflow.runId,
				request: workflow.request,
				startedAt: workflow.startedAt,
			});
			void processDelegation(event, ctx, workflow).catch((error: unknown) => {
				pi.logger.warn(`model-router: delegation workflow ${workflow.runId} crashed: ${conciseReason(error)}`);
				releaseDelegation(workflow.runId);
			});
			return { handled: true };
		};

		pi.registerCommand("route", {
			description: "Control effort-aware automatic model routing",
			getArgumentCompletions: argumentPrefix => routeArgumentCompletions(argumentPrefix, config),
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
					const status = `${routeStatus(runtime)} · ${delegationStatus()}`;
					ctx.ui.setStatus(STATUS_KEY, status);
					ctx.ui.notify(status, "info");
					return;
				}
				if (command === "cancel" && parts.length === 1) {
					if (!activeDelegation) {
						ctx.ui.notify("Model router has no active delegation workflow", "info");
						return;
					}
					activeDelegation.controller.abort(
						new Error("model-router: delegation cancelled by /route cancel"),
					);
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
				if (command === "setup" && parts.length === 1) {
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
							runtime.mode = "off";
							persist(ctx);
						} else {
							ctx.ui.setStatus(STATUS_KEY, routeStatus(runtime));
						}
					}
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
		pi.on("session_shutdown", async (_event: SessionShutdownEvent): Promise<void> => {
			activeDelegation?.controller.abort(new Error("model-router: delegation cancelled by session shutdown"));
		});

		pi.registerMessageRenderer(MODEL_ROUTER_DELEGATION_MESSAGE, message => {
			const content =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
							.map(part => part.text)
							.join("\n");
			return new Text(content);
		});

		pi.on("input", async (event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult | void> => {
			if (!isMainIdleInput(event, ctx)) return;
			if (event.text === "/model auto") {
				transitionAuto(ctx);
				return { handled: true };
			}
			const text = event.text.trim();
			if (text.length === 0 || text.startsWith("/") || text.startsWith("->") || text.startsWith("=>")) return;
			if (delegationEligible(event, ensureState(ctx))) return claimDelegation(event, ctx);
			await routePrompt(event, ctx);
		});
	};
}

const modelRouterExtension = createModelRouterExtension();
export default modelRouterExtension;
