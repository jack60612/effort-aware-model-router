import { describe, expect, it } from "bun:test";
import {
	clampEffortToModel,
	estimatePromptTokens,
	formatModelSelector,
	hasContextCapacity,
	modelsEqual,
	resolveThinkingEffort,
	type RoutableModel,
	selectThresholdCandidates,
	selectThresholdSelector,
} from "../src/routing";

function model(overrides: Partial<RoutableModel> = {}): RoutableModel {
	return {
		provider: "test-provider",
		id: "test-model",
		reasoning: true,
		thinking: { efforts: ["low", "medium", "high", "xhigh", "max"] },
		contextWindow: 128_000,
		...overrides,
	};
}

describe("selectThresholdSelector", () => {
	const thresholds = {
		low: "model/low",
		high: "model/high",
		xhigh: "model/xhigh",
	} as const;

	it("selects the highest configured threshold at or below the classified effort", () => {
		expect(selectThresholdSelector("low", thresholds)).toBe("model/low");
		expect(selectThresholdSelector("medium", thresholds)).toBe("model/low");
		expect(selectThresholdSelector("high", thresholds)).toBe("model/high");
		expect(selectThresholdSelector("max", thresholds)).toBe("model/xhigh");
	});

	it("returns only the selected selector and never an implicit lower-threshold retry list", () => {
		const selection = selectThresholdSelector("xhigh", thresholds);

		expect(selection).toBe("model/xhigh");
		expect(Array.isArray(selection)).toBe(false);
	});

	it("returns undefined when no configured threshold is low enough", () => {
		expect(selectThresholdSelector("low", { medium: "model/medium" })).toBeUndefined();
	});

	it("ignores inherited and malformed threshold values", () => {
		const configured = Object.create({ low: "inherited/low" }) as Record<string, unknown>;
		configured.medium = 12;
		configured.high = "own/high";

		expect(selectThresholdSelector("medium", configured)).toBeUndefined();
		expect(selectThresholdSelector("max", configured)).toBe("own/high");
	});
});

describe("selectThresholdCandidates", () => {
	it("returns the ordered candidates from the nearest configured threshold", () => {
		const thresholds = {
			low: ["model/low", "model/low-fallback"],
			high: ["model/high"],
			xhigh: ["model/xhigh", "model/xhigh-fallback"],
		};

		expect(selectThresholdCandidates("medium", thresholds)).toEqual(["model/low", "model/low-fallback"]);
		expect(selectThresholdCandidates("xhigh", thresholds)).toEqual(["model/xhigh", "model/xhigh-fallback"]);
		expect(selectThresholdCandidates("max", thresholds)).toEqual(["model/xhigh", "model/xhigh-fallback"]);
	});

	it("accepts legacy strings and ignores inherited or malformed candidates", () => {
		const configured = Object.create({ low: ["inherited/low"] }) as Record<string, unknown>;
		configured.medium = ["", 12, "own/medium"];
		configured.high = "own/high";

		expect(selectThresholdCandidates("medium", configured)).toEqual(["own/medium"]);
		expect(selectThresholdCandidates("max", configured)).toEqual(["own/high"]);
		expect(selectThresholdCandidates("low", configured)).toEqual([]);
	});
});

describe("resolveThinkingEffort", () => {
	it("prefers an exact effort override, then the profile default, then classification", () => {
		expect(resolveThinkingEffort("xhigh", { default: "low", xhigh: "medium" })).toBe("medium");
		expect(resolveThinkingEffort("high", { default: "low", xhigh: "medium" })).toBe("low");
		expect(resolveThinkingEffort("high", undefined)).toBe("high");
	});

	it("ignores malformed profile values", () => {
		expect(resolveThinkingEffort("high", { default: "invalid" })).toBe("high");
		expect(resolveThinkingEffort("high", { default: "minimal" })).toBe("minimal");
	});
});

describe("model helpers", () => {
	it("formats a stable provider/id selector", () => {
		expect(formatModelSelector(model({ provider: "openai", id: "gpt-5" }))).toBe("openai/gpt-5");
	});

	it("compares model identity by provider and id rather than object identity or display name", () => {
		const first = model({ provider: "openai", id: "gpt-5", name: "First label" });
		const same = model({ provider: "openai", id: "gpt-5", name: "Different label" });
		const differentProvider = model({ provider: "azure", id: "gpt-5" });

		expect(modelsEqual(first, same)).toBe(true);
		expect(modelsEqual(first, differentProvider)).toBe(false);
		expect(modelsEqual(first, undefined)).toBe(false);
		expect(modelsEqual(undefined, undefined)).toBe(true);
	});
});

describe("clampEffortToModel", () => {
	it("keeps a requested effort the model supports", () => {
		expect(clampEffortToModel("high", model())).toBe("high");
	});

	it("clamps down to the greatest supported effort below the request", () => {
		const target = model({ thinking: { efforts: ["low", "medium", "high"] } });

		expect(clampEffortToModel("max", target)).toBe("high");
	});

	it("uses the model minimum when every supported effort is above the request", () => {
		const target = model({ thinking: { efforts: ["medium", "high"] } });

		expect(clampEffortToModel("low", target)).toBe("medium");
	});

	it("returns undefined for non-reasoning or non-controllable models", () => {
		expect(clampEffortToModel("high", model({ reasoning: false }))).toBeUndefined();
		expect(clampEffortToModel("high", model({ thinking: undefined }))).toBeUndefined();
	});

	it("ignores malformed and unsupported effort metadata", () => {
		const target = model({ thinking: { efforts: ["unknown", "high", "high"] } });

		expect(clampEffortToModel("max", target)).toBe("high");
	});
});

describe("context helpers", () => {
	it("estimates prompt tokens conservatively from character count", () => {
		expect(estimatePromptTokens("")).toBe(0);
		expect(estimatePromptTokens("1234")).toBe(1);
		expect(estimatePromptTokens("12345")).toBe(2);
	});

	it("accepts context at the boundary and rejects overflow", () => {
		const target = model({ contextWindow: 100 });

		expect(hasContextCapacity(target, 90, 10)).toBe(true);
		expect(hasContextCapacity(target, 91, 10)).toBe(false);
	});

	it("fails closed for unknown windows or invalid token counts", () => {
		expect(hasContextCapacity(model({ contextWindow: null }), 10, 10)).toBe(false);
		expect(hasContextCapacity(model({ contextWindow: Number.NaN }), 10, 10)).toBe(false);
		expect(hasContextCapacity(model(), -1, 10)).toBe(false);
		expect(hasContextCapacity(model(), 10, Number.POSITIVE_INFINITY)).toBe(false);
	});
});
