import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	InputEvent,
	InputEventResult,
} from "@oh-my-pi/pi-coding-agent";
import type { RouteEffort, RouterConfig } from "../src/config";
import { createModelRouterExtension } from "../src/extension";
import type { RouterSetupContext } from "../src/setup";
import {
	createRouterState,
	encodeRouterState,
	MODEL_ROUTER_STATE_ENTRY,
	parseRouterState,
	type RouterState,
} from "../src/state";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
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
		...overrides,
	};
}

class Harness {
	readonly handlers = new Map<string, EventHandler>();
	readonly commands = new Map<string, CommandHandler>();
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
	classifications: Array<RouteEffort | Error> = ["low"];

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
			registerCommand(name: string, options: { handler: CommandHandler }): void {
				self.commands.set(name, options.handler);
			},
			appendEntry(customType: string, data?: unknown): void {
				const entry = { type: "custom", customType, data };
				self.entries.push(entry);
				self.branchEntries?.push(entry);
			},
			async setModel(selected: Model): Promise<boolean> {
				self.setModelCalls.push(selected);
				const result = self.setModelResults.shift() ?? true;
				if (result instanceof Error) throw result;
				if (result) self.current = selected as TestModel;
				return result;
			},
			setThinkingLevel(level: string): void {
				self.thinkingCalls.push(level);
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
				return next;
			},
			now: () => this.now,
			setup: async context => {
				this.setupCalls += 1;
				this.setupContexts.push(context);
				return { status: "written", path: "/project/.omp/model-router.json" };
			},
		})(this.api);
	}

	async lifecycle(name = "session_start"): Promise<void> {
		await this.handlers.get(name)?.({ type: name }, this.ctx);
	}

	async input(text: string, source: InputEvent["source"] = "interactive"): Promise<InputEventResult | undefined> {
		return (await this.handlers.get("input")?.({ type: "input", text, source }, this.ctx)) as
			| InputEventResult
			| undefined;
	}

	async command(args: string): Promise<void> {
		await this.commands.get("route")?.(args, this.ctx);
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
