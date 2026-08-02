import { describe, expect, it } from "bun:test";
import {
	createRouterState,
	encodeRouterState,
	MODEL_ROUTER_STATE_ENTRY,
	parseRouterState,
	type RouterState,
	restoreRouterState,
} from "../src/state";

const base = { provider: "mock", id: "base" } as const;
const slow = { provider: "mock", id: "slow" } as const;

function custom(data: unknown) {
	return { type: "custom", customType: MODEL_ROUTER_STATE_ENTRY, data };
}

describe("model router state", () => {
	it("seeds automatic state from the current model", () => {
		expect(createRouterState(base, true)).toEqual({
			version: 1,
			mode: "auto",
			baseline: base,
			observedModel: base,
			lastAutoModel: null,
			lastDecision: null,
			warningKeys: [],
		});
		expect(createRouterState(base, false).mode).toBe("off");
	});

	it("restores the latest valid custom entry and skips newer invalid entries", () => {
		const older: RouterState = {
			...createRouterState(base),
			mode: "manual",
			baseline: slow,
			observedModel: slow,
		};
		const latest: RouterState = {
			...createRouterState(base),
			lastAutoModel: slow,
			observedModel: slow,
			warningKeys: ["context"],
			lastDecision: {
				effort: "high",
				selector: "@slow",
				target: slow,
				thinking: "high",
				outcome: "routed",
				reason: null,
			},
		};
		const restored = restoreRouterState(
			[custom(older), { type: "message" }, custom(latest), custom({ ...latest, mode: "broken" })],
			base,
		);
		expect(restored).toEqual(latest);
		expect(restored).not.toBe(latest);
	});

	it("rejects malformed nested state instead of partially trusting it", () => {
		const valid = createRouterState(base);
		const invalid = [
			null,
			{ ...valid, version: 2 },
			{ ...valid, baseline: { provider: "", id: "base" } },
			{ ...valid, warningKeys: ["ok", 4] },
			{ ...valid, lastAutoModel: { provider: "mock" } },
			{ ...valid, lastDecision: { outcome: "routed" } },
		];
		for (const value of invalid) expect(parseRouterState(value)).toBeUndefined();
	});

	it("encodes a detached validated snapshot", () => {
		const state: RouterState = {
			...createRouterState(base),
			warningKeys: ["selector"],
			lastDecision: {
				effort: "low",
				selector: "@smol",
				target: slow,
				thinking: undefined,
				outcome: "baseline",
				reason: "auth",
			},
		};
		const encoded = encodeRouterState(state);
		state.warningKeys.push("later");
		expect(encoded.warningKeys).toEqual(["selector"]);
		expect(parseRouterState(encoded)).toEqual(encoded);
	});

	it("falls back to a fresh seed when no valid entry exists", () => {
		const restored = restoreRouterState([custom({ mode: "bad" })], slow, false);
		expect(restored).toEqual(createRouterState(slow, false));
	});
});
