import {
	type ApiKeyResolver,
	type AssistantMessage,
	type Context,
	completeSimple,
	type Model,
	type SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { ROUTER_EFFORTS, type RouteEffort, type RouterConfig } from "./config";

/** Hard bound for classifier input after cleanup. */
export const CLASSIFIER_MAX_INPUT_CHARS = 2_000;
/**
 * Allows the answer to survive providers that emit reasoning despite an
 * explicit disable request. Non-reasoning classifiers still stop after the
 * single requested keyword.
 */
export const CLASSIFIER_MAX_TOKENS = 1_024;

const MIN_CODE_STRIPPED_CHARS = 12;
const SHORT_HASH_CHARS = 7;
const FENCED_CODE_BLOCK = /```+[\s\S]*?(?:```+|$)/g;
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;
const XML_BLOCK = /<([a-zA-Z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g;
const LONG_HEX_RUN = /\b[0-9a-fA-F]{12,}\b/g;

const BASE_SYSTEM_PROMPT = `You are a difficulty classifier for a coding agent. Read the user's request and decide how much reasoning effort the agent should spend on it this turn.

Reply with exactly one word — one of: \`low\`, \`medium\`, \`high\`, \`xhigh\`. No punctuation, no explanation, no other text.

Levels:
- \`low\` — Trivial or mechanical: a rename, typo, one-line edit, formatting tweak, direct factual question, or obvious solution.
- \`medium\` — A localized change needing some reasoning: a small self-contained feature, straightforward bug fix, or moderate code explanation.
- \`high\` — A non-trivial change spanning files or callers, real debugging, a moderate design decision, or a refactor with several moving parts.
- \`xhigh\` — Deep or open-ended: subtle concurrency or algorithms, cross-system reasoning, ambiguous requirements, large or risky refactors, or hard root-cause debugging.

Judge inherent task difficulty, not phrasing. When torn between two levels, choose the lower one.`;

const MAX_SYSTEM_PROMPT = `You are a difficulty classifier for a coding agent. Read the user's request and decide how much reasoning effort the agent should spend on it this turn.

Reply with exactly one word — one of: \`low\`, \`medium\`, \`high\`, \`xhigh\`, \`max\`. No punctuation, no explanation, no other text.

Levels:
- \`low\` — Trivial or mechanical: a rename, typo, one-line edit, formatting tweak, direct factual question, or obvious solution.
- \`medium\` — A localized change needing some reasoning: a small self-contained feature, straightforward bug fix, or moderate code explanation.
- \`high\` — A non-trivial change spanning files or callers, real debugging, a moderate design decision, or a refactor with several moving parts.
- \`xhigh\` — Deep or open-ended: subtle concurrency or algorithms, cross-system reasoning, ambiguous requirements, large or risky refactors, or hard root-cause debugging.
- \`max\` — Everything in \`xhigh\`, plus at least one of: no reproduction, an irreversible or data-loss-risking operation, or a live cutover that must remain correct while it runs.

Judge inherent task difficulty, not phrasing. When torn between two levels, choose the lower one, except choose \`max\` when its additional conditions apply.`;

export type ClassifierComplete = (
	model: Model,
	context: Context,
	options: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export interface ClassifierModelQuery {
	resolve(selector: string): Model | undefined;
}

export interface ClassifierModelRegistry {
	getApiKey(model: Model, sessionId?: string, options?: { signal?: AbortSignal }): Promise<string | undefined>;
	resolver(model: Model, sessionId?: string): ApiKeyResolver;
}

/** Public host surfaces needed by classification; deliberately excludes AgentSession actions. */
export interface ClassifierContext {
	models: ClassifierModelQuery;
	modelRegistry: ClassifierModelRegistry;
	sessionId?: string;
	signal?: AbortSignal;
}

export interface ClassifierDependencies {
	complete: ClassifierComplete;
	now: () => number;
	timeoutSignal: (milliseconds: number) => AbortSignal;
}

export type ClassifierConfig = Pick<RouterConfig, "classifierModels" | "maxEffort" | "classifierTimeoutMs">;

/** Render the fixed classifier contract, offering `max` only at that ceiling. */
export function classifierSystemPrompt(maxEffort: RouteEffort): string {
	return maxEffort === "max" ? MAX_SYSTEM_PROMPT : BASE_SYSTEM_PROMPT;
}

/**
 * Strip high-volume prompt noise, then preserve a 2:1 head/tail split within
 * the classifier's fixed character budget.
 */
export function preprocessClassifierInput(input: string): string {
	const withoutNoise = input
		.replace(ANSI_ESCAPE, "")
		.replace(XML_BLOCK, " ")
		.replace(LONG_HEX_RUN, match => match.slice(0, SHORT_HASH_CHARS));
	const withoutCode = withoutNoise
		.replace(FENCED_CODE_BLOCK, " ")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	const cleaned = withoutCode.length >= MIN_CODE_STRIPPED_CHARS ? withoutCode : withoutNoise;
	if (cleaned.length <= CLASSIFIER_MAX_INPUT_CHARS) return cleaned;

	let omitted = cleaned.length - CLASSIFIER_MAX_INPUT_CHARS;
	let marker = "";
	let headChars = 0;
	let tailChars = 0;
	for (let pass = 0; pass < 2; pass += 1) {
		marker = `\n[… ${omitted} chars omitted …]\n`;
		const keptChars = Math.max(0, CLASSIFIER_MAX_INPUT_CHARS - marker.length);
		headChars = Math.ceil((keptChars * 2) / 3);
		tailChars = keptChars - headChars;
		omitted = cleaned.length - headChars - tailChars;
	}
	marker = `\n[… ${omitted} chars omitted …]\n`;
	return `${cleaned.slice(0, headChars)}${marker}${cleaned.slice(-tailChars)}`;
}

/** Parse the first valid raw effort keyword from noisy provider output. */
export function parseClassifierEffort(text: string): RouteEffort | undefined {
	const lower = text.toLowerCase();
	const candidates: Array<[number, RouteEffort]> = [];
	const xhigh = lower.search(/\bx[\s_-]?high\b/);
	if (xhigh >= 0) candidates.push([xhigh, "xhigh"]);
	const max = lower.search(/\bmax\b/);
	if (max >= 0) candidates.push([max, "max"]);
	const high = lower.search(/\bhigh\b/);
	if (high >= 0) candidates.push([high, "high"]);
	const medium = lower.search(/\bmed(?:ium)?\b/);
	if (medium >= 0) candidates.push([medium, "medium"]);
	const low = lower.search(/\blow\b/);
	if (low >= 0) candidates.push([low, "low"]);
	if (candidates.length === 0) return undefined;

	let earliest = candidates[0];
	for (let index = 1; index < candidates.length; index += 1) {
		if (candidates[index][0] < earliest[0]) earliest = candidates[index];
	}
	return earliest[1];
}

/**
 * Classify one prompt with a direct pi-ai call. Configured selectors are
 * ordered fallback candidates: each one is resolved, authenticated, and given
 * its own completion attempt under a fresh timeout signal. Resolution and auth
 * failures skip a candidate; completion, provider, abort, and parse failures
 * fall through to the next candidate unless the caller has already cancelled.
 */
export async function classifyPromptEffort(
	promptText: string,
	config: ClassifierConfig,
	ctx: ClassifierContext,
	dependencies: Partial<ClassifierDependencies> = {},
): Promise<RouteEffort> {
	const createTimeoutSignal = dependencies.timeoutSignal ?? AbortSignal.timeout;
	const complete = dependencies.complete ?? (completeSimple as ClassifierComplete);
	const now = dependencies.now ?? Date.now;
	let attempted = false;
	let lastFailure: unknown;

	for (const selector of config.classifierModels) {
		const candidate = ctx.models.resolve(selector);
		if (!candidate) continue;

		const timeoutSignal = createTimeoutSignal(config.classifierTimeoutMs);
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;

		let key: string | undefined;
		try {
			key = await ctx.modelRegistry.getApiKey(candidate, ctx.sessionId, { signal });
		} catch (failure) {
			if (ctx.signal?.aborted) throw failure;
			continue;
		}
		if (!key) continue;

		attempted = true;
		try {
			const response = await complete(
				candidate,
				{
					systemPrompt: [classifierSystemPrompt(config.maxEffort)],
					messages: [
						{
							role: "user",
							content: preprocessClassifierInput(promptText),
							timestamp: now(),
						},
					],
				},
				{
					apiKey: ctx.modelRegistry.resolver(candidate, ctx.sessionId),
					disableReasoning: true,
					maxTokens: CLASSIFIER_MAX_TOKENS,
					signal,
				},
			);

			if (response.stopReason === "error") {
				throw new Error(`model-router: classifier provider error: ${response.errorMessage ?? "unknown error"}`);
			}
			if (response.stopReason === "aborted") {
				throw new Error(`model-router: classifier aborted: ${response.errorMessage ?? "request aborted"}`);
			}

			const text = extractText(response.content);
			const effort = parseClassifierEffort(text);
			if (!effort) {
				throw new Error(`model-router: unparseable classifier output: ${JSON.stringify(text)}`);
			}
			const classifiedIndex = ROUTER_EFFORTS.indexOf(effort);
			const ceilingIndex = ROUTER_EFFORTS.indexOf(config.maxEffort);
			return classifiedIndex <= ceilingIndex ? effort : config.maxEffort;
		} catch (failure) {
			if (ctx.signal?.aborted) throw failure;
			lastFailure = failure;
		}
	}

	if (!attempted) {
		throw new Error(
			`model-router: no authenticated classifier model available (${config.classifierModels.join(", ")})`,
		);
	}
	const detail = lastFailure instanceof Error ? lastFailure.message : String(lastFailure);
	throw new Error(
		`model-router: all classifier candidates failed (${config.classifierModels.join(", ")}); last failure: ${detail}`,
		{ cause: lastFailure },
	);
}

function extractText(content: AssistantMessage["content"]): string {
	return content
		.filter((block): block is Extract<(typeof content)[number], { type: "text" }> => block.type === "text")
		.map(block => block.text)
		.join(" ")
		.trim();
}
