import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEFAULT_DELEGATION_AGENTS,
	DEFAULT_ROUTER_CONFIG,
	loadRouterConfig,
	parseRouterConfigLayer,
	type RouterConfigLayer,
} from "../src/config";

let root: string;
let homeDir: string;
let cwd: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "model-router-config-"));
	homeDir = path.join(root, "home");
	cwd = path.join(root, "project");
	await fs.mkdir(homeDir, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

async function writeJson(file: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify(value));
}

describe("loadRouterConfig", () => {
	it("uses safe defaults when no config files exist", async () => {
		const config = await loadRouterConfig({ cwd, homeDir, env: {} });

		expect(config).toEqual({
			enabled: true,
			thresholds: { low: ["@smol"], high: ["@slow"] },
			classifierModels: ["@tiny", "@smol"],
			maxEffort: "xhigh",
			classifierTimeoutMs: 20_000,
			classifierMinPromptChars: 30,
			classifierCooldownMs: 30_000,
			thinkingProfiles: {},
			delegation: {
				enabled: false,
				plannerTimeoutMs: 20_000,
				agents: ["scout", "sonic", "task", "designer", "reviewer", "security-reviewer"],
			},
		});
		expect(config).not.toBe(DEFAULT_ROUTER_CONFIG);
		expect(config.thresholds).not.toBe(DEFAULT_ROUTER_CONFIG.thresholds);
		expect(config.delegation).not.toBe(DEFAULT_ROUTER_CONFIG.delegation);
		expect(config.delegation.agents).not.toBe(DEFAULT_ROUTER_CONFIG.delegation.agents);
	});

	it("layers user, project, and explicit config in that order", async () => {
		const userFile = path.join(homeDir, ".omp", "agent", "model-router.json");
		const projectFile = path.join(cwd, ".omp", "model-router.json");
		const explicitFile = path.join(root, "explicit.json");
		await writeJson(userFile, {
			enabled: false,
			thresholds: { low: "user/low", medium: "user/medium" },
			classifierModels: ["@tiny"],
		});
		await writeJson(projectFile, {
			thresholds: { low: 42, high: "project/high", impossible: "ignored/model" },
			maxEffort: "max",
		});
		await writeJson(explicitFile, {
			enabled: true,
			thresholds: { xhigh: "explicit/xhigh" },
			classifierTimeoutMs: 2_500,
			unknown: "ignored",
		});

		const config = await loadRouterConfig({
			cwd,
			homeDir,
			env: { OMP_MODEL_ROUTER_CONFIG: explicitFile },
		});

		expect(config).toEqual({
			enabled: true,
			thresholds: {
				low: ["user/low"],
				medium: ["user/medium"],
				high: ["project/high"],
				xhigh: ["explicit/xhigh"],
			},
			classifierModels: ["@tiny"],
			maxEffort: "max",
			classifierTimeoutMs: 2_500,
			classifierMinPromptChars: 30,
			classifierCooldownMs: 30_000,
			thinkingProfiles: {},
			delegation: {
				enabled: false,
				plannerTimeoutMs: 20_000,
				agents: ["scout", "sonic", "task", "designer", "reviewer", "security-reviewer"],
			},
		});
	});

	it("merges candidate lists by effort and profiles by exact model key", async () => {
		await writeJson(path.join(homeDir, ".omp", "agent", "model-router.json"), {
			thresholds: { low: ["user/low", "user/fallback"] },
			thinkingProfiles: {
				"openai/gpt-5": { default: "low", xhigh: "high" },
				"openai/other": { default: "medium" },
			},
			classifierMinPromptChars: 10,
		});
		await writeJson(path.join(cwd, ".omp", "model-router.json"), {
			thresholds: { low: ["project/low"] },
			thinkingProfiles: {
				"openai/gpt-5": { xhigh: "medium", max: "medium" },
			},
			classifierCooldownMs: 1_000,
		});

		const config = await loadRouterConfig({ cwd, homeDir, env: {} });

		expect(config.thresholds.low).toEqual(["project/low"]);
		expect(config.thinkingProfiles).toEqual({
			"openai/gpt-5": { default: "low", xhigh: "medium", max: "medium" },
			"openai/other": { default: "medium" },
		});
		expect(config.classifierMinPromptChars).toBe(10);
		expect(config.classifierCooldownMs).toBe(1_000);
	});

	it("overrides individual delegation fields per layer without erasing unchanged fields", async () => {
		await writeJson(path.join(homeDir, ".omp", "agent", "model-router.json"), {
			delegation: { enabled: true, plannerTimeoutMs: 60_000, agents: ["scout"] },
		});
		await writeJson(path.join(cwd, ".omp", "model-router.json"), {
			delegation: { plannerTimeoutMs: 30_000 },
		});

		const config = await loadRouterConfig({ cwd, homeDir, env: {} });

		expect(config.delegation).toEqual({
			enabled: true,
			plannerTimeoutMs: 30_000,
			agents: ["scout"],
		});
	});

	it("ignores missing, malformed, and non-object config files", async () => {
		const userFile = path.join(homeDir, ".omp", "agent", "model-router.json");
		const projectFile = path.join(cwd, ".omp", "model-router.json");
		const explicitFile = path.join(root, "missing.json");
		await fs.mkdir(path.dirname(userFile), { recursive: true });
		await fs.writeFile(userFile, "{not-json");
		await writeJson(projectFile, ["not", "an", "object"]);

		const config = await loadRouterConfig({
			cwd,
			homeDir,
			env: { OMP_MODEL_ROUTER_CONFIG: explicitFile },
		});

		expect(config).toEqual(DEFAULT_ROUTER_CONFIG);
	});
});

describe("parseRouterConfigLayer", () => {
	it("accepts only valid own properties and supported threshold names", () => {
		const inherited = {
			enabled: false,
			maxEffort: "max",
			classifierTimeoutMs: 1,
		};
		const input = Object.create(inherited) as Record<string, unknown>;
		const inheritedThresholds = { high: "inherited/high" };
		const thresholds = Object.create(inheritedThresholds) as Record<string, unknown>;
		thresholds.low = " own/low ";
		thresholds.medium = "";
		thresholds.high = 12;
		thresholds.max = "own/max";
		input.thresholds = thresholds;
		input.classifierModels = [" @tiny ", "", 12, "@smol"];

		expect(parseRouterConfigLayer(input)).toEqual({
			thresholds: { low: ["own/low"], max: ["own/max"] },
			classifierModels: ["@tiny", "@smol"],
		});
	});
	it("accepts legacy string thresholds in the config-layer type", () => {
		const layer: RouterConfigLayer = { thresholds: { low: "legacy/low" } };
		expect(parseRouterConfigLayer(layer)).toEqual({ thresholds: { low: ["legacy/low"] } });
	});

	it("ignores classifier selectors inherited through a sparse array prototype", () => {
		const classifierModels: unknown[] = new Array(2);
		classifierModels[1] = "own/model";
		const prototype = Object.create(Array.prototype) as Record<number, unknown>;
		prototype[0] = "inherited/model";
		Object.setPrototypeOf(classifierModels, prototype);

		expect(parseRouterConfigLayer({ classifierModels })).toEqual({
			classifierModels: ["own/model"],
		});
	});

	it("ignores invalid root values, field types, and prototype-shaped JSON keys", () => {
		const input = JSON.parse(
			'{"__proto__":{"enabled":false},"enabled":"yes","thresholds":{"__proto__":"bad","low":null},"classifierModels":"@tiny","maxEffort":"extreme","classifierTimeoutMs":0}',
		) as unknown;

		expect(parseRouterConfigLayer(input)).toEqual({ thresholds: {} });
		expect(parseRouterConfigLayer(null)).toEqual({});
		expect(parseRouterConfigLayer([])).toEqual({});
	});

	it("normalizes threshold arrays and validates timing and thinking-profile fields", () => {
		const inheritedProfile = { default: "high" };
		const profile = Object.create(inheritedProfile) as Record<string, unknown>;
		profile.low = " low ";
		profile.xhigh = " medium ";
		const input = {
			thresholds: {
				low: " @fast ",
				medium: [" @medium ", "", 42, " @fallback "],
				high: ["@high"],
				max: [],
			},
			classifierMinPromptChars: 0,
			classifierCooldownMs: 1_000,
			thinkingProfiles: {
				"openai/gpt-5": profile,
				"openai/partial": { default: "invalid", max: " max " },
				"": { default: "low" },
			},
		};

		expect(parseRouterConfigLayer(input)).toEqual({
			thresholds: {
				low: ["@fast"],
				medium: ["@medium", "@fallback"],
				high: ["@high"],
			},
			classifierMinPromptChars: 0,
			classifierCooldownMs: 1_000,
			thinkingProfiles: {
				"openai/gpt-5": { low: "low", xhigh: "medium" },
				"openai/partial": { max: "max" },
			},
		});
	});

	it("ignores invalid timing values and malformed profile roots", () => {
		expect(
			parseRouterConfigLayer({
				classifierMinPromptChars: -1,
				classifierCooldownMs: 1.5,
				thinkingProfiles: {
					"openai/gpt-5": [],
					"openai/other": { default: "low", unknown: "high" },
				},
			}),
		).toEqual({
			thinkingProfiles: {
				"openai/other": { default: "low" },
			},
		});
		expect(
			parseRouterConfigLayer({
				classifierMinPromptChars: Number.MAX_SAFE_INTEGER + 1,
				classifierCooldownMs: Number.POSITIVE_INFINITY,
			}),
		).toEqual({});
	});

	it("parses valid own delegation fields with the exact defaults exported", () => {
		expect(DEFAULT_ROUTER_CONFIG.delegation).toEqual({
			enabled: false,
			plannerTimeoutMs: 20_000,
			agents: ["scout", "sonic", "task", "designer", "reviewer", "security-reviewer"],
		});
		expect(DEFAULT_DELEGATION_AGENTS).toEqual([
			"scout",
			"sonic",
			"task",
			"designer",
			"reviewer",
			"security-reviewer",
		]);

		expect(
			parseRouterConfigLayer({
				delegation: { enabled: true, plannerTimeoutMs: 45_000, agents: [" scout ", "task"] },
			}),
		).toEqual({
			delegation: { enabled: true, plannerTimeoutMs: 45_000, agents: ["scout", "task"] },
		});
	});

	it("accepts partial delegation layers without inventing sibling fields", () => {
		expect(parseRouterConfigLayer({ delegation: { plannerTimeoutMs: 30_000 } })).toEqual({
			delegation: { plannerTimeoutMs: 30_000 },
		});
		expect(parseRouterConfigLayer({ delegation: { enabled: false } })).toEqual({
			delegation: { enabled: false },
		});
	});

	it("ignores invalid delegation roots and inherited delegation properties", () => {
		expect(parseRouterConfigLayer({ delegation: null })).toEqual({});
		expect(parseRouterConfigLayer({ delegation: [] })).toEqual({});
		expect(parseRouterConfigLayer({ delegation: "on" })).toEqual({});

		const inherited = { enabled: true, agents: ["scout"] };
		const delegation = Object.create(inherited) as Record<string, unknown>;
		delegation.plannerTimeoutMs = 15_000;

		expect(parseRouterConfigLayer({ delegation })).toEqual({
			delegation: { plannerTimeoutMs: 15_000 },
		});
	});

	it("rejects empty agent lists and out-of-bounds planner timeouts", () => {
		expect(parseRouterConfigLayer({ delegation: { agents: [] } })).toEqual({ delegation: {} });
		expect(parseRouterConfigLayer({ delegation: { agents: ["", "  ", 42] } })).toEqual({ delegation: {} });
		expect(parseRouterConfigLayer({ delegation: { agents: "scout" } })).toEqual({ delegation: {} });

		for (const plannerTimeoutMs of [0, -1, 1.5, 120_001, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(parseRouterConfigLayer({ delegation: { plannerTimeoutMs } })).toEqual({ delegation: {} });
		}
		expect(parseRouterConfigLayer({ delegation: { plannerTimeoutMs: 120_000 } })).toEqual({
			delegation: { plannerTimeoutMs: 120_000 },
		});
	});
});
