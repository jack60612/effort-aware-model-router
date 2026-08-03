import type { Usage } from "@oh-my-pi/pi-ai";

export interface UsageSnapshot {
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	totalTokens: number | null;
	cost: number | null;
}

function normalizeNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function snapshotUsage(usage: Usage | undefined): UsageSnapshot | null {
	if (usage === undefined || usage === null) return null;
	return {
		input: normalizeNumber(usage.input),
		output: normalizeNumber(usage.output),
		cacheRead: normalizeNumber(usage.cacheRead),
		cacheWrite: normalizeNumber(usage.cacheWrite),
		totalTokens: normalizeNumber(usage.totalTokens),
		cost: normalizeNumber(usage.cost?.total),
	};
}

function aggregateField(snapshots: readonly UsageSnapshot[], field: keyof UsageSnapshot): number | null {
	let total = 0;
	for (const snapshot of snapshots) {
		const value = snapshot[field];
		if (value === null || !Number.isFinite(value) || value < 0) return null;
		total += value;
		if (!Number.isFinite(total)) return null;
	}
	return total;
}

export function aggregateUsage(snapshots: readonly (UsageSnapshot | null)[]): UsageSnapshot | null {
	const present = snapshots.filter((snapshot): snapshot is UsageSnapshot => snapshot !== null);
	if (present.length === 0) return null;
	return {
		input: aggregateField(present, "input"),
		output: aggregateField(present, "output"),
		cacheRead: aggregateField(present, "cacheRead"),
		cacheWrite: aggregateField(present, "cacheWrite"),
		totalTokens: aggregateField(present, "totalTokens"),
		cost: aggregateField(present, "cost"),
	};
}

export function shouldSampleShadow(sampleRate: number, randomValue: number): boolean {
	return randomValue >= 0 && randomValue < sampleRate;
}
