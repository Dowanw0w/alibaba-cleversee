import { COST_CNY, ENGINES } from "./config.mjs";
import { isFailoverKind, CleverSeeError, safeErrorMessage } from "./errors.mjs";
import { createBreaker, createLimiter } from "./guard.mjs";
import { defaultSleep } from "./util.mjs";

// 熔断只反映上游自身健康。目标网页的 404/403/反爬（target）、本地限速排队超时
// （local-throttle）与参数校验（invalid）都不是上游故障；若计入，几条死链或一波
// 并发就能把 provider 熔断，导致本可成功的请求被跳过。
const BREAKER_FAILURE_KINDS = new Set(["auth", "payment", "rate", "transient", "network", "invalid-response"]);

// 同档重试只针对「上游/网络瞬时故障」。目标站 403/404 与反爬页重试无意义。
const RETRYABLE_KINDS = new Set(["transient", "network"]);

function countsTowardBreaker(kind) {
	return BREAKER_FAILURE_KINDS.has(kind);
}

function estimatedCostCny(capability, result) {
	if (capability === "search") {
		const engine = result?.engine ?? "CNLiteBasic";
		return (ENGINES[engine]?.pricePer1kCny ?? 8) / 1000;
	}
	return result?.mode === "scrape" ? COST_CNY.cleverseeReadPageScrape : COST_CNY.cleverseeReadPageBasic;
}

export function createRouter({ config, providers, now = Date.now, sleep = defaultSleep, log = () => {} } = {}) {
	const breakers = new Map();
	const limiters = new Map();
	const counters = new Map();

	function breakerKey(provider, capability, mode = "") {
		return `${provider}:${capability}${mode ? `:${mode}` : ""}`;
	}

	function getBreaker(provider, capability, mode) {
		const key = breakerKey(provider, capability, mode);
		if (!breakers.has(key)) {
			breakers.set(key, createBreaker({ threshold: config.breakerThreshold, cooldownMs: config.breakerCooldownMs }));
		}
		return breakers.get(key);
	}

	function getLimiter(provider, capability, mode) {
		const key = breakerKey(provider, capability, mode);
		if (!limiters.has(key)) {
			const qps = capability === "search" ? config.cleversee.qps : config.cleversee.readPageQps;
			limiters.set(key, createLimiter({ qps, maxWaitMs: config.limiterMaxWaitMs, now, sleep }));
		}
		return limiters.get(key);
	}

	function count(provider, capability, outcome) {
		const key = breakerKey(provider, capability);
		const entry = counters.get(key) ?? { ok: 0, error: 0, empty: 0, skipped: 0, lastOutcome: null, lastAt: null };
		entry[outcome] = (entry[outcome] ?? 0) + 1;
		entry.lastOutcome = outcome;
		entry.lastAt = now();
		counters.set(key, entry);
	}

	function resolveOrder(options) {
		if (options.provider) {
			if (!providers[options.provider]) {
				throw new CleverSeeError(`unknown provider "${options.provider}"`, { kind: "config" });
			}
			if (!providers[options.provider].configured) {
				throw new CleverSeeError(`provider "${options.provider}" is not configured`, { kind: "no-provider" });
			}
			return [options.provider];
		}
		const order = config.providerOrder.filter((name) => providers[name]?.configured);
		if (order.length === 0) {
			throw new CleverSeeError("no provider configured: set CLEVERSEE_API_KEY", { kind: "no-provider" });
		}
		return order;
	}

	function attemptsSummary(attempts) {
		return attempts
			.map((attempt) => {
				const detail = attempt.outcome === "ok" ? "ok" : attempt.kind ?? attempt.outcome;
				return `${attempt.provider}${attempt.mode ? `/${attempt.mode}` : ""}=${detail}`;
			})
			.join(", ");
	}

	// 单上游时不造聚合文案：保留最后一次失败的 kind/status/code，并附完整 attempts。
	function terminalError(lastError, attempts, message) {
		if (lastError) {
			return new CleverSeeError(safeErrorMessage(lastError), {
				kind: lastError.kind ?? "unknown",
				provider: lastError.provider ?? null,
				status: lastError.status ?? 0,
				code: lastError.code ?? null,
				attempts,
				cause: lastError,
			});
		}
		// 没有任何实际调用（全部被熔断跳过）不应被说成「空结果」。
		const allSkipped = attempts.length > 0 && attempts.every((attempt) => attempt.outcome === "circuit-open");
		return new CleverSeeError(`${message} (${attemptsSummary(attempts) || "all skipped"})`, {
			kind: allSkipped ? "circuit-open" : "empty",
			attempts,
		});
	}

	async function runSearch(query, options) {
		const order = resolveOrder(options);
		const attempts = [];
		let lastError = null;

		for (const name of order) {
			const provider = providers[name];
			const breaker = getBreaker(name, "search");
			if (!breaker.canAttempt(now())) {
				attempts.push({ provider: name, capability: "search", outcome: "circuit-open" });
				count(name, "search", "skipped");
				continue;
			}

			const started = now();
			try {
				await getLimiter(name, "search").acquire();
				const result = await provider.search(query, options);
				const ms = now() - started;

				if (result.results.length === 0) {
					attempts.push({ provider: name, capability: "search", outcome: "empty", ms });
					count(name, "search", "empty");
					log({ provider: name, capability: "search", outcome: "empty", ms });
					continue;
				}

				breaker.recordSuccess();
				count(name, "search", "ok");
				log({ provider: name, capability: "search", outcome: "ok", ms, results: result.results.length });
				return {
					...result,
					meta: {
						...result.meta,
						provider: name,
						capability: "search",
						attempts: [...attempts, { provider: name, capability: "search", outcome: "ok", ms }],
						warnings: result.warnings ?? [],
						estimatedCostCny: estimatedCostCny("search", result),
					},
				};
			} catch (error) {
				const ms = now() - started;
				const kind = error?.kind ?? "transient";
				if (kind === "aborted") throw error;
				attempts.push({ provider: name, capability: "search", outcome: "error", kind, status: error?.status ?? null, message: safeErrorMessage(error), ms });
				count(name, "search", "error");
				log({ provider: name, capability: "search", outcome: "error", kind, status: error?.status ?? null, ms });
				if (countsTowardBreaker(kind)) breaker.recordFailure(now());
				lastError = error;
				if (!isFailoverKind(kind)) throw error;
			}
		}

		throw terminalError(lastError, attempts, "search returned no results");
	}

	async function runFetch(url, options) {
		const order = resolveOrder(options);
		const attempts = [];
		let lastError = null;

		for (const name of order) {
			const provider = providers[name];
			const scrapeEnabled = options.scrape ?? config.cleversee.scrape;
			const modes = name === "cleversee" ? ["basic", ...(scrapeEnabled ? ["scrape"] : [])] : [null];
			const maxTries = 1 + Math.max(0, config.cleversee.fetchRetries ?? 0);

			for (const mode of modes) {
				const breaker = getBreaker(name, "fetch", mode);

				for (let attempt = 1; attempt <= maxTries; attempt += 1) {
					if (!breaker.canAttempt(now())) {
						attempts.push({ provider: name, capability: "fetch", mode, outcome: "circuit-open" });
						count(name, "fetch", "skipped");
						break;
					}

					const started = now();
					try {
						await getLimiter(name, "fetch", mode).acquire();
						const result = await provider.fetchPage(url, { ...options, mode: mode ?? options.mode });
						const ms = now() - started;

						if (!result.content) {
							attempts.push({ provider: name, capability: "fetch", mode, outcome: "empty", ms, attempt });
							count(name, "fetch", "empty");
							break;
						}

						breaker.recordSuccess();
						count(name, "fetch", "ok");
						log({ provider: name, capability: "fetch", mode, outcome: "ok", ms, attempt, chars: result.content.length });
						return {
							...result,
							meta: {
								...result.meta,
								provider: name,
								capability: "fetch",
								attempts: [...attempts, { provider: name, capability: "fetch", mode, outcome: "ok", ms, attempt }],
								estimatedCostCny: estimatedCostCny("fetch", result),
							},
						};
					} catch (error) {
						const ms = now() - started;
						const kind = error?.kind ?? "transient";
						if (kind === "aborted") throw error;
						attempts.push({
							provider: name,
							capability: "fetch",
							mode,
							outcome: "error",
							kind,
							status: error?.status ?? null,
							message: safeErrorMessage(error),
							ms,
							attempt,
						});
						count(name, "fetch", "error");
						log({ provider: name, capability: "fetch", mode, outcome: "error", kind, status: error?.status ?? null, ms, attempt });
						if (countsTowardBreaker(kind)) breaker.recordFailure(now());
						lastError = error;

						if (RETRYABLE_KINDS.has(kind) && attempt < maxTries) {
							const backoff = Math.max(0, config.cleversee.fetchRetryBackoffMs ?? 0) * attempt;
							if (backoff > 0) await sleep(backoff);
							continue;
						}
						if (!isFailoverKind(kind)) throw error;
						break;
					}
				}
			}
		}

		throw terminalError(lastError, attempts, "unable to fetch page");
	}

	return {
		search: runSearch,
		fetch: runFetch,
		status() {
			const at = now();
			const circuits = [];
			for (const [key, breaker] of breakers) {
				const [provider, capability, mode] = key.split(":");
				circuits.push({ provider, capability, ...(mode ? { mode } : {}), ...breaker.state(at) });
			}
			return {
				order: config.providerOrder,
				engine: config.engine,
				providers: Object.fromEntries(Object.entries(providers).map(([name, provider]) => [name, { configured: Boolean(provider.configured) }])),
				circuits,
				counters: Object.fromEntries(counters),
			};
		},
	};
}
