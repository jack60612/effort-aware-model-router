import { describe, expect, it } from "bun:test";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	InputEvent,
	InputEventResult,
} from "@oh-my-pi/pi-coding-agent";
import type { AgentDefinition, SingleResult } from "@oh-my-pi/pi-coding-agent/task";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import { Text } from "@oh-my-pi/pi-tui";
import type { RouteEffort, RouterConfig, RouterDelegationConfig } from "../src/config";
import type {
	DelegationAgentOption,
	DelegationPlan,
	DelegationPlannerConfig,
	DelegationPlannerContext,
} from "../src/delegation";
import {
	createModelRouterExtension,
	MODEL_ROUTER_DELEGATION_ENTRY,
	MODEL_ROUTER_DELEGATION_MESSAGE,
} from "../src/extension";
import type { RouterSetupContext } from "../src/setup";
import {
	createRouterState,
	encodeRouterState,
	MODEL_ROUTER_STATE_ENTRY,
	parseRouterState,
	type RouterState,
} from "../src/state";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type CommandHandler = CommandOptions["handler"];
type CommandCompletion = NonNullable<CommandOptions["getArgumentCompletions"]>;
type TestEntry = { type: string; customType?: string; data?: unknown };

type TestModel = Model & {
	reasoning: boolean;
	contextWindow: number;
	thinking?: { efforts?: readonly string[] };
};

function model(
	id: string,
	options: { reasoning?: boolean; efforts?: readonly string[]; contextWindow?: number } = {},
): TestModel {
	return {
		api: "openai-responses",
		provider: "mock",
		id,
		name: id,
		reasoning: options.reasoning ?? true,
		contextWindow: options.contextWindow ?? 32_000,
		thinking: options.efforts ? { efforts: options.efforts } : undefined,
	} as TestModel;
}

const base = model("base", { efforts: ["low", "medium", "high"] });
const smol = model("smol", { efforts: ["minimal", "low", "medium"] });
const slow = model("slow", { efforts: ["low", "high", "xhigh"] });
const plain = model("plain", { reasoning: false });

function routerConfig(overrides: Partial<RouterConfig> = {}): RouterConfig {
	return {
		enabled: true,
		thresholds: { low: ["@smol"], high: ["@slow"] },
		classifierModels: ["@tiny", "@smol"],
		maxEffort: "xhigh",
		classifierTimeoutMs: 4_000,
		classifierMinPromptChars: 0,
		classifierCooldownMs: 0,
		thinkingProfiles: {},
		delegation: { enabled: false, plannerTimeoutMs: 5_000, agents: ["scout", "task"] },
		...overrides,
	};
}

function delegationConfig(
	delegation: Partial<RouterDelegationConfig> = {},
	base: Partial<RouterConfig> = {},
): RouterConfig {
	return routerConfig({
		...base,
		delegation: { enabled: true, plannerTimeoutMs: 5_000, agents: ["scout", "task"], ...delegation },
	});
}

function agentDefinition(name: string, description: string): AgentDefinition {
	return { name, description, systemPrompt: `${name} system prompt`, source: "project" };
}

function singleResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "delegation-run",
		agent: "scout",
		agentSource: "project",
		task: "standalone task",
		exitCode: 0,
		output: "delegated output",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 1,
		requests: 1,
		...overrides,
	};
}

const pngImage: ImageContent = { type: "image", data: "aGk=", mimeType: "image/png" };

type PlanCall = {
	promptText: string;
	model: Model;
	agents: readonly DelegationAgentOption[];
	repositoryIndex: string;
	config: DelegationPlannerConfig;
	ctx: DelegationPlannerContext;
};
type PlanOutcome = DelegationPlan | Error | ((call: PlanCall) => Promise<DelegationPlan>);
type ExecuteOutcome = SingleResult | Error | ((options: ExecutorOptions) => Promise<SingleResult>);
type SentUserMessage = { content: unknown; deliverAs: string | undefined };
type SentCustomMessage = {
	customType: string | undefined;
	content: unknown;
	display: boolean | undefined;
	details: unknown;
	triggerTurn: boolean | undefined;
};
type CapturedRenderer = (message: unknown, options: unknown, theme: unknown) => unknown;

class Harness {
	readonly handlers = new Map<string, EventHandler>();
	readonly commands = new Map<string, CommandHandler>();
	readonly completions = new Map<string, CommandCompletion>();
	readonly entries: TestEntry[] = [];
	branchEntries: TestEntry[] | undefined;
	readonly notifications: Array<{ message: string; type: string | undefined }> = [];
	readonly statuses: Array<string | undefined> = [];
	readonly setModelCalls: Model[] = [];
	readonly thinkingCalls: string[] = [];
	readonly resolvedSelectors: string[] = [];
	readonly classifierPrompts: string[] = [];
	current: TestModel | undefined = base;
	idle = true;
	pending = false;
	parentSession: string | undefined;
	contextTokens = 100;
	contextAvailable = true;
	setModelResults: Array<boolean | Error> = [];
	config = routerConfig();
	now = 1_000;
	loadCount = 0;
	setupCalls = 0;
	setupContexts: RouterSetupContext[] = [];
	classifications: Array<RouteEffort | Error | (() => Promise<RouteEffort>)> = ["low"];
	readonly renderers = new Map<string, CapturedRenderer>();
	readonly userMessages: SentUserMessage[] = [];
	readonly customMessages: SentCustomMessage[] = [];
	readonly sequence: string[] = [];
	readonly planCalls: PlanCall[] = [];
	planResults: PlanOutcome[] = [];
	readonly discoverCalls: string[] = [];
	discoveredAgents: AgentDefinition[] = [
		agentDefinition("scout", "read-only recon"),
		agentDefinition("task", "general worker"),
		agentDefinition("rogue", "not allowlisted"),
	];
	readonly executeCalls: ExecutorOptions[] = [];
	executeResults: ExecuteOutcome[] = [];
	agentIndex = "repository index text";

	readonly selectors = new Map<string, TestModel>([
		["@smol", smol],
		["@slow", slow],
		["@plain", plain],
		["mock/base", base],
		["mock/smol", smol],
		["mock/slow", slow],
		["mock/plain", plain],
	]);

	readonly api: ExtensionAPI;
	readonly ctx: ExtensionCommandContext;

	constructor(seedEntries: TestEntry[] = []) {
		this.entries.push(...seedEntries);
		const self = this;
		this.api = {
			on(event: string, handler: EventHandler): void {
				self.handlers.set(event, handler);
			},
			registerCommand(name: string, options: CommandOptions): void {
				self.commands.set(name, options.handler);
				if (options.getArgumentCompletions) self.completions.set(name, options.getArgumentCompletions);
			},
			appendEntry(customType: string, data?: unknown): void {
				const entry = { type: "custom", customType, data };
				self.entries.push(entry);
				self.branchEntries?.push(entry);
			},
			async setModel(selected: Model): Promise<boolean> {
				self.setModelCalls.push(selected);
				self.sequence.push(`setModel:${selected.id}`);
				const result = self.setModelResults.shift() ?? true;
				if (result instanceof Error) throw result;
				if (result) self.current = selected as TestModel;
				return result;
			},
			setThinkingLevel(level: string): void {
				self.thinkingCalls.push(level);
			},
			registerMessageRenderer(customType: string, renderer: CapturedRenderer): void {
				self.renderers.set(customType, renderer);
			},
			sendMessage(message: Record<string, unknown>, options?: { triggerTurn?: boolean }): void {
				self.sequence.push("sendMessage");
				self.customMessages.push({
					customType: message.customType as string | undefined,
					content: message.content,
					display: message.display as boolean | undefined,
					details: message.details,
					triggerTurn: options?.triggerTurn,
				});
			},
			sendUserMessage(content: unknown, options?: { deliverAs?: string }): void {
				self.sequence.push("sendUserMessage");
				self.userMessages.push({ content, deliverAs: options?.deliverAs });
			},
			logger: { warn(): void {}, debug(): void {}, error(): void {}, info(): void {} },
		} as unknown as ExtensionAPI;
		this.ctx = {
			cwd: "/project",
			hasUI: true,
			get model() {
				return self.current;
			},
			models: {
				current: () => self.current,
				list: () => [...new Set(self.selectors.values())],
				resolve(selector: string): Model | undefined {
					self.resolvedSelectors.push(selector);
					return self.selectors.get(selector);
				},
				family: (selected: Model) => selected.id,
			},
			modelRegistry: {} as ExtensionContext["modelRegistry"],
			sessionManager: {
				getSessionId: () => "session-1",
				getHeader: () => ({
					type: "session",
					id: "session-1",
					timestamp: "2026-08-01T00:00:00.000Z",
					cwd: "/project",
					parentSession: self.parentSession,
				}),
				getEntries: () => [...self.entries],
				getBranch: () => [...(self.branchEntries ?? self.entries)],
			} as unknown as ExtensionContext["sessionManager"],
			ui: {
				notify(message: string, type?: "info" | "warning" | "error"): void {
					self.notifications.push({ message, type });
				},
				setStatus(_key: string, text: string | undefined): void {
					self.statuses.push(text);
				},
			} as unknown as ExtensionContext["ui"],
			isIdle: () => self.idle,
			hasPendingMessages: () => self.pending,
			getContextUsage: () =>
				self.contextAvailable
					? { tokens: self.contextTokens, contextWindow: self.current?.contextWindow ?? 0, percent: 1 }
					: undefined,
			waitForIdle: async () => {},
			reload: async () => {},
		} as unknown as ExtensionCommandContext;
		createModelRouterExtension({
			loadConfig: async () => {
				this.loadCount += 1;
				return this.config;
			},
			classify: async prompt => {
				this.classifierPrompts.push(prompt);
				const next = this.classifications.shift() ?? "low";
				if (next instanceof Error) throw next;
				if (typeof next === "function") return next();
				return next;
			},
			now: () => this.now,
			setup: async context => {
				this.setupCalls += 1;
				this.setupContexts.push(context);
				return { status: "written", path: "/project/.omp/model-router.json" };
			},
			plan: async (promptText, model, agents, repositoryIndex, config, ctx) => {
				const call: PlanCall = { promptText, model, agents, repositoryIndex, config, ctx };
				this.sequence.push("plan");
				this.planCalls.push(call);
				const next = this.planResults.shift() ?? { delegate: false, reason: "default pass-through" };
				if (next instanceof Error) throw next;
				if (typeof next === "function") return next(call);
				return next;
			},
			discover: async (cwd: string) => {
				this.discoverCalls.push(cwd);
				return { agents: [...this.discoveredAgents], projectAgentsDir: null };
			},
			execute: async options => {
				this.sequence.push("execute");
				this.executeCalls.push(options);
				const next = this.executeResults.shift();
				if (next === undefined) {
					return singleResult({
						index: options.index,
						id: options.id,
						agent: options.agent.name,
						task: options.task,
					});
				}
				if (next instanceof Error) throw next;
				if (typeof next === "function") return next(options);
				return next;
			},
			loadAgentIndex: async () => this.agentIndex,
		})(this.api);
	}

	async lifecycle(name = "session_start"): Promise<void> {
		await this.handlers.get(name)?.({ type: name }, this.ctx);
	}

	async input(
		text: string,
		source: InputEvent["source"] = "interactive",
		images?: ImageContent[],
	): Promise<InputEventResult | undefined> {
		return (await this.handlers.get("input")?.({ type: "input", text, source, images }, this.ctx)) as
			| InputEventResult
			| undefined;
	}

	async shutdown(): Promise<void> {
		await this.handlers.get("session_shutdown")?.({ type: "session_shutdown" }, this.ctx);
	}

	/** Flush microtask turns until the fire-and-forget pipeline reaches the observable state. */
	async settle(predicate: () => boolean): Promise<void> {
		for (let turn = 0; turn < 1_000; turn += 1) {
			if (predicate()) return;
			await Promise.resolve();
		}
		throw new Error("delegation workflow did not settle");
	}

	delegationEntries(): Array<Record<string, unknown>> {
		return this.entries
			.filter(entry => entry.customType === MODEL_ROUTER_DELEGATION_ENTRY)
			.map(entry => entry.data as Record<string, unknown>);
	}

	async command(args: string): Promise<void> {
		await this.commands.get("route")?.(args, this.ctx);
	}
	complete(argumentPrefix: string) {
		return this.completions.get("route")?.(argumentPrefix) ?? null;
	}

	state(): RouterState {
		for (let index = this.entries.length - 1; index >= 0; index -= 1) {
			const entry = this.entries[index];
			if (entry.customType !== MODEL_ROUTER_STATE_ENTRY) continue;
			const parsed = parseRouterState(entry.data);
			if (parsed) return parsed;
		}
		throw new Error("missing router state");
	}
}

describe("model router extension", () => {
	it("registers public lifecycle/input handlers and the route command", () => {
		const harness = new Harness();
		expect([...harness.handlers.keys()].sort()).toEqual([
			"input",
			"session_branch",
			"session_shutdown",
			"session_start",
			"session_switch",
			"session_tree",
		]);
		expect(harness.commands.has("route")).toBe(true);
	});

	it("restores state on every session reconstruction lifecycle", async () => {
		for (const lifecycle of ["session_start", "session_switch", "session_branch", "session_tree"]) {
			const restored = { ...createRouterState(base), mode: "manual" as const };
			const harness = new Harness([
				{ type: "custom", customType: MODEL_ROUTER_STATE_ENTRY, data: encodeRouterState(restored) },
			]);
			await harness.lifecycle(lifecycle);
			expect(harness.state().mode).toBe("manual");
			expect(harness.statuses.at(-1)).toContain("manual");
		}
	});

	it("restores only the current branch state when abandoned history is newer", async () => {
		const currentBranchState = { ...createRouterState(base), mode: "manual" as const };
		const abandonedState = { ...createRouterState(slow), mode: "off" as const };
		const currentEntry: TestEntry = {
			type: "custom",
			customType: MODEL_ROUTER_STATE_ENTRY,
			data: encodeRouterState(currentBranchState),
		};
		const abandonedEntry: TestEntry = {
			type: "custom",
			customType: MODEL_ROUTER_STATE_ENTRY,
			data: encodeRouterState(abandonedState),
		};
		const harness = new Harness([currentEntry, abandonedEntry]);
		harness.branchEntries = [currentEntry];
		await harness.lifecycle("session_tree");
		await harness.input("must remain manual");
		expect(harness.statuses.at(-1)).toContain("manual");
		expect(harness.classifierPrompts).toEqual([]);
	});

	it("defers a missing switched-session baseline until the target model is restored", async () => {
		const harness = new Harness();
		harness.current = base;
		await harness.lifecycle("session_start");
		harness.branchEntries = [];
		await harness.lifecycle("session_switch");
		harness.current = slow;
		await harness.input("first prompt in B");
		expect(harness.classifierPrompts).toEqual(["first prompt in B"]);
		expect(harness.setModelCalls.map(selected => selected.id)).toEqual(["smol"]);
		expect(harness.state()).toMatchObject({
			mode: "auto",
			baseline: { provider: "mock", id: "slow" },
		});
	});

	it("routes consecutive low and high prompts before normal input continues", async () => {
		const harness = new Harness();
		harness.classifications = ["low", "high"];
		await harness.lifecycle();
		expect(await harness.input("rename this symbol")).toBeUndefined();
		expect(await harness.input("debug this cross-system race")).toBeUndefined();
		expect(harness.classifierPrompts).toEqual(["rename this symbol", "debug this cross-system race"]);
		expect(harness.setModelCalls.map(selected => selected.id)).toEqual(["smol", "slow"]);
		expect(harness.state().lastDecision).toMatchObject({ effort: "high", selector: "@slow", outcome: "routed" });
		expect(harness.statuses.at(-1)).toContain("baseline mock/base");
	});

	it("avoids same-model resets, clamps effort, and does not mutate thinking for plain targets", async () => {
		const harness = new Harness();
		harness.current = smol;
		harness.classifications = ["medium", "high"];
		harness.config = routerConfig({ thresholds: { low: ["@smol"], high: ["@plain"] } });
		await harness.lifecycle();
		await harness.input("localized work");
		expect(harness.setModelCalls).toEqual([]);
		expect(harness.thinkingCalls).toEqual(["medium"]);
		await harness.input("hard work");
		expect(harness.setModelCalls.map(selected => selected.id)).toEqual(["plain"]);
		expect(harness.thinkingCalls).toEqual(["medium"]);
	});

	it("clamps unsupported high effort downward on a reasoning model", async () => {
		const harness = new Harness();
		harness.classifications = ["xhigh"];
		harness.config = routerConfig({ thresholds: { high: ["@smol"] } });
		await harness.lifecycle();
		await harness.input("deep task");
		expect(harness.thinkingCalls).toEqual(["medium"]);
		expect(harness.state().lastDecision?.thinking).toBe("medium");
	});

	it("detects an external model change and pins manual before classification", async () => {
		const harness = new Harness();
		await harness.lifecycle();
		harness.current = slow;
		await harness.input("do not classify me");
		expect(harness.classifierPrompts).toEqual([]);
		expect(harness.state()).toMatchObject({ mode: "manual", baseline: { provider: "mock", id: "slow" } });
	});

	it("makes explicit manual mode reliable even when pinning the last automatic model", async () => {
		const harness = new Harness();
		await harness.lifecycle();
		await harness.input("easy");
		await harness.command("manual");
		expect(harness.state().mode).toBe("manual");
		await harness.input("still easy");
		expect(harness.classifierPrompts).toEqual(["easy"]);
	});

	it("supports manual selectors, off, auto, status, and reload commands", async () => {
		const harness = new Harness();
		await harness.lifecycle();
		await harness.command("manual @slow");
		expect(harness.state()).toMatchObject({ mode: "manual", baseline: { id: "slow" } });
		await harness.command("off");
		expect(harness.state().mode).toBe("off");
		await harness.command("auto");
		expect(harness.state().mode).toBe("auto");
		const entriesBeforeStatus = harness.entries.length;
		await harness.command("status");
		expect(harness.entries).toHaveLength(entriesBeforeStatus);
		await harness.command("reload");
		expect(harness.loadCount).toBe(2);
		expect(harness.notifications.some(item => item.message.includes("reloaded"))).toBe(true);
	});
	it("includes setup in invalid-command usage", async () => {
		const harness = new Harness();
		await harness.lifecycle();
		await harness.command("not-a-route-command");
		expect(harness.notifications.at(-1)?.message).toContain("setup");
	});
	it("offers every route command and preserves prefixes for selector completions", async () => {
		const harness = new Harness();
		harness.config = routerConfig({ thresholds: { low: ["@smol"] } });
		await harness.lifecycle();
		const values = (prefix: string): string[] => harness.complete(prefix)?.map(item => item.value) ?? [];

		expect(values("")).toEqual([
			"auto",
			"manual",
			"off",
			"status",
			"explain",
			"history",
			"once",
			"cancel",
			"setup",
			"reload",
		]);
		expect(values("can")).toEqual(["cancel"]);
		expect(values("set")).toEqual(["setup"]);
		expect(values("manual ")).toContain("manual @tiny");
		expect(values("once @t")).toContain("once @tiny");
		expect(values("manual @s")).toContain("manual @slow");
		expect(values("once @d")).toContain("once @default");
	});
	it("routes /route setup through the public UI seam and reloads written config", async () => {
		const harness = new Harness();
		await harness.lifecycle();
		await harness.command("setup");

		expect(harness.setupCalls).toBe(1);
		expect(harness.loadCount).toBe(2);
		expect(harness.setupContexts[0]?.hasUI).toBe(true);
		expect(harness.setupContexts[0]?.models.list().map(model => `${model.provider}/${model.id}`)).toContain(
			"mock/smol",
		);
	});

	it("intercepts exact interactive /model auto as the auto command alias", async () => {
		const harness = new Harness();
		await harness.lifecycle();
		await harness.command("off");
		expect(await harness.input("/model auto")).toEqual({ handled: true });
		expect(harness.state().mode).toBe("auto");
		expect(await harness.input("/model auto ")).toBeUndefined();
	});

	it("falls back to baseline on route auth failure and deduplicates its warning", async () => {
		const harness = new Harness();
		harness.classifications = ["high", "low", "low"];
		harness.setModelResults = [true, false, true, false];
		await harness.lifecycle();
		await harness.input("first hard");
		await harness.input("then easy");
		expect(harness.setModelCalls.map(selected => selected.id)).toEqual(["slow", "smol", "base"]);
		expect(harness.state().lastDecision).toMatchObject({
			outcome: "baseline",
			reason: "auth",
			target: { id: "base" },
		});
		await harness.input("easy again");
		const authWarnings = harness.notifications.filter(item => item.message.includes("authentication"));
		expect(authWarnings).toHaveLength(1);
	});

	it("falls back before switching when the target context is too small", async () => {
		const tiny = model("tiny-context", { contextWindow: 100 });
		const harness = new Harness();
		harness.selectors.set("@tiny-context", tiny);
		harness.config = routerConfig({ thresholds: { low: ["@tiny-context"] } });
		harness.contextTokens = 99;
		await harness.lifecycle();
		await harness.input("this prompt cannot fit");
		expect(harness.setModelCalls).toEqual([]);
		expect(harness.state().lastDecision).toMatchObject({ outcome: "baseline", reason: "context" });
	});

	it("treats unknown context usage as unsafe and returns to baseline", async () => {
		const harness = new Harness();
		harness.contextAvailable = false;
		await harness.lifecycle();
		await harness.input("unknown context");
		expect(harness.setModelCalls).toEqual([]);
		expect(harness.state().lastDecision).toMatchObject({ outcome: "baseline", reason: "context" });
	});

	it("falls back after classifier and selector failures without trying lower thresholds", async () => {
		const routedSlow: RouterState = {
			...createRouterState(base),
			observedModel: { provider: "mock", id: "slow" },
			lastAutoModel: { provider: "mock", id: "slow" },
		};
		const resumedEntry: TestEntry = {
			type: "custom",
			customType: MODEL_ROUTER_STATE_ENTRY,
			data: encodeRouterState(routedSlow),
		};
		const classifierFailure = new Harness([resumedEntry]);
		classifierFailure.current = slow;
		classifierFailure.classifications = [new Error("timeout")];
		await classifierFailure.lifecycle();
		await classifierFailure.input("classify");
		expect(classifierFailure.setModelCalls.map(selected => selected.id)).toEqual(["base"]);
		expect(classifierFailure.state().lastDecision?.reason).toBe("classifier");

		const selectorFailure = new Harness([resumedEntry]);
		selectorFailure.current = slow;
		selectorFailure.config = routerConfig({ thresholds: { low: ["@smol"], high: ["@missing"] } });
		selectorFailure.classifications = ["high"];
		await selectorFailure.lifecycle();
		await selectorFailure.input("hard");
		expect(selectorFailure.resolvedSelectors).toEqual(["@missing", "mock/base"]);
		expect(selectorFailure.state().lastDecision?.reason).toBe("selector");
	});

	it("resumes an automatic route without misreading its last target as manual", async () => {
		const resumed: RouterState = {
			...createRouterState(base),
			observedModel: { provider: "mock", id: "slow" },
			lastAutoModel: { provider: "mock", id: "slow" },
		};
		const harness = new Harness([
			{ type: "custom", customType: MODEL_ROUTER_STATE_ENTRY, data: encodeRouterState(resumed) },
		]);
		harness.current = slow;
		await harness.lifecycle();
		await harness.input("easy after resume");
		expect(harness.classifierPrompts).toEqual(["easy after resume"]);
		expect(harness.state().mode).toBe("auto");
		expect(harness.setModelCalls.map(selected => selected.id)).toEqual(["smol"]);
	});

	it("handles target and baseline switch rejections without escaping the input hook", async () => {
		const routedSlow: RouterState = {
			...createRouterState(base),
			observedModel: { provider: "mock", id: "slow" },
			lastAutoModel: { provider: "mock", id: "slow" },
		};
		const resumedEntry: TestEntry = {
			type: "custom",
			customType: MODEL_ROUTER_STATE_ENTRY,
			data: encodeRouterState(routedSlow),
		};
		const targetRejection = new Harness([resumedEntry]);
		targetRejection.current = slow;
		targetRejection.setModelResults = [new Error("target rejected"), true];
		await targetRejection.lifecycle();
		await targetRejection.input("easy");
		expect(targetRejection.setModelCalls.map(selected => selected.id)).toEqual(["smol", "base"]);
		expect(targetRejection.state().lastDecision).toMatchObject({ outcome: "baseline", reason: "auth" });

		const baselineRejection = new Harness([resumedEntry]);
		baselineRejection.current = slow;
		baselineRejection.classifications = [new Error("classifier failed")];
		baselineRejection.setModelResults = [new Error("baseline rejected")];
		await baselineRejection.lifecycle();
		await baselineRejection.input("classify");
		expect(baselineRejection.setModelCalls.map(selected => selected.id)).toEqual(["base"]);
		expect(baselineRejection.state().lastDecision).toMatchObject({ outcome: "baseline", reason: "classifier" });
		expect(baselineRejection.notifications.some(item => item.message.includes("stored baseline"))).toBe(true);
	});

	it("keeps the previous mode when a manual selector switch rejects", async () => {
		const harness = new Harness();
		harness.setModelResults = [new Error("manual rejected")];
		await harness.lifecycle();
		await harness.command("manual @slow");
		expect(harness.state().mode).toBe("auto");
		expect(harness.notifications.some(item => item.message.includes("authenticate manual selector"))).toBe(true);
	});

	it("skips unsupported sources, busy/pending/subagent sessions, commands, queues, and blank input", async () => {
		const harness = new Harness();
		await harness.lifecycle();
		await harness.input("rpc", "rpc");
		await harness.input("extension", "extension");
		harness.idle = false;
		await harness.input("busy");
		harness.idle = true;
		harness.pending = true;
		await harness.input("pending");
		harness.pending = false;
		harness.parentSession = "parent";
		await harness.input("subagent");
		harness.parentSession = undefined;
		for (const text of ["", "   ", "/help", "-> queued", "=> follow up"]) await harness.input(text);
		expect(harness.classifierPrompts).toEqual([]);
		expect(harness.setModelCalls).toEqual([]);
	});

	it("tries ordered candidates through resolution and authentication before baseline fallback", async () => {
		const first = model("first");
		const second = model("second");
		const harness = new Harness();
		harness.selectors.set("@first", first);
		harness.selectors.set("@second", second);
		harness.config = routerConfig({ thresholds: { low: ["@missing", "@first", "@second"] } });
		harness.setModelResults = [false, true];
		await harness.lifecycle();
		await harness.input("try candidates");

		expect(harness.resolvedSelectors).toEqual(["@missing", "@first", "@second"]);
		expect(harness.setModelCalls.map(selected => selected.id)).toEqual(["first", "second"]);
		expect(harness.state().lastDecision).toMatchObject({
			outcome: "routed",
			candidates: ["@missing", "@first", "@second"],
			selectedCandidate: "@second",
			attempts: [
				{ selector: "@missing", outcome: "selector" },
				{ selector: "@first", outcome: "auth" },
				{ selector: "@second", outcome: "selected" },
			],
		});
	});

	it("skips a context-incompatible candidate and routes to the next candidate", async () => {
		const tiny = model("tiny", { contextWindow: 100 });
		const second = model("second");
		const harness = new Harness();
		harness.selectors.set("@tiny", tiny);
		harness.selectors.set("@second", second);
		harness.config = routerConfig({ thresholds: { low: ["@tiny", "@second"] } });
		harness.contextTokens = 100;
		await harness.lifecycle();
		await harness.input("next");

		expect(harness.setModelCalls.map(selected => selected.id)).toEqual(["second"]);
		expect(harness.state().lastDecision?.attempts).toEqual([
			{ selector: "@tiny", outcome: "context" },
			{ selector: "@second", outcome: "selected" },
		]);
	});

	it("applies exact model thinking profiles before metadata clamping", async () => {
		const harness = new Harness();
		harness.config = routerConfig({
			thresholds: { high: ["@smol"] },
			thinkingProfiles: { "mock/smol": { default: "low", xhigh: "high" } },
		});
		harness.classifications = ["xhigh"];
		await harness.lifecycle();
		await harness.input("profiled effort");

		expect(harness.thinkingCalls).toEqual(["medium"]);
		expect(harness.state().lastDecision).toMatchObject({
			profileEffort: "high",
			thinking: "medium",
		});
	});

	it("skips short prompts and classifier calls inside the cooldown window", async () => {
		const harness = new Harness();
		harness.config = routerConfig({ classifierMinPromptChars: 8, classifierCooldownMs: 1_000 });
		harness.classifications = ["low", "high"];
		await harness.lifecycle();
		await harness.input("short");
		expect(harness.classifierPrompts).toEqual([]);

		await harness.input("long enough");
		expect(harness.classifierPrompts).toEqual(["long enough"]);
		harness.now = 1_500;
		await harness.input("cooldown prompt");
		expect(harness.classifierPrompts).toEqual(["long enough"]);
		harness.now = 2_000;
		await harness.input("after cooldown");
		expect(harness.classifierPrompts).toEqual(["long enough", "after cooldown"]);
	});

	it("routes one explicit prompt without changing persistent mode", async () => {
		const harness = new Harness();
		await harness.lifecycle();
		await harness.command("off");
		await harness.command("once @slow");
		await harness.input("one shot");

		expect(harness.classifierPrompts).toEqual([]);
		expect(harness.setModelCalls.map(selected => selected.id)).toEqual(["slow"]);
		expect(harness.state().mode).toBe("off");
		expect(harness.state().oneShotSelector).toBeUndefined();
	});

	it("explains the latest decision and bounded history through commands", async () => {
		const harness = new Harness();
		harness.classifications = ["low", "high"];
		await harness.lifecycle();
		await harness.input("easy");
		await harness.input("hard");
		await harness.command("explain");
		await harness.command("history");

		const messages = harness.notifications.map(item => item.message).join("\n");
		expect(messages).toContain("Candidates");
		expect(messages).toContain("history");
		expect(messages).toContain("@slow");
		expect(messages).toContain("Classifier minimum: 0 characters");
		expect(messages).toContain("Classifier cooldown: 0 ms");
	});

	it("restores legacy version-1 state through the lifecycle hook", async () => {
		const harness = new Harness([
			{
				type: "custom",
				customType: MODEL_ROUTER_STATE_ENTRY,
				data: {
					version: 1,
					mode: "manual",
					baseline: base,
					observedModel: base,
					lastAutoModel: null,
					lastDecision: null,
					warningKeys: [],
				},
			},
		]);
		await harness.lifecycle();
		expect(harness.state().version).toBe(2);
		expect(harness.state().history).toEqual([]);
	});
});

describe("model router delegation", () => {
	function deferredEffort(): { classify: () => Promise<RouteEffort>; resolve: (effort: RouteEffort) => void } {
		const { promise, resolve } = Promise.withResolvers<RouteEffort>();
		return { classify: () => promise, resolve };
	}

	function abortablePlan(call: PlanCall): Promise<DelegationPlan> {
		const { promise, reject } = Promise.withResolvers<DelegationPlan>();
		call.ctx.signal?.addEventListener("abort", () => reject(call.ctx.signal?.reason ?? new Error("aborted")));
		return promise;
	}

	function abortableExecute(options: ExecutorOptions): Promise<SingleResult> {
		const { promise, reject } = Promise.withResolvers<SingleResult>();
		options.signal?.addEventListener("abort", () => reject(options.signal?.reason ?? new Error("aborted")));
		return promise;
	}

	async function enabledHarness(): Promise<Harness> {
		const harness = new Harness();
		harness.config = delegationConfig();
		await harness.lifecycle();
		return harness;
	}

	async function successfulDelegation(): Promise<Harness> {
		const harness = await enabledHarness();
		harness.classifications = ["low"];
		harness.planResults = [{ delegate: true, agent: "scout", task: "standalone task assignment" }];
		harness.executeResults = [singleResult({ output: "child output text" })];
		expect(await harness.input("summarize the repository layout")).toEqual({ handled: true });
		await harness.settle(() => harness.customMessages.length === 1);
		return harness;
	}

	it("keeps slash commands and queued prefixes outside delegation", async () => {
		const harness = await enabledHarness();
		for (const text of ["/usage", "/route status", "-> shell command", "=> python snippet"]) {
			expect(await harness.input(text)).toBeUndefined();
		}
		expect(harness.planCalls).toEqual([]);
		expect(harness.delegationEntries()).toEqual([]);
	});

	it("keeps image, short, and non-interactive input on the main path", async () => {
		const harness = new Harness();
		harness.config = delegationConfig({}, { classifierMinPromptChars: 8 });
		await harness.lifecycle();
		expect(await harness.input("describe this screenshot", "interactive", [pngImage])).toBeUndefined();
		expect(await harness.input("short")).toBeUndefined();
		expect(await harness.input("a long enough remote request", "rpc")).toBeUndefined();
		expect(harness.planCalls).toEqual([]);
		expect(harness.delegationEntries()).toEqual([]);
	});

	it("keeps input on the main path when delegation is disabled or routing is manual or off", async () => {
		const disabled = new Harness();
		disabled.config = routerConfig();
		await disabled.lifecycle();
		expect(await disabled.input("an eligible standalone request")).toBeUndefined();
		expect(disabled.planCalls).toEqual([]);

		const pinned = await enabledHarness();
		await pinned.command("manual");
		expect(await pinned.input("an eligible standalone request")).toBeUndefined();
		await pinned.command("off");
		expect(await pinned.input("another eligible standalone request")).toBeUndefined();
		expect(pinned.planCalls).toEqual([]);
		expect(pinned.delegationEntries()).toEqual([]);
	});

	it("keeps later input on the main path while a workflow is active", async () => {
		const harness = await enabledHarness();
		const deferred = deferredEffort();
		harness.classifications = [deferred.classify, "low"];
		harness.planResults = [{ delegate: false, reason: "needs context" }];
		expect(await harness.input("first self-contained request")).toEqual({ handled: true });
		const second = harness.input("second request during workflow");
		expect(harness.delegationEntries()).toHaveLength(1);
		deferred.resolve("low");
		expect(await second).toBeUndefined();
		expect(harness.delegationEntries().filter(entry => entry.status === "pending")).toHaveLength(1);
		await harness.settle(() => harness.userMessages.length === 1);
		expect(harness.planCalls).toHaveLength(1);
	});

	it("serializes detached delegation routing against later main-path routing", async () => {
		const harness = await enabledHarness();
		const deferred = deferredEffort();
		harness.classifications = [deferred.classify, "high"];
		harness.planResults = [{ delegate: false, reason: "needs context" }];
		expect(await harness.input("first self-contained request")).toEqual({ handled: true });
		await harness.settle(() => harness.classifierPrompts.length === 1);

		let secondSettled = false;
		const second = harness.input("second concurrent request").then(result => {
			secondSettled = true;
			return result;
		});
		for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
		expect(secondSettled).toBe(false);
		expect(harness.classifierPrompts).toEqual(["first self-contained request"]);
		expect(harness.setModelCalls).toEqual([]);

		deferred.resolve("low");
		expect(await second).toBeUndefined();
		expect(harness.classifierPrompts).toEqual(["first self-contained request", "second concurrent request"]);
		expect(harness.setModelCalls.map(selected => selected.id)).toEqual(["smol", "slow"]);
		expect(harness.current?.id).toBe("slow");
		await harness.settle(() => harness.userMessages.length === 1);
	});

	it("treats a child-reported abort without user cancellation as a guarded failure", async () => {
		const harness = await enabledHarness();
		harness.classifications = ["low"];
		harness.planResults = [{ delegate: true, agent: "scout", task: "standalone task assignment" }];
		harness.executeResults = [
			singleResult({ aborted: true, abortReason: "wall clock exceeded", exitCode: 1, output: "" }),
		];
		await harness.input("the original standalone request");
		await harness.settle(() => harness.userMessages.length === 1);

		expect(harness.customMessages[0]?.content).toContain("wall clock exceeded");
		expect(harness.userMessages[0]?.deliverAs).toBe("followUp");
		expect(harness.userMessages[0]?.content).toContain("the original standalone request");
		expect(harness.userMessages[0]?.content).toContain("side effects");
		expect(harness.delegationEntries().at(-1)).toMatchObject({ status: "failed" });
	});

	it("answers status and early input safely before any lifecycle event", async () => {
		const harness = new Harness();
		await harness.command("status");
		expect(harness.notifications.at(-1)?.message).toContain("delegation off");
		expect(await harness.input("an early eligible standalone request")).toBeUndefined();
		expect(harness.planCalls).toEqual([]);
		expect(harness.delegationEntries()).toEqual([]);
	});

	it("claims eligible input immediately with a pending entry before classification resolves", async () => {
		const harness = await enabledHarness();
		const deferred = deferredEffort();
		harness.classifications = [deferred.classify];
		harness.planResults = [{ delegate: false, reason: "needs context" }];
		const result = await harness.input("please summarize the repository layout");
		expect(result).toEqual({ handled: true });
		expect(harness.planCalls).toEqual([]);
		expect(harness.executeCalls).toEqual([]);
		expect(harness.delegationEntries()).toMatchObject([
			{ status: "pending", request: "please summarize the repository layout" },
		]);
		deferred.resolve("low");
		await harness.settle(() => harness.userMessages.length === 1);
	});

	it("routes first and hands the selected model and allowlisted discovered agents to the planner", async () => {
		const harness = await enabledHarness();
		harness.classifications = ["low"];
		harness.planResults = [{ delegate: false, reason: "needs context" }];
		await harness.input("an eligible standalone request");
		await harness.settle(() => harness.userMessages.length === 1);

		expect(harness.planCalls).toHaveLength(1);
		const call = harness.planCalls[0];
		expect(call?.model.id).toBe("smol");
		expect(harness.sequence.indexOf("setModel:smol")).toBeLessThan(harness.sequence.indexOf("plan"));
		expect(call?.promptText).toBe("an eligible standalone request");
		expect(call?.agents.map(agent => agent.name)).toEqual(["scout", "task"]);
		expect(call?.repositoryIndex).toBe("repository index text");
		expect(call?.config.plannerTimeoutMs).toBe(5_000);
		expect(call?.ctx.signal).toBeInstanceOf(AbortSignal);
	});

	it("replays a malformed or timed-out plan as an ordered follow-up after clearing ownership", async () => {
		for (const failure of [
			new Error("model-router: unparseable delegation plan"),
			new Error("model-router: delegation planner aborted: request aborted"),
		]) {
			const harness = await enabledHarness();
			harness.classifications = ["low", "low"];
			harness.planResults = [failure, { delegate: false, reason: "second workflow" }];
			expect(await harness.input("the original standalone request")).toEqual({ handled: true });
			await harness.settle(() => harness.userMessages.length === 1);

			expect(harness.userMessages[0]).toEqual({
				content: "the original standalone request",
				deliverAs: "followUp",
			});
			expect(harness.executeCalls).toEqual([]);
			expect(harness.delegationEntries().at(-1)).toMatchObject({ status: "failed" });
			expect(harness.planCalls).toHaveLength(1);

			expect(await harness.input("a new standalone request")).toEqual({ handled: true });
			await harness.settle(() => harness.userMessages.length === 2);
			expect(harness.planCalls).toHaveLength(2);
		}
	});

	it("bounds planner failure diagnostics so raw payloads never reach state entries", async () => {
		const harness = await enabledHarness();
		harness.classifications = ["low"];
		harness.planResults = [new Error(`model-router: unparseable delegation plan: "${"x".repeat(2_000)}"`)];
		await harness.input("the original standalone request");
		await harness.settle(() => harness.userMessages.length === 1);

		const failed = harness.delegationEntries().at(-1);
		expect(failed).toMatchObject({ status: "failed" });
		expect(String(failed?.reason).length).toBeLessThanOrEqual(201);
	});

	it("replays missing-agent and non-delegated plans without executing", async () => {
		const missingAgent = await enabledHarness();
		missingAgent.classifications = ["low"];
		missingAgent.planResults = [{ delegate: true, agent: "ghost", task: "haunt the repo" }];
		await missingAgent.input("an eligible standalone request");
		await missingAgent.settle(() => missingAgent.userMessages.length === 1);
		expect(missingAgent.userMessages[0]).toEqual({
			content: "an eligible standalone request",
			deliverAs: "followUp",
		});
		expect(missingAgent.executeCalls).toEqual([]);
		expect(missingAgent.delegationEntries().at(-1)).toMatchObject({ status: "failed" });

		const passedThrough = await enabledHarness();
		passedThrough.classifications = ["low"];
		passedThrough.planResults = [{ delegate: false, reason: "needs prior context" }];
		await passedThrough.input("a conversational follow-up request");
		await passedThrough.settle(() => passedThrough.userMessages.length === 1);
		expect(passedThrough.userMessages[0]).toEqual({
			content: "a conversational follow-up request",
			deliverAs: "followUp",
		});
		expect(passedThrough.executeCalls).toEqual([]);
		expect(passedThrough.delegationEntries().at(-1)).toMatchObject({ status: "passed-through" });
	});

	it("executes a valid plan through the public executor contract", async () => {
		const harness = await successfulDelegation();
		expect(harness.executeCalls).toHaveLength(1);
		const call = harness.executeCalls[0];
		expect(call?.agent).toBe(harness.discoveredAgents[0] as AgentDefinition);
		expect(call?.task).toBe("standalone task assignment");
		expect(call?.modelOverride).toBe("mock/smol");
		const thinkingLevel: string | undefined = call?.thinkingLevel;
		expect(thinkingLevel).toBe("low");
		expect(call?.cwd).toBe("/project");
		expect(typeof call?.id).toBe("string");
		expect(call?.id.length).toBeGreaterThan(0);
		expect(typeof call?.index).toBe("number");
		expect(call?.signal).toBeInstanceOf(AbortSignal);
		expect(call?.keepAlive).toBe(false);
	});

	it("renders success visibly without a main turn or replay", async () => {
		const harness = await successfulDelegation();
		expect(harness.customMessages[0]).toMatchObject({
			customType: MODEL_ROUTER_DELEGATION_MESSAGE,
			display: true,
			triggerTurn: false,
		});
		expect(harness.customMessages[0]?.content).toContain("child output text");
		expect(harness.customMessages[0]?.content).toContain("summarize the repository layout");
		expect(harness.customMessages[0]?.details).toMatchObject({ agent: "scout" });
		expect(harness.userMessages).toEqual([]);
		expect(harness.delegationEntries().map(entry => entry.status)).toEqual(["pending", "delegated", "completed"]);
	});

	it("renders child failure then replays a guarded follow-up", async () => {
		const harness = await enabledHarness();
		harness.classifications = ["low"];
		harness.planResults = [{ delegate: true, agent: "scout", task: "standalone task assignment" }];
		harness.executeResults = [singleResult({ exitCode: 1, error: "child exploded", output: "" })];
		await harness.input("the original standalone request");
		await harness.settle(() => harness.userMessages.length === 1);

		const sends = harness.sequence.filter(step => step === "sendMessage" || step === "sendUserMessage");
		expect(sends).toEqual(["sendMessage", "sendUserMessage"]);
		expect(harness.customMessages[0]).toMatchObject({
			customType: MODEL_ROUTER_DELEGATION_MESSAGE,
			display: true,
			triggerTurn: false,
		});
		expect(harness.customMessages[0]?.content).toContain("child exploded");
		expect(harness.userMessages[0]?.deliverAs).toBe("followUp");
		expect(harness.userMessages[0]?.content).toContain("the original standalone request");
		expect(harness.userMessages[0]?.content).toContain("side effects");
		expect(harness.delegationEntries().at(-1)).toMatchObject({ status: "failed" });
	});

	it("treats a throwing child as a guarded failure", async () => {
		const harness = await enabledHarness();
		harness.classifications = ["low"];
		harness.planResults = [{ delegate: true, agent: "task", task: "standalone task assignment" }];
		harness.executeResults = [new Error("spawn failed")];
		await harness.input("the original standalone request");
		await harness.settle(() => harness.userMessages.length === 1);

		expect(harness.customMessages[0]?.content).toContain("spawn failed");
		expect(harness.userMessages[0]?.content).toContain("side effects");
		expect(harness.delegationEntries().at(-1)).toMatchObject({ status: "failed" });
	});

	it("cancels during planning via /route cancel without replay", async () => {
		const harness = await enabledHarness();
		harness.classifications = ["low"];
		harness.planResults = [abortablePlan];
		expect(await harness.input("a long standalone request")).toEqual({ handled: true });
		await harness.settle(() => harness.planCalls.length === 1);

		await harness.command("cancel");
		await harness.settle(() => harness.delegationEntries().some(entry => entry.status === "cancelled"));
		expect(harness.userMessages).toEqual([]);
		expect(harness.executeCalls).toEqual([]);

		harness.classifications = ["low"];
		harness.planResults = [{ delegate: false, reason: "later" }];
		expect(await harness.input("a fresh standalone request")).toEqual({ handled: true });
		await harness.settle(() => harness.userMessages.length === 1);
	});

	it("cancels during execution via /route cancel without replay or failure render", async () => {
		const harness = await enabledHarness();
		harness.classifications = ["low"];
		harness.planResults = [{ delegate: true, agent: "scout", task: "standalone task assignment" }];
		harness.executeResults = [abortableExecute];
		await harness.input("a long standalone request");
		await harness.settle(() => harness.executeCalls.length === 1);

		await harness.command("cancel");
		await harness.settle(() => harness.delegationEntries().some(entry => entry.status === "cancelled"));
		expect(harness.userMessages).toEqual([]);
		expect(harness.customMessages).toEqual([]);
	});

	it("aborts the active workflow on session shutdown without replay", async () => {
		const harness = await enabledHarness();
		harness.classifications = ["low"];
		harness.planResults = [abortablePlan];
		await harness.input("a long standalone request");
		await harness.settle(() => harness.planCalls.length === 1);

		await harness.shutdown();
		await harness.settle(() => harness.delegationEntries().some(entry => entry.status === "cancelled"));
		expect(harness.userMessages).toEqual([]);
		expect(harness.executeCalls).toEqual([]);
	});

	it("reports no active workflow for /route cancel when idle", async () => {
		const harness = await enabledHarness();
		await harness.command("cancel");
		expect(harness.notifications.at(-1)?.message).toContain("no active delegation");
		expect(harness.delegationEntries()).toEqual([]);
	});

	it("returns the status bar to delegation idle after a workflow settles so cancel matches reality", async () => {
		const harness = await successfulDelegation();
		await harness.settle(() => harness.statuses.at(-1)?.includes("(idle)") === true);
		expect(harness.statuses.at(-1)).toContain("delegation on (idle)");

		await harness.command("cancel");
		expect(harness.notifications.at(-1)?.message).toContain("no active delegation");
		expect(harness.delegationEntries().at(-1)).toMatchObject({ status: "completed" });
	});

	it("reports delegation and workflow state in /route status", async () => {
		const disabled = new Harness();
		disabled.config = routerConfig();
		await disabled.lifecycle();
		await disabled.command("status");
		expect(disabled.notifications.at(-1)?.message).toContain("delegation off");

		const harness = await enabledHarness();
		await harness.command("status");
		expect(harness.notifications.at(-1)?.message).toContain("delegation on");
		expect(harness.notifications.at(-1)?.message).toContain("idle");

		harness.classifications = ["low"];
		harness.planResults = [abortablePlan];
		await harness.input("a long standalone request");
		await harness.settle(() => harness.planCalls.length === 1);
		await harness.command("status");
		expect(harness.notifications.at(-1)?.message).toContain("active");
		await harness.command("cancel");
		await harness.settle(() => harness.delegationEntries().some(entry => entry.status === "cancelled"));
	});

	it("registers a Text renderer preserving the plain string content", () => {
		const harness = new Harness();
		const renderer = harness.renderers.get(MODEL_ROUTER_DELEGATION_MESSAGE);
		expect(renderer).toBeDefined();
		const component = renderer?.(
			{
				role: "custom",
				customType: MODEL_ROUTER_DELEGATION_MESSAGE,
				content: "delegated result body",
				display: true,
				timestamp: 1,
			},
			{ expanded: false },
			{},
		);
		expect(component).toBeInstanceOf(Text);
		expect((component as Text).getText()).toBe("delegated result body");
	});
});
