import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ROUTER_EFFORTS, type RouterConfig } from "../src/config";
import { type RouterSetupContext, type RouterSetupValues, runRouterSetup, writeRouterConfigLayer } from "../src/setup";

let root: string;
let homeDir: string;
let cwd: string;

const config: RouterConfig = {
	enabled: true,
	thresholds: { low: ["@smol"], high: ["@slow"] },
	classifierModels: ["@tiny", "@smol"],
	maxEffort: "xhigh",
	classifierTimeoutMs: 4_000,
	classifierMinPromptChars: 0,
	classifierCooldownMs: 0,
	thinkingProfiles: {},
	delegation: {
		enabled: false,
		plannerTimeoutMs: 20_000,
		agents: ["scout", "sonic", "task", "designer", "reviewer", "security-reviewer"],
	},
};

function values(overrides: Partial<RouterSetupValues> = {}): RouterSetupValues {
	return {
		enabled: true,
		thresholds: { low: ["mock/low"] },
		classifierModels: ["@tiny"],
		classifierMinPromptChars: 4,
		classifierCooldownMs: 500,
		thinkingProfiles: { "mock/low": { default: "low", xhigh: "medium" } },
		delegation: {
			enabled: true,
			plannerTimeoutMs: 20_000,
			agents: ["scout", "sonic", "task", "designer", "reviewer", "security-reviewer"],
		},
		...overrides,
	};
}

class FakeUI {
	readonly selected: string[] = [];
	readonly entered: string[] = [];
	readonly confirmed: boolean[] = [];
	readonly confirmTitles: string[] = [];
	readonly notifications: string[] = [];
	readonly selectTitles: string[] = [];
	readonly selectOptions: string[][] = [];
	readonly inputTitles: string[] = [];

	constructor(
		private readonly selections: Array<string | undefined>,
		private readonly inputs: Array<string | undefined>,
		private readonly confirmations: boolean[] = [],
	) {}

	async select(title: string, options: string[]): Promise<string | undefined> {
		this.selectTitles.push(title);
		this.selectOptions.push(options);
		return this.selections.shift();
	}

	async input(title: string): Promise<string | undefined> {
		this.inputTitles.push(title);
		return this.inputs.shift();
	}

	async confirm(title: string): Promise<boolean> {
		this.confirmTitles.push(title);
		return this.confirmations.shift() ?? false;
	}

	notify(message: string): void {
		this.notifications.push(message);
	}
}

function setupContext(ui: FakeUI, hasUI = true): RouterSetupContext {
	return {
		cwd,
		homeDir,
		hasUI,
		ui,
		models: {
			list: () => [
				{ provider: "mock", id: "base", name: "Base" },
				{ provider: "mock", id: "smol", name: "Smol" },
			],
		},
	};
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "model-router-setup-"));
	homeDir = path.join(root, "home");
	cwd = path.join(root, "project");
	await fs.mkdir(homeDir, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("writeRouterConfigLayer", () => {
	it("preserves unrelated JSON fields while replacing known router fields", async () => {
		const file = path.join(cwd, ".omp", "model-router.json");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(
			file,
			JSON.stringify({
				unrelated: { keep: true },
				thresholds: { unknown: "keep", low: ["old"] },
				thinkingProfiles: { other: { custom: "keep" } },
			}),
		);

		await writeRouterConfigLayer(file, values());
		const written = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;

		expect(written.unrelated).toEqual({ keep: true });
		expect(written.thresholds).toEqual({ unknown: "keep", low: ["mock/low"] });
		expect(written.thinkingProfiles).toEqual({
			other: { custom: "keep" },
			"mock/low": { default: "low", xhigh: "medium" },
		});
		expect(written.enabled).toBe(true);
	});
	it("preserves prototype-shaped profile keys as inert JSON data", async () => {
		const file = path.join(cwd, ".omp", "model-router.json");
		const thinkingProfiles = Object.create(null) as RouterSetupValues["thinkingProfiles"];
		Object.defineProperty(thinkingProfiles, "__proto__", {
			value: { default: "low" },
			enumerable: true,
			configurable: true,
			writable: true,
		});

		await writeRouterConfigLayer(file, values({ thinkingProfiles }));
		const written = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
		const profiles = written.thinkingProfiles as Record<string, unknown>;

		expect(Object.hasOwn(profiles, "__proto__")).toBe(true);
		expect(Object.getOwnPropertyDescriptor(profiles, "__proto__")?.value).toEqual({ default: "low" });
		expect(Object.getPrototypeOf(profiles)).toBe(Object.prototype);
	});

	it("refuses malformed existing JSON without changing it", async () => {
		const file = path.join(cwd, ".omp", "model-router.json");
		await fs.mkdir(path.dirname(file), { recursive: true });
		const original = "{not-json";
		await fs.writeFile(file, original);

		await expect(writeRouterConfigLayer(file, values())).rejects.toThrow();
		expect(await fs.readFile(file, "utf8")).toBe(original);
	});

	it("replaces owned delegation keys while preserving extra delegation data", async () => {
		const file = path.join(cwd, ".omp", "model-router.json");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(
			file,
			JSON.stringify({
				unrelated: { keep: true },
				delegation: { enabled: false, plannerTimeoutMs: 45_000, agents: ["scout"], note: "keep" },
			}),
		);

		await writeRouterConfigLayer(file, values());
		const written = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;

		expect(written.unrelated).toEqual({ keep: true });
		expect(written.delegation).toEqual({
			enabled: true,
			plannerTimeoutMs: 20_000,
			agents: ["scout", "sonic", "task", "designer", "reviewer", "security-reviewer"],
			note: "keep",
		});
	});
});

describe("runRouterSetup", () => {
	it("writes a confirmed project setup with ordered candidates and a model profile", async () => {
		const ui = new FakeUI(
			[
				"project",
				"enabled",
				"5 seconds — wait after each classification",
				"@tiny",
				"@smol",
				"low",
				"@tiny",
				"done",
				"mock/smol",
				"low",
				"medium",
				"inherit",
			],
			["4"],
			[true, false, false, false, true],
		);
		const result = await runRouterSetup(setupContext(ui), config);

		expect(result.status).toBe("written");
		const written = JSON.parse(await fs.readFile(path.join(cwd, ".omp", "model-router.json"), "utf8")) as Record<
			string,
			unknown
		>;
		expect(written).toMatchObject({
			enabled: true,
			classifierModels: ["@tiny", "@smol"],
			classifierMinPromptChars: 4,
			classifierCooldownMs: 5_000,
			thresholds: { low: ["@tiny"], high: ["@slow"] },
			thinkingProfiles: { "mock/smol": { default: "low", xhigh: "medium" } },
		});
		expect(ui.inputTitles).toEqual(["Skip prompts shorter than this many characters"]);
		expect(ui.selectTitles).toContain("Wait between automatic classifications");
		expect(ui.selectOptions.flat()).not.toContain("custom selector");
		const lowOptions = ui.selectOptions[ui.selectTitles.indexOf("low threshold candidate")] ?? [];
		expect(lowOptions).toContain("@slow");
		expect(lowOptions).toContain("@default");
		expect(ui.inputTitles.some(title => title.toLowerCase().includes("model"))).toBe(false);
	});
	it("preserves a non-preset cooldown with a human-readable current option", async () => {
		const ui = new FakeUI(
			["project", "enabled", "Keep current — 2.5 seconds", "@tiny", "done", "none"],
			["0"],
			[false, false, true],
		);
		const result = await runRouterSetup(setupContext(ui), { ...config, classifierCooldownMs: 2_500 });

		expect(result.status).toBe("written");
		const written = JSON.parse(await fs.readFile(path.join(cwd, ".omp", "model-router.json"), "utf8")) as Record<
			string,
			unknown
		>;
		expect(written.classifierCooldownMs).toBe(2_500);
	});

	it("does not write when cancelled or when the UI surface is unavailable", async () => {
		const cancelled = await runRouterSetup(setupContext(new FakeUI([undefined], [])), config);
		expect(cancelled.status).toBe("cancelled");
		expect(await fs.stat(path.join(cwd, ".omp", "model-router.json")).catch(() => undefined)).toBeUndefined();

		const unsupported = await runRouterSetup(setupContext(new FakeUI([], []), false), config);
		expect(unsupported.status).toBe("unsupported");
		expect(await fs.stat(path.join(cwd, ".omp", "model-router.json")).catch(() => undefined)).toBeUndefined();
	});

	it("keeps the file unchanged when final confirmation is declined", async () => {
		const file = path.join(cwd, ".omp", "model-router.json");
		await fs.mkdir(path.dirname(file), { recursive: true });
		const original = JSON.stringify({ keep: "yes" });
		await fs.writeFile(file, original);
		const ui = new FakeUI(
			["project", "enabled", "No wait — classify every eligible prompt", "@tiny", "done", "none"],
			["0"],
			[false, false, false],
		);

		const result = await runRouterSetup(setupContext(ui), config);

		expect(result.status).toBe("cancelled");
		expect(await fs.readFile(file, "utf8")).toBe(original);
	});

	it("exposes all configurable route effort names to the wizard contract", () => {
		expect(ROUTER_EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});

	it("asks whether to enable delegation and writes the delegation block", async () => {
		const ui = new FakeUI(
			["project", "enabled", "No wait — classify every eligible prompt", "@tiny", "done", "none"],
			["0"],
			[false, true, true],
		);

		const result = await runRouterSetup(setupContext(ui), config);

		expect(result.status).toBe("written");
		expect(ui.confirmTitles).toContain("Enable self-contained subagent delegation?");
		const written = JSON.parse(await fs.readFile(path.join(cwd, ".omp", "model-router.json"), "utf8")) as Record<
			string,
			unknown
		>;
		expect(written.delegation).toEqual({
			enabled: true,
			plannerTimeoutMs: 20_000,
			agents: ["scout", "sonic", "task", "designer", "reviewer", "security-reviewer"],
		});
	});

	it("changes only delegation.enabled while advanced values and unrelated JSON survive", async () => {
		const file = path.join(cwd, ".omp", "model-router.json");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, JSON.stringify({ unrelated: { keep: true }, delegation: { note: "keep" } }));
		const ui = new FakeUI(
			["project", "enabled", "No wait — classify every eligible prompt", "@tiny", "done", "none"],
			["0"],
			[false, true, true],
		);
		const advanced: RouterConfig = {
			...config,
			delegation: { enabled: false, plannerTimeoutMs: 45_000, agents: ["scout"] },
		};

		const result = await runRouterSetup(setupContext(ui), advanced);

		expect(result.status).toBe("written");
		const written = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
		expect(written.unrelated).toEqual({ keep: true });
		expect(written.delegation).toEqual({
			enabled: true,
			plannerTimeoutMs: 45_000,
			agents: ["scout"],
			note: "keep",
		});
	});
});
