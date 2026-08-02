import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_ROUTER_CONFIG, loadRouterConfig, parseRouterConfigLayer } from "../src/config";

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

		expect(config).toEqual(DEFAULT_ROUTER_CONFIG);
		expect(config).not.toBe(DEFAULT_ROUTER_CONFIG);
		expect(config.thresholds).not.toBe(DEFAULT_ROUTER_CONFIG.thresholds);
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
				low: "user/low",
				medium: "user/medium",
				high: "project/high",
				xhigh: "explicit/xhigh",
			},
			classifierModels: ["@tiny"],
			maxEffort: "max",
			classifierTimeoutMs: 2_500,
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
			thresholds: { low: "own/low", max: "own/max" },
			classifierModels: ["@tiny", "@smol"],
		});
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
});
