import { describe, expect, it } from "bun:test";
import type { ApiKeyResolver, AssistantMessage, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import {
	CLASSIFIER_MAX_INPUT_CHARS,
	CLASSIFIER_MAX_TOKENS,
	type ClassifierComplete,
	type ClassifierContext,
	classifierSystemPrompt,
	classifyPromptEffort,
	parseClassifierEffort,
	preprocessClassifierInput,
} from "../src/classifier";

function classifierModel(id: string): Model {
	return {
		api: "openai-responses",
		provider: "mock-provider",
		id,
	} as Model;
}

function response(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "mock-provider",
		model: "classifier",
		usage: {},
		stopReason: "stop",
		timestamp: 123,
		...overrides,
	} as AssistantMessage;
}

const baseConfig = {
	classifierModels: ["@tiny", "@smol"],
	maxEffort: "xhigh",
	classifierTimeoutMs: 4_000,
} as const;

describe("classifyPromptEffort", () => {
	it("selects the first authenticated configured model and makes one direct completion call", async () => {
		const tiny = classifierModel("tiny");
		const smol = classifierModel("smol");
		const resolvedSelectors: string[] = [];
		const keyChecks: Array<{ model: Model; sessionId: string | undefined; signal: AbortSignal | undefined }> = [];
		const resolverCalls: Array<{ model: Model; sessionId: string | undefined }> = [];
		const completionCalls: Array<{
			model: Model;
			context: Context;
			options: SimpleStreamOptions;
		}> = [];
		const apiKeyResolver: ApiKeyResolver = () => "smol-key";
		const timeoutSignals = [new AbortController().signal, new AbortController().signal];
		const timeoutRequests: number[] = [];
		const ctx: ClassifierContext = {
			models: {
				resolve(selector) {
					resolvedSelectors.push(selector);
					return selector === "@tiny" ? tiny : selector === "@smol" ? smol : undefined;
				},
			},
			modelRegistry: {
				async getApiKey(model, sessionId, options) {
					keyChecks.push({ model, sessionId, signal: options?.signal });
					return model === tiny ? undefined : "smol-key";
				},
				resolver(model, sessionId) {
					resolverCalls.push({ model, sessionId });
					return apiKeyResolver;
				},
			},
			sessionId: "session-42",
		};
		const complete: ClassifierComplete = async (model, context, options) => {
			completionCalls.push({ model, context, options });
			return response("high");
		};

		const effort = await classifyPromptEffort("fix the parser", baseConfig, ctx, {
			complete,
			now: () => 987,
			timeoutSignal: ms => {
				timeoutRequests.push(ms);
				return timeoutSignals[timeoutRequests.length - 1];
			},
		});

		expect(effort).toBe("high");
		expect(resolvedSelectors).toEqual(["@tiny", "@smol"]);
		expect(timeoutRequests).toEqual([4_000, 4_000]);
		expect(keyChecks).toEqual([
			{ model: tiny, sessionId: "session-42", signal: timeoutSignals[0] },
			{ model: smol, sessionId: "session-42", signal: timeoutSignals[1] },
		]);
		expect(resolverCalls).toEqual([{ model: smol, sessionId: "session-42" }]);
		expect(completionCalls).toHaveLength(1);
		expect(completionCalls[0]).toEqual({
			model: smol,
			context: {
				systemPrompt: [classifierSystemPrompt("xhigh")],
				messages: [{ role: "user", content: "fix the parser", timestamp: 987 }],
			},
			options: {
				apiKey: apiKeyResolver,
				disableReasoning: true,
				maxTokens: CLASSIFIER_MAX_TOKENS,
				signal: timeoutSignals[1],
			},
		});
	});

	it("does not depend on an agent session or sendUserMessage", async () => {
		const selected = classifierModel("selected");
		const poison = {
			get session(): never {
				throw new Error("session must not be read");
			},
			get sendUserMessage(): never {
				throw new Error("sendUserMessage must not be read");
			},
		};
		const ctx = Object.assign(poison, {
			models: { resolve: () => selected },
			modelRegistry: {
				getApiKey: async () => "key",
				resolver: () => (() => "key") as ApiKeyResolver,
			},
			sessionId: "session-id",
		}) satisfies ClassifierContext;

		await expect(
			classifyPromptEffort("rename this", baseConfig, ctx, {
				complete: async () => response("low"),
			}),
		).resolves.toBe("low");
	});

	it("offers max only when the configured ceiling is max", () => {
		expect(classifierSystemPrompt("max")).toContain("`max`");
		for (const ceiling of ["low", "medium", "high", "xhigh"] as const) {
			expect(classifierSystemPrompt(ceiling)).not.toContain("`max`");
		}
	});

	it("caps max output at the configured ceiling", async () => {
		const selected = classifierModel("selected");
		const ctx: ClassifierContext = {
			models: { resolve: () => selected },
			modelRegistry: {
				getApiKey: async () => "key",
				resolver: () => (() => "key") as ApiKeyResolver,
			},
		};
		const dependencies = {
			complete: async () => response("max"),
		};

		await expect(classifyPromptEffort("risky task", baseConfig, ctx, dependencies)).resolves.toBe("xhigh");
		await expect(
			classifyPromptEffort("risky task", { ...baseConfig, maxEffort: "max" }, ctx, dependencies),
		).resolves.toBe("max");
	});

	it("extracts text blocks and accepts the earliest valid keyword", async () => {
		const selected = classifierModel("selected");
		const ctx: ClassifierContext = {
			models: { resolve: () => selected },
			modelRegistry: {
				getApiKey: async () => "key",
				resolver: () => (() => "key") as ApiKeyResolver,
			},
		};

		const effort = await classifyPromptEffort("investigate", baseConfig, ctx, {
			complete: async () =>
				response("", {
					content: [
						{ type: "thinking", thinking: "ignore max", thinkingSignature: "sig" },
						{ type: "text", text: "medium after review" },
						{ type: "text", text: "x-high" },
					],
				}),
		});

		expect(effort).toBe("medium");
	});

	it("falls back to the next candidate when the first completion throws", async () => {
		const tiny = classifierModel("tiny");
		const smol = classifierModel("smol");
		const attempts: Model[] = [];
		const ctx: ClassifierContext = {
			models: { resolve: selector => (selector === "@tiny" ? tiny : smol) },
			modelRegistry: {
				getApiKey: async () => "key",
				resolver: () => (() => "key") as ApiKeyResolver,
			},
		};

		const effort = await classifyPromptEffort("task", baseConfig, ctx, {
			complete: async model => {
				attempts.push(model);
				if (model === tiny) throw new Error("provider unavailable");
				return response("medium");
			},
		});

		expect(effort).toBe("medium");
		expect(attempts).toEqual([tiny, smol]);
	});

	it("falls back past aborted and unparseable first-candidate responses", async () => {
		const tiny = classifierModel("tiny");
		const smol = classifierModel("smol");
		const ctx: ClassifierContext = {
			models: { resolve: selector => (selector === "@tiny" ? tiny : smol) },
			modelRegistry: {
				getApiKey: async () => "key",
				resolver: () => (() => "key") as ApiKeyResolver,
			},
		};

		await expect(
			classifyPromptEffort("first", baseConfig, ctx, {
				complete: async model => (model === tiny ? response("", { stopReason: "aborted" }) : response("low")),
			}),
		).resolves.toBe("low");
		await expect(
			classifyPromptEffort("second", baseConfig, ctx, {
				complete: async model => (model === tiny ? response("I cannot decide") : response("high")),
			}),
		).resolves.toBe("high");
	});

	it("rejects with a useful error retaining the final failure when every candidate fails", async () => {
		const selected = classifierModel("selected");
		const attempts: string[] = [];
		const ctx: ClassifierContext = {
			models: { resolve: () => selected },
			modelRegistry: {
				getApiKey: async () => "key",
				resolver: () => (() => "key") as ApiKeyResolver,
			},
		};
		const providerFailure = new Error("provider unavailable");

		const failure = await classifyPromptEffort("first", baseConfig, ctx, {
			complete: async () => {
				attempts.push("throw");
				throw providerFailure;
			},
		}).then(
			() => {
				throw new Error("expected classification to reject");
			},
			(error: unknown) => error as Error,
		);

		expect(attempts).toEqual(["throw", "throw"]);
		expect(failure.message).toContain("all classifier candidates failed (@tiny, @smol)");
		expect(failure.message).toContain("provider unavailable");
		expect(failure.cause).toBe(providerFailure);

		await expect(
			classifyPromptEffort("second", baseConfig, ctx, {
				complete: async () => response("", { stopReason: "error", errorMessage: "quota exceeded" }),
			}),
		).rejects.toThrow("quota exceeded");
		await expect(
			classifyPromptEffort("third", baseConfig, ctx, {
				complete: async () => response("", { stopReason: "aborted" }),
			}),
		).rejects.toThrow("classifier aborted");
		await expect(
			classifyPromptEffort("fourth", baseConfig, ctx, {
				complete: async () => response("I cannot decide"),
			}),
		).rejects.toThrow("unparseable classifier output");
	});

	it("fails when no configured selector resolves or has authentication", async () => {
		const unauthenticated = classifierModel("unauthenticated");
		const noModels: ClassifierContext = {
			models: { resolve: () => undefined },
			modelRegistry: {
				getApiKey: async () => "unused",
				resolver: () => (() => "unused") as ApiKeyResolver,
			},
		};
		const noKeys: ClassifierContext = {
			models: { resolve: () => unauthenticated },
			modelRegistry: {
				getApiKey: async () => undefined,
				resolver: () => (() => "unused") as ApiKeyResolver,
			},
		};
		const keyLookupThrows: ClassifierContext = {
			models: { resolve: () => unauthenticated },
			modelRegistry: {
				getApiKey: async () => {
					throw new Error("keychain locked");
				},
				resolver: () => (() => "unused") as ApiKeyResolver,
			},
		};

		await expect(classifyPromptEffort("task", baseConfig, noModels)).rejects.toThrow(
			"no authenticated classifier model",
		);
		await expect(classifyPromptEffort("task", baseConfig, noKeys)).rejects.toThrow(
			"no authenticated classifier model",
		);
		await expect(classifyPromptEffort("task", baseConfig, keyLookupThrows)).rejects.toThrow(
			"no authenticated classifier model",
		);
	});

	it("composes caller aborts with the candidate timeout and does not retry after caller cancellation", async () => {
		const selected = classifierModel("selected");
		const timeoutController = new AbortController();
		const callerController = new AbortController();
		callerController.abort(new Error("caller aborted"));
		const seenSignals: AbortSignal[] = [];
		let timeoutRequests = 0;
		let completionAttempts = 0;
		const ctx: ClassifierContext = {
			models: { resolve: () => selected },
			modelRegistry: {
				getApiKey: async (_model, _sessionId, options) => {
					if (options?.signal) seenSignals.push(options.signal);
					return "key";
				},
				resolver: () => (() => "key") as ApiKeyResolver,
			},
			signal: callerController.signal,
		};

		await expect(
			classifyPromptEffort("task", { ...baseConfig, classifierTimeoutMs: 25 }, ctx, {
				timeoutSignal: ms => {
					timeoutRequests += 1;
					expect(ms).toBe(25);
					return timeoutController.signal;
				},
				complete: async (_model, _context, options) => {
					completionAttempts += 1;
					if (options.signal) seenSignals.push(options.signal);
					throw options.signal?.reason;
				},
			}),
		).rejects.toThrow("caller aborted");
		expect(timeoutRequests).toBe(1);
		expect(completionAttempts).toBe(1);
		expect(seenSignals).toHaveLength(2);
		expect(seenSignals[0]).toBe(seenSignals[1]);
		expect(seenSignals[0]?.aborted).toBe(true);
	});

	it("gives each candidate a fresh timeout signal so a timed-out candidate does not poison the next", async () => {
		const tiny = classifierModel("tiny");
		const smol = classifierModel("smol");
		const signals = [AbortSignal.abort(new Error("candidate timed out")), new AbortController().signal];
		const handedSignals: AbortSignal[] = [];
		const ctx: ClassifierContext = {
			models: { resolve: selector => (selector === "@tiny" ? tiny : smol) },
			modelRegistry: {
				getApiKey: async () => "key",
				resolver: () => (() => "key") as ApiKeyResolver,
			},
		};

		const effort = await classifyPromptEffort("task", baseConfig, ctx, {
			timeoutSignal: () => signals[handedSignals.length],
			complete: async (_model, _context, options) => {
				if (options.signal) handedSignals.push(options.signal);
				if (options.signal?.aborted) throw options.signal.reason;
				return response("low");
			},
		});

		expect(effort).toBe("low");
		expect(handedSignals).toHaveLength(2);
		expect(handedSignals[0]).toBe(signals[0]);
		expect(handedSignals[1]).toBe(signals[1]);
		expect(handedSignals[1]?.aborted).toBe(false);
	});
});

describe("parseClassifierEffort", () => {
	it("accepts robust xhigh spellings", () => {
		expect(parseClassifierEffort("xhigh")).toBe("xhigh");
		expect(parseClassifierEffort("X-HIGH")).toBe("xhigh");
		expect(parseClassifierEffort("x_high")).toBe("xhigh");
		expect(parseClassifierEffort("x high")).toBe("xhigh");
	});

	it("returns the earliest valid keyword and rejects unknown output", () => {
		expect(parseClassifierEffort("high, then low")).toBe("high");
		expect(parseClassifierEffort("noise low before max")).toBe("low");
		expect(parseClassifierEffort("med")).toBe("medium");
		expect(parseClassifierEffort("unknown")).toBeUndefined();
	});
});

describe("preprocessClassifierInput", () => {
	it("removes ANSI, paired XML, fenced code, and shortens long hashes", () => {
		const input =
			"\u001b[31mInvestigate failure\u001b[0m <tool>secret output</tool> 54783db3f0f17c74cae81976f0e825a909deb71e\n```ts\nconst noise = true;\n```\nKeep this request.";
		const cleaned = preprocessClassifierInput(input);

		expect(cleaned).toContain("Investigate failure");
		expect(cleaned).toContain("54783db");
		expect(cleaned).toContain("Keep this request.");
		expect(cleaned).not.toContain("\u001b");
		expect(cleaned).not.toContain("secret output");
		expect(cleaned).not.toContain("const noise");
		expect(cleaned).not.toContain("54783db3f0f17c74cae81976f0e825a909deb71e");
	});

	it("preserves both ends while remaining within 2,000 characters", () => {
		const input = `HEAD-${"x".repeat(3_000)}-TAIL`;
		const cleaned = preprocessClassifierInput(input);

		expect(cleaned.length).toBeLessThanOrEqual(CLASSIFIER_MAX_INPUT_CHARS);
		expect(cleaned.startsWith("HEAD-")).toBe(true);
		expect(cleaned.endsWith("-TAIL")).toBe(true);
		expect(cleaned).toContain("chars omitted");
	});

	it("keeps an almost all-code prompt when stripping would erase the request", () => {
		const input = "```ts\nconst answer = 42;\n```";
		expect(preprocessClassifierInput(input)).toBe(input);
	});
});
