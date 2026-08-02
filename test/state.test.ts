import { describe, expect, it } from "bun:test";
import {
	armOneShotSelector,
	consumeOneShotSelector,
	createRouterState,
	encodeRouterState,
	MODEL_ROUTER_HISTORY_LIMIT,
	MODEL_ROUTER_STATE_ENTRY,
	parseRouterState,
	type RouterDecision,
	type RouterState,
	recordRouterDecision,
	restoreRouterState,
} from "../src/state";

const base = { provider: "mock", id: "base" } as const;
const slow = { provider: "mock", id: "slow" } as const;

function custom(data: unknown) {
	return { type: "custom", customType: MODEL_ROUTER_STATE_ENTRY, data };
}

describe("model router state", () => {
	const routedDecision = (timestamp: number): RouterDecision => ({
		effort: "high",
		selector: "@slow",
		target: slow,
		thinking: "high",
		outcome: "routed",
		reason: null,
		timestamp,
		candidates: ["@slow"],
		attempts: [{ selector: "@slow", outcome: "selected" }],
		selectedCandidate: "@slow",
		profileEffort: "high",
	});

	it("seeds version-2 automatic state from the current model", () => {
		expect(createRouterState(base, true)).toEqual({
			version: 2,
			mode: "auto",
			baseline: base,
			observedModel: base,
			lastAutoModel: null,
			lastDecision: null,
			history: [],
			lastClassifiedAt: null,
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
			lastDecision: routedDecision(1_000),
			history: [routedDecision(1_000)],
			lastClassifiedAt: 1_000,
		};
		const restored = restoreRouterState(
			[custom(older), { type: "message" }, custom(latest), custom({ ...latest, mode: "broken" })],
			base,
		);
		expect(restored).toEqual(latest);
		expect(restored).not.toBe(latest);
	});

	it("upgrades version-1 state in memory without inventing history", () => {
		const migrated = parseRouterState({
			version: 1,
			mode: "auto",
			baseline: base,
			observedModel: slow,
			lastAutoModel: slow,
			lastDecision: {
				effort: "high",
				selector: "@slow",
				target: slow,
				thinking: "high",
				outcome: "routed",
				reason: null,
			},
			warningKeys: ["context"],
		});

		expect(migrated?.version).toBe(2);
		expect(migrated?.history).toEqual([]);
		expect(migrated?.lastClassifiedAt).toBeNull();
		expect(migrated?.lastDecision).toMatchObject({
			timestamp: 0,
			candidates: ["@slow"],
			attempts: [],
			selectedCandidate: "@slow",
			profileEffort: "high",
		});
	});

	it("rejects malformed nested state instead of partially trusting it", () => {
		const valid = createRouterState(base);
		const invalid = [
			null,
			{ ...valid, version: 3 },
			{ ...valid, baseline: { provider: "", id: "base" } },
			{ ...valid, warningKeys: ["ok", 4] },
			{ ...valid, lastAutoModel: { provider: "mock" } },
			{ ...valid, lastDecision: { outcome: "routed" } },
			{ ...valid, history: [{ ...routedDecision(1), attempts: [{ selector: "", outcome: "auth" }] }] },
		];
		for (const value of invalid) expect(parseRouterState(value)).toBeUndefined();
	});

	it("keeps history bounded and consumes one-shot selectors", () => {
		const state = createRouterState(base);
		for (let timestamp = 0; timestamp < MODEL_ROUTER_HISTORY_LIMIT + 2; timestamp += 1) {
			recordRouterDecision(state, routedDecision(timestamp));
		}
		expect(state.history).toHaveLength(MODEL_ROUTER_HISTORY_LIMIT);
		expect(state.history[0]?.timestamp).toBe(2);
		expect(state.lastDecision?.timestamp).toBe(MODEL_ROUTER_HISTORY_LIMIT + 1);

		expect(armOneShotSelector(state, " @slow ")).toBe(true);
		expect(state.oneShotSelector).toBe("@slow");
		expect(consumeOneShotSelector(state)).toBe("@slow");
		expect(consumeOneShotSelector(state)).toBeUndefined();
		expect(armOneShotSelector(state, "   ")).toBe(false);
	});

	it("encodes a detached validated snapshot", () => {
		const state: RouterState = {
			...createRouterState(base),
			warningKeys: ["selector"],
			lastDecision: routedDecision(1_000),
			history: [routedDecision(1_000)],
		};
		const encoded = encodeRouterState(state);
		state.warningKeys.push("later");
		state.history[0]!.candidates.push("mutated");
		expect(encoded.warningKeys).toEqual(["selector"]);
		expect(encoded.history[0]?.candidates).toEqual(["@slow"]);
		expect(parseRouterState(encoded)).toEqual(encoded);
	});

	it("falls back to a fresh seed when no valid entry exists", () => {
		const restored = restoreRouterState([custom({ mode: "bad" })], slow, false);
		expect(restored).toEqual(createRouterState(slow, false));
	});
});
