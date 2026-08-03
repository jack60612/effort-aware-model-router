import { describe, expect, it } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-ai";
import { aggregateUsage, shouldSampleShadow, snapshotUsage, type UsageSnapshot } from "../src/measurement";

function completeUsage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 120,
		output: 34,
		cacheRead: 56,
		cacheWrite: 7,
		totalTokens: 217,
		cost: {
			input: 0.12,
			output: 0.34,
			cacheRead: 0.056,
			cacheWrite: 0.007,
			total: 0.523,
		},
		...overrides,
	};
}

function snapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
	return {
		input: 120,
		output: 34,
		cacheRead: 56,
		cacheWrite: 7,
		totalTokens: 217,
		cost: 0.523,
		...overrides,
	};
}

describe("snapshotUsage", () => {
	it("copies all numeric usage and provider cost fields", () => {
		expect(snapshotUsage(completeUsage())).toEqual(snapshot());
	});

	it("returns null when usage is absent", () => {
		expect(snapshotUsage(undefined)).toBeNull();
	});

	it("preserves nulls for missing or invalid numeric fields", () => {
		const partial = {
			input: 10,
			output: Number.NaN,
			cacheRead: Number.POSITIVE_INFINITY,
			cacheWrite: -1,
			totalTokens: 0,
			cost: { total: -0.5 },
		} as unknown as Usage;

		expect(snapshotUsage(partial)).toEqual({
			input: 10,
			output: null,
			cacheRead: null,
			cacheWrite: null,
			totalTokens: 0,
			cost: null,
		});
	});
});

describe("aggregateUsage", () => {
	it("sums complete snapshots and preserves null for fields missing from either input", () => {
		expect(
			aggregateUsage([
				snapshot(),
				snapshot({ input: 80, output: 12, cacheRead: null, cacheWrite: 3, totalTokens: 95, cost: 0.25 }),
			]),
		).toEqual({
			input: 200,
			output: 46,
			cacheRead: null,
			cacheWrite: 10,
			totalTokens: 312,
			cost: 0.773,
		});
	});

	it("returns null for an empty or all-null list", () => {
		expect(aggregateUsage([])).toBeNull();
		expect(aggregateUsage([null, null])).toBeNull();
	});
});

describe("shouldSampleShadow", () => {
	it("rejects every random value at rate zero", () => {
		expect(shouldSampleShadow(0, 0)).toBe(false);
		expect(shouldSampleShadow(0, 0.5)).toBe(false);
	});

	it("accepts values from zero through just below rate one", () => {
		expect(shouldSampleShadow(1, 0)).toBe(true);
		expect(shouldSampleShadow(1, 0.999999)).toBe(true);
		expect(shouldSampleShadow(1, 1)).toBe(false);
	});

	it("uses an inclusive lower and exclusive upper boundary", () => {
		expect(shouldSampleShadow(0.5, 0)).toBe(true);
		expect(shouldSampleShadow(0.5, 0.5)).toBe(false);
	});

	it("rejects random values outside the normalized range", () => {
		expect(shouldSampleShadow(0.5, -0.1)).toBe(false);
		expect(shouldSampleShadow(0.5, 1.1)).toBe(false);
		expect(shouldSampleShadow(0.5, Number.NaN)).toBe(false);
	});
});
