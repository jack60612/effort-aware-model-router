import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	canonicalParallelPlan,
	decideParallelSchedule,
	getParallelDependencyWaves,
	loadParallelWorkflowManifest,
	type ParallelReviewState,
	type ParallelReviewStatus,
	type ParallelShardState,
	type ParallelShardStatus,
	type ParallelWorkflowPlan,
	parseParallelWorkflowManifest,
	validateParallelWorkflowManifest,
} from "../src/parallel/index";

const SOURCE = "manifest.yml";

interface ManifestOverrides {
	run?: unknown;
	model?: unknown;
	maxConcurrency?: unknown;
	contracts?: unknown;
	shards?: unknown;
}

function contract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "delegation-config-v1",
		description: "Validated delegation configuration and defaults.",
		owner: "delegation-config",
		...overrides,
	};
}

function shard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "delegation-config",
		kind: "implementation",
		agent: "task",
		prompt: "Implement and test the delegation configuration contract.",
		owns: ["src/config.ts", "test/config.test.ts"],
		produces: ["delegation-config-v1"],
		requires: [],
		dependsOn: [],
		...overrides,
	};
}

function manifest(overrides: ManifestOverrides = {}): Record<string, unknown> {
	return {
		run: "cache-aware-delegation",
		model: "@smol",
		maxConcurrency: 4,
		contracts: [contract()],
		shards: [shard()],
		...overrides,
	};
}

/** Two-shard chain: consumer requires the contract produced by delegation-config. */
function chainedManifest(consumerOverrides: Record<string, unknown> = {}): Record<string, unknown> {
	return manifest({
		shards: [
			shard({ review: { agent: "reviewer", required: true } }),
			shard({
				id: "consumer",
				owns: ["src/consumer.ts"],
				produces: [],
				requires: ["delegation-config-v1"],
				dependsOn: ["delegation-config"],
				...consumerOverrides,
			}),
		],
	});
}

function shardState(id: string, status: ParallelShardStatus): ParallelShardState {
	return { id, status, branchName: null, baseSha: null, error: null };
}

function reviewState(shardId: string, status: ParallelReviewStatus): ParallelReviewState {
	return { shardId, status, summary: null, findings: [], error: null };
}

describe("validateParallelWorkflowManifest", () => {
	it("accepts a valid manifest and returns a normalized immutable plan", () => {
		const plan = validateParallelWorkflowManifest(manifest(), SOURCE);

		expect(plan.run).toBe("cache-aware-delegation");
		expect(plan.model).toBe("@smol");
		expect(plan.maxConcurrency).toBe(4);
		expect(plan.sourcePath).toBe(SOURCE);
		expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
		expect(plan.contracts).toEqual([
			{
				id: "delegation-config-v1",
				description: "Validated delegation configuration and defaults.",
				owner: "delegation-config",
			},
		]);
		expect(plan.shards[0]?.owns).toEqual(["src/config.ts", "test/config.test.ts"]);
		expect(Object.isFrozen(plan)).toBe(true);
		expect(Object.isFrozen(plan.shards)).toBe(true);
		expect(Object.isFrozen(plan.shards[0])).toBe(true);
		expect(Object.isFrozen(plan.shards[0]?.owns)).toBe(true);
	});

	it("accepts an optional review entry and a manifest without model", () => {
		const input = manifest({ shards: [shard({ review: { agent: "reviewer", required: false } })] });
		delete input.model;

		const plan = validateParallelWorkflowManifest(input, SOURCE);

		expect(plan.model).toBeUndefined();
		expect(plan.shards[0]?.review).toEqual({ agent: "reviewer", required: false });
	});

	it("trims whitespace from bounded string fields", () => {
		const plan = validateParallelWorkflowManifest(
			manifest({
				model: "  @smol  ",
				shards: [shard({ kind: "  implementation ", prompt: "  do the work  " })],
			}),
			SOURCE,
		);

		expect(plan.model).toBe("@smol");
		expect(plan.shards[0]?.kind).toBe("implementation");
		expect(plan.shards[0]?.prompt).toBe("do the work");
	});

	it("rejects non-object top-level values with actionable errors", () => {
		for (const input of [null, undefined, 42, "text", [manifest()]]) {
			expect(() => validateParallelWorkflowManifest(input, SOURCE)).toThrow(/manifest must be an object/);
		}
	});

	it("rejects unknown keys at manifest, contract, shard, and review levels", () => {
		expect(() => validateParallelWorkflowManifest(manifest({ extra: 1 } as ManifestOverrides), SOURCE)).toThrow(
			/manifest has unknown key "extra"/,
		);
		expect(() =>
			validateParallelWorkflowManifest(manifest({ contracts: [contract({ notes: "x" })] }), SOURCE),
		).toThrow(/contracts\[0\] has unknown key "notes"/);
		expect(() => validateParallelWorkflowManifest(manifest({ shards: [shard({ shell: "rm" })] }), SOURCE)).toThrow(
			/shards\[0\] has unknown key "shell"/,
		);
		expect(() =>
			validateParallelWorkflowManifest(
				manifest({ shards: [shard({ review: { agent: "reviewer", required: true, force: true } })] }),
				SOURCE,
			),
		).toThrow(/shards\[0\]\.review has unknown key "force"/);
	});

	it("ignores inherited properties instead of treating them as fields", () => {
		const input = Object.create(manifest()) as Record<string, unknown>;

		expect(() => validateParallelWorkflowManifest(input, SOURCE)).toThrow(/run must be a string/);
	});

	it("rejects malformed run IDs", () => {
		for (const run of ["", "  ", "Upper-Case", "-leading", "has spaces", "a".repeat(65)]) {
			expect(() => validateParallelWorkflowManifest(manifest({ run }), SOURCE)).toThrow(/run must match/);
		}
	});

	it("rejects maxConcurrency outside 1 through 32 or non-integer values", () => {
		for (const maxConcurrency of [0, 33, 2.5, -1, "4", null, undefined]) {
			expect(() => validateParallelWorkflowManifest(manifest({ maxConcurrency }), SOURCE)).toThrow(
				/maxConcurrency must be an integer from 1 through 32/,
			);
		}
	});

	it("accepts the maxConcurrency boundary values", () => {
		expect(validateParallelWorkflowManifest(manifest({ maxConcurrency: 1 }), SOURCE).maxConcurrency).toBe(1);
		expect(validateParallelWorkflowManifest(manifest({ maxConcurrency: 32 }), SOURCE).maxConcurrency).toBe(32);
	});

	it("rejects blank or oversized model selectors", () => {
		expect(() => validateParallelWorkflowManifest(manifest({ model: "   " }), SOURCE)).toThrow(
			/model must not be blank/,
		);
		expect(() => validateParallelWorkflowManifest(manifest({ model: "m".repeat(201) }), SOURCE)).toThrow(
			/model exceeds the 200-character bound/,
		);
	});

	it("rejects blank shard prompt, kind, and agent values", () => {
		expect(() => validateParallelWorkflowManifest(manifest({ shards: [shard({ prompt: "  " })] }), SOURCE)).toThrow(
			/shards\[0\]\.prompt must not be blank/,
		);
		expect(() => validateParallelWorkflowManifest(manifest({ shards: [shard({ kind: "" })] }), SOURCE)).toThrow(
			/shards\[0\]\.kind must not be blank/,
		);
		expect(() => validateParallelWorkflowManifest(manifest({ shards: [shard({ agent: " " })] }), SOURCE)).toThrow(
			/shards\[0\]\.agent must not be blank/,
		);
	});

	it("rejects blank contract descriptions and malformed contract IDs", () => {
		expect(() =>
			validateParallelWorkflowManifest(manifest({ contracts: [contract({ description: "  " })] }), SOURCE),
		).toThrow(/contracts\[0\]\.description must not be blank/);
		expect(() =>
			validateParallelWorkflowManifest(manifest({ contracts: [contract({ id: "Bad_ID" })] }), SOURCE),
		).toThrow(/contracts\[0\]\.id must match/);
	});

	it("rejects an empty shard list", () => {
		expect(() => validateParallelWorkflowManifest(manifest({ shards: [] }), SOURCE)).toThrow(
			/shards must declare at least one shard/,
		);
	});

	it("rejects duplicate contract and shard IDs", () => {
		expect(() =>
			validateParallelWorkflowManifest(
				manifest({
					contracts: [contract(), contract()],
					shards: [shard({ produces: ["delegation-config-v1"] })],
				}),
				SOURCE,
			),
		).toThrow(/contract "delegation-config-v1" is declared more than once/);
		expect(() =>
			validateParallelWorkflowManifest(
				manifest({ shards: [shard(), shard({ owns: ["other.ts"], produces: [] })] }),
				SOURCE,
			),
		).toThrow(/shard "delegation-config" is declared more than once/);
	});

	it("rejects a contract whose owner shard does not exist", () => {
		expect(() =>
			validateParallelWorkflowManifest(
				manifest({ contracts: [contract({ owner: "ghost" })], shards: [shard({ produces: [] })] }),
				SOURCE,
			),
		).toThrow(/contract "delegation-config-v1" names unknown owner shard "ghost"/);
	});

	it("rejects a contract whose owner shard does not produce it", () => {
		expect(() => validateParallelWorkflowManifest(manifest({ shards: [shard({ produces: [] })] }), SOURCE)).toThrow(
			/does not list it in produces/,
		);
	});

	it("rejects produces entries that name unknown contracts", () => {
		expect(() =>
			validateParallelWorkflowManifest(
				manifest({ shards: [shard({ produces: ["delegation-config-v1", "ghost-contract"] })] }),
				SOURCE,
			),
		).toThrow(/shard "delegation-config" produces unknown contract "ghost-contract"/);
	});

	it("rejects a shard producing a contract owned by another shard", () => {
		expect(() =>
			validateParallelWorkflowManifest(
				manifest({
					shards: [
						shard(),
						shard({ id: "impostor", owns: ["src/impostor.ts"], produces: ["delegation-config-v1"] }),
					],
				}),
				SOURCE,
			),
		).toThrow(/shard "impostor" produces contract "delegation-config-v1" owned by shard "delegation-config"/);
	});

	it("rejects requires entries that name unknown contracts", () => {
		expect(() =>
			validateParallelWorkflowManifest(
				manifest({
					shards: [shard(), shard({ id: "consumer", owns: ["src/c.ts"], produces: [], requires: ["ghost"] })],
				}),
				SOURCE,
			),
		).toThrow(/shard "consumer" requires unknown contract "ghost"/);
	});

	it("rejects implicit dependency edges: required contract owner missing from dependsOn", () => {
		expect(() => validateParallelWorkflowManifest(chainedManifest({ dependsOn: [] }), SOURCE)).toThrow(
			/implicit dependency edges are rejected/,
		);
	});

	it("accepts an explicit dependency edge for a required contract", () => {
		const plan = validateParallelWorkflowManifest(chainedManifest(), SOURCE);

		expect(plan.shards[1]?.dependsOn).toEqual(["delegation-config"]);
	});

	it("rejects self-referential and unknown dependencies", () => {
		expect(() =>
			validateParallelWorkflowManifest(manifest({ shards: [shard({ dependsOn: ["delegation-config"] })] }), SOURCE),
		).toThrow(/shard "delegation-config" depends on itself/);
		expect(() =>
			validateParallelWorkflowManifest(manifest({ shards: [shard({ dependsOn: ["ghost"] })] }), SOURCE),
		).toThrow(/shard "delegation-config" depends on unknown shard "ghost"/);
	});

	it("rejects dependency cycles", () => {
		expect(() =>
			validateParallelWorkflowManifest(
				manifest({
					contracts: [],
					shards: [
						shard({ id: "a", owns: ["a.ts"], produces: [], dependsOn: ["b"] }),
						shard({ id: "b", owns: ["b.ts"], produces: [], dependsOn: ["c"] }),
						shard({ id: "c", owns: ["c.ts"], produces: [], dependsOn: ["a"] }),
					],
				}),
				SOURCE,
			),
		).toThrow(/dependency cycle detected involving shards: a, b, c/);
	});

	it("rejects duplicate entries within produces, requires, and dependsOn lists", () => {
		expect(() =>
			validateParallelWorkflowManifest(
				manifest({ shards: [shard({ produces: ["delegation-config-v1", "delegation-config-v1"] })] }),
				SOURCE,
			),
		).toThrow(/shards\[0\]\.produces lists "delegation-config-v1" more than once/);
		expect(() =>
			validateParallelWorkflowManifest(
				chainedManifest({ dependsOn: ["delegation-config", "delegation-config"] }),
				SOURCE,
			),
		).toThrow(/shards\[1\]\.dependsOn lists "delegation-config" more than once/);
	});

	describe("owned paths", () => {
		it("rejects absolute paths, traversal, backslashes, drive letters, and blanks", () => {
			const cases: Array<[string, RegExp]> = [
				["/etc/passwd", /absolute paths are not allowed/],
				["C:/repo/file.ts", /absolute paths are not allowed/],
				["../outside.ts", /must not traverse outside the project/],
				["src/../../outside.ts", /must not traverse outside the project/],
				["src\\config.ts", /backslashes are not allowed/],
				["   ", /must not be blank/],
				["./", /normalizes to an empty path/],
			];
			for (const [owned, message] of cases) {
				expect(() =>
					validateParallelWorkflowManifest(manifest({ shards: [shard({ owns: [owned] })] }), SOURCE),
				).toThrow(message);
			}
			expect(() => validateParallelWorkflowManifest(manifest({ shards: [shard({ owns: [42] })] }), SOURCE)).toThrow(
				/shards\[0\]\.owns\[0\] must be a string path/,
			);
		});

		it("normalizes dot segments, duplicate slashes, and trailing slashes", () => {
			const plan = validateParallelWorkflowManifest(
				manifest({ shards: [shard({ owns: ["./src//config.ts", "test/config.test.ts/"] })] }),
				SOURCE,
			);

			expect(plan.shards[0]?.owns).toEqual(["src/config.ts", "test/config.test.ts"]);
		});

		it("rejects duplicate paths within one shard, including post-normalization duplicates", () => {
			expect(() =>
				validateParallelWorkflowManifest(
					manifest({ shards: [shard({ owns: ["src/config.ts", "./src/config.ts"] })] }),
					SOURCE,
				),
			).toThrow(/shards\[0\]\.owns lists "src\/config.ts" more than once/);
		});

		it("rejects the same path owned by two shards", () => {
			expect(() =>
				validateParallelWorkflowManifest(
					manifest({
						contracts: [],
						shards: [
							shard({ id: "a", owns: ["src/shared.ts"], produces: [] }),
							shard({ id: "b", owns: ["src/shared.ts"], produces: [] }),
						],
					}),
					SOURCE,
				),
			).toThrow(/path "src\/shared.ts" is owned by both shard "a" and shard "b"/);
		});

		it("rejects overlapping paths where one shard owns an ancestor of another shard's path", () => {
			expect(() =>
				validateParallelWorkflowManifest(
					manifest({
						contracts: [],
						shards: [
							shard({ id: "a", owns: ["src"], produces: [] }),
							shard({ id: "b", owns: ["src/config.ts"], produces: [] }),
						],
					}),
					SOURCE,
				),
			).toThrow(/overlaps/);
			expect(() =>
				validateParallelWorkflowManifest(
					manifest({
						contracts: [],
						shards: [
							shard({ id: "a", owns: ["src/config.ts"], produces: [] }),
							shard({ id: "b", owns: ["src"], produces: [] }),
						],
					}),
					SOURCE,
				),
			).toThrow(/overlaps/);
		});

		it("allows sibling paths that share a directory without overlap", () => {
			const plan = validateParallelWorkflowManifest(
				manifest({
					contracts: [],
					shards: [
						shard({ id: "a", owns: ["src/a.ts"], produces: [] }),
						shard({ id: "b", owns: ["src/b.ts"], produces: [] }),
					],
				}),
				SOURCE,
			);

			expect(plan.shards).toHaveLength(2);
		});
	});

	describe("review entries", () => {
		it("rejects blank review agents and non-boolean required flags", () => {
			expect(() =>
				validateParallelWorkflowManifest(
					manifest({ shards: [shard({ review: { agent: " ", required: true } })] }),
					SOURCE,
				),
			).toThrow(/shards\[0\]\.review\.agent must not be blank/);
			expect(() =>
				validateParallelWorkflowManifest(
					manifest({ shards: [shard({ review: { agent: "reviewer", required: "yes" } })] }),
					SOURCE,
				),
			).toThrow(/shards\[0\]\.review\.required must be a boolean/);
			expect(() =>
				validateParallelWorkflowManifest(manifest({ shards: [shard({ review: { agent: "reviewer" } })] }), SOURCE),
			).toThrow(/shards\[0\]\.review\.required must be a boolean/);
		});

		it("rejects non-object review values", () => {
			expect(() =>
				validateParallelWorkflowManifest(manifest({ shards: [shard({ review: "reviewer" })] }), SOURCE),
			).toThrow(/shards\[0\]\.review must be an object mapping/);
		});
	});
});

describe("parseParallelWorkflowManifest", () => {
	const YAML_TEXT = `
run: cache-aware-delegation
model: "@smol"
maxConcurrency: 4
contracts:
  - id: delegation-config-v1
    description: Validated delegation configuration and defaults.
    owner: delegation-config
shards:
  - id: delegation-config
    kind: implementation
    agent: task
    prompt: Implement and test the delegation configuration contract.
    owns:
      - src/config.ts
      - test/config.test.ts
    produces:
      - delegation-config-v1
    requires: []
    dependsOn: []
    review:
      agent: reviewer
      required: true
`;

	it("parses a YAML manifest into a validated plan", () => {
		const plan = parseParallelWorkflowManifest(YAML_TEXT, SOURCE);

		expect(plan.run).toBe("cache-aware-delegation");
		expect(plan.shards[0]?.review).toEqual({ agent: "reviewer", required: true });
	});

	it("parses JSON-shaped input because YAML is a JSON superset", () => {
		const plan = parseParallelWorkflowManifest(JSON.stringify(manifest()), SOURCE);

		expect(plan.run).toBe("cache-aware-delegation");
		expect(plan.planHash).toBe(validateParallelWorkflowManifest(manifest(), SOURCE).planHash);
	});

	it("rejects malformed YAML with an actionable error naming the source", () => {
		expect(() => parseParallelWorkflowManifest("run: [unclosed", SOURCE)).toThrow(
			/Invalid parallel workflow manifest \(manifest\.yml\): unable to parse YAML/,
		);
	});

	it("rejects scalar and sequence top-level documents", () => {
		expect(() => parseParallelWorkflowManifest("just a string", SOURCE)).toThrow(/manifest must be an object/);
		expect(() => parseParallelWorkflowManifest("- a\n- b\n", SOURCE)).toThrow(/manifest must be an object/);
	});
});

describe("loadParallelWorkflowManifest", () => {
	it("loads and validates a manifest file from disk", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "parallel-contracts-"));
		const file = path.join(dir, "manifest.yml");
		try {
			await fs.writeFile(file, JSON.stringify(manifest()), "utf8");

			const plan = await loadParallelWorkflowManifest(file);

			expect(plan.run).toBe("cache-aware-delegation");
			expect(plan.sourcePath).toBe(file);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("reports an actionable error for a missing file", async () => {
		expect(loadParallelWorkflowManifest("/nonexistent/manifest.yml")).rejects.toThrow(/unable to read manifest file/);
	});
});

describe("canonical plan hashing", () => {
	it("produces identical hashes for equivalent manifests with different formatting", () => {
		const yamlPlan = parseParallelWorkflowManifest(
			`
run: cache-aware-delegation
model: '@smol'
maxConcurrency: 4
contracts:
  - owner: delegation-config
    id: delegation-config-v1
    description: "Validated delegation configuration and defaults."
shards:
  - prompt: "  Implement and test the delegation configuration contract.  "
    id: delegation-config
    kind: implementation
    agent: task
    owns: ["./src/config.ts", "test/config.test.ts"]
    produces: [delegation-config-v1]
    requires: []
    dependsOn: []
`,
			"other-source.yml",
		);
		const objectPlan = validateParallelWorkflowManifest(manifest(), SOURCE);

		expect(yamlPlan.planHash).toBe(objectPlan.planHash);
	});

	it("changes the hash when any normalized field changes", () => {
		const base = validateParallelWorkflowManifest(manifest(), SOURCE);
		const differentConcurrency = validateParallelWorkflowManifest(manifest({ maxConcurrency: 5 }), SOURCE);
		const withoutModel = manifest();
		delete withoutModel.model;
		const noModel = validateParallelWorkflowManifest(withoutModel, SOURCE);

		expect(differentConcurrency.planHash).not.toBe(base.planHash);
		expect(noModel.planHash).not.toBe(base.planHash);
	});

	it("keeps the hash independent of the source path", () => {
		const a = validateParallelWorkflowManifest(manifest(), "a.yml");
		const b = validateParallelWorkflowManifest(manifest(), "b.yml");

		expect(a.planHash).toBe(b.planHash);
	});

	it("hashes shard order: reordering shards is a different plan", () => {
		const twoShards = manifest({
			contracts: [],
			shards: [shard({ id: "a", owns: ["a.ts"], produces: [] }), shard({ id: "b", owns: ["b.ts"], produces: [] })],
		});
		const reversed = manifest({
			contracts: [],
			shards: [shard({ id: "b", owns: ["b.ts"], produces: [] }), shard({ id: "a", owns: ["a.ts"], produces: [] })],
		});

		const planA = validateParallelWorkflowManifest(twoShards, SOURCE);
		const planB = validateParallelWorkflowManifest(reversed, SOURCE);

		expect(canonicalParallelPlan(planA)).toBe(canonicalParallelPlan(planA));
		expect(planA.planHash).not.toBe(planB.planHash);
	});
});

describe("getParallelDependencyWaves", () => {
	function diamondPlan(): ParallelWorkflowPlan {
		return validateParallelWorkflowManifest(
			manifest({
				contracts: [],
				shards: [
					shard({ id: "root", owns: ["root.ts"], produces: [] }),
					shard({ id: "left", owns: ["left.ts"], produces: [], dependsOn: ["root"] }),
					shard({ id: "right", owns: ["right.ts"], produces: [], dependsOn: ["root"] }),
					shard({ id: "join", owns: ["join.ts"], produces: [], dependsOn: ["left", "right"] }),
				],
			}),
			SOURCE,
		);
	}

	it("groups shards into dependency waves in stable manifest order", () => {
		const waves = getParallelDependencyWaves(diamondPlan());

		expect(waves.map(wave => wave.map(entry => entry.id))).toEqual([["root"], ["left", "right"], ["join"]]);
	});

	it("keeps manifest order within a wave even when IDs sort differently", () => {
		const plan = validateParallelWorkflowManifest(
			manifest({
				contracts: [],
				shards: [
					shard({ id: "z-first", owns: ["z.ts"], produces: [] }),
					shard({ id: "a-second", owns: ["a.ts"], produces: [] }),
				],
			}),
			SOURCE,
		);

		const waves = getParallelDependencyWaves(plan);

		expect(waves.map(wave => wave.map(entry => entry.id))).toEqual([["z-first", "a-second"]]);
	});
});

describe("decideParallelSchedule", () => {
	function diamondPlan(maxConcurrency = 4): ParallelWorkflowPlan {
		return validateParallelWorkflowManifest(
			manifest({
				maxConcurrency,
				contracts: [],
				shards: [
					shard({ id: "root", owns: ["root.ts"], produces: [] }),
					shard({ id: "left", owns: ["left.ts"], produces: [], dependsOn: ["root"] }),
					shard({ id: "right", owns: ["right.ts"], produces: [], dependsOn: ["root"] }),
					shard({ id: "join", owns: ["join.ts"], produces: [], dependsOn: ["left", "right"] }),
				],
			}),
			SOURCE,
		);
	}

	it("marks only dependency-free shards ready when nothing has run", () => {
		const decision = decideParallelSchedule(diamondPlan(), [], []);

		expect(decision.ready.map(entry => entry.id)).toEqual(["root"]);
		expect(decision.blocked.map(entry => entry.id)).toEqual(["left", "right", "join"]);
		expect(decision.terminal).toBe(false);
	});

	it("unblocks dependents once dependencies complete, in manifest order", () => {
		const decision = decideParallelSchedule(diamondPlan(), [shardState("root", "completed")], []);

		expect(decision.ready.map(entry => entry.id)).toEqual(["left", "right"]);
		expect(decision.blocked.map(entry => entry.id)).toEqual(["join"]);
	});

	it("caps ready shards by maxConcurrency minus running shards", () => {
		const plan = diamondPlan(2);
		const unbounded = decideParallelSchedule(plan, [shardState("root", "completed")], []);
		const withRunning = decideParallelSchedule(
			plan,
			[shardState("root", "completed"), shardState("left", "running")],
			[],
		);

		expect(unbounded.ready.map(entry => entry.id)).toEqual(["left", "right"]);
		expect(withRunning.ready.map(entry => entry.id)).toEqual(["right"]);
		expect(withRunning.terminal).toBe(false);
	});

	it("keeps dependents blocked while a required review is pending or rejected", () => {
		const plan = validateParallelWorkflowManifest(chainedManifest(), SOURCE);
		const completed = [shardState("delegation-config", "completed")];

		const pendingReview = decideParallelSchedule(plan, completed, [reviewState("delegation-config", "pending")]);
		const rejectedReview = decideParallelSchedule(plan, completed, [reviewState("delegation-config", "rejected")]);
		const approvedReview = decideParallelSchedule(plan, completed, [reviewState("delegation-config", "approved")]);

		expect(pendingReview.ready).toEqual([]);
		expect(rejectedReview.ready).toEqual([]);
		expect(approvedReview.ready.map(entry => entry.id)).toEqual(["consumer"]);
	});

	it("treats a missing review state as pending for a required review", () => {
		const plan = validateParallelWorkflowManifest(chainedManifest(), SOURCE);

		const decision = decideParallelSchedule(plan, [shardState("delegation-config", "completed")], []);

		expect(decision.ready).toEqual([]);
		expect(decision.blocked.map(entry => entry.id)).toEqual(["consumer"]);
	});

	it("does not gate dependents on an optional review", () => {
		const plan = validateParallelWorkflowManifest(
			manifest({
				shards: [
					shard({ review: { agent: "reviewer", required: false } }),
					shard({
						id: "consumer",
						owns: ["src/consumer.ts"],
						produces: [],
						requires: ["delegation-config-v1"],
						dependsOn: ["delegation-config"],
					}),
				],
			}),
			SOURCE,
		);

		const decision = decideParallelSchedule(plan, [shardState("delegation-config", "completed")], []);

		expect(decision.ready.map(entry => entry.id)).toEqual(["consumer"]);
	});

	it("keeps dependents blocked behind failed or cancelled dependencies and reports terminal", () => {
		const plan = diamondPlan();
		const decision = decideParallelSchedule(
			plan,
			[
				shardState("root", "failed"),
				shardState("left", "pending"),
				shardState("right", "cancelled"),
				shardState("join", "pending"),
			],
			[],
		);

		expect(decision.ready).toEqual([]);
		expect(decision.blocked.map(entry => entry.id)).toEqual(["left", "join"]);
		expect(decision.terminal).toBe(true);
	});

	it("is not terminal while shards or reviews are running or a review is dispatchable", () => {
		const chained = validateParallelWorkflowManifest(chainedManifest(), SOURCE);
		const running = decideParallelSchedule(
			chained,
			[shardState("delegation-config", "running"), shardState("consumer", "cancelled")],
			[],
		);
		const reviewRunning = decideParallelSchedule(
			chained,
			[shardState("delegation-config", "review_pending"), shardState("consumer", "cancelled")],
			[reviewState("delegation-config", "running")],
		);
		const reviewDispatchable = decideParallelSchedule(
			chained,
			[shardState("delegation-config", "completed"), shardState("consumer", "cancelled")],
			[reviewState("delegation-config", "pending")],
		);

		expect(running.terminal).toBe(false);
		expect(reviewRunning.terminal).toBe(false);
		expect(reviewDispatchable.terminal).toBe(false);
	});

	it("reports terminal when every shard reached a terminal state", () => {
		const plan = validateParallelWorkflowManifest(chainedManifest(), SOURCE);
		const decision = decideParallelSchedule(
			plan,
			[shardState("delegation-config", "approved"), shardState("consumer", "approved")],
			[reviewState("delegation-config", "approved")],
		);

		expect(decision.ready).toEqual([]);
		expect(decision.blocked).toEqual([]);
		expect(decision.terminal).toBe(true);
	});

	it("returns identical decisions for repeated calls with the same input", () => {
		const plan = diamondPlan();
		const states = [shardState("root", "completed")];

		const first = decideParallelSchedule(plan, states, []);
		const second = decideParallelSchedule(plan, states, []);

		expect(second).toEqual(first);
	});
});
