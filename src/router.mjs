import { COST_CNY, ENGINES } from "./config.mjs";
import { isFailoverKind, MultiAccessError, safeErrorMessage } from "./errors.mjs";
import { createBreaker, createLimiter } from "./guard.mjs";
import { defaultSleep } from "./util.mjs";

// 熔断只反映 provider 自身健康。目标网页的 404/403/反爬（target）与按设计
// 改走 CleverSee 的超长 query（query-too-long）都不是 provider 故障；若计入，
// 几个死链就能把兜底 provider 一起熔断，导致可抓取的页面被跳过。
const BREAKER_FAILURE_KINDS = new Set(["auth", "payment", "rate", "transient", "network", "invalid-response"]);

function countsTowardBreaker(kind) {
	return BREAKER_FAILURE_KINDS.has(kind);
}

function estimatedCostCny(provider, capability, result) {
	if (provider === "deepseek") return capability === "search" ? COST_CNY.deepseekSearch : COST_CNY.deepseekFetch;
	if (provider === "cleversee") {
		if (capability === "search") {
			const engine = result?.engine ?? "CNLiteBasic";
			return (ENGINES[engine]?.pricePer1kCny ?? 8) / 1000;
		}
		return result?.mode === "scrape" ? COST_CNY.cleverseeReadPageScrape : COST_CNY.cleverseeReadPageBasic;
	}
	return 0;
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
			const qps =
				provider === "deepseek"
					? config.deepseek.qps
					: capability === "search"
						? config.cleversee.qps
						: config.cleversee.readPageQps;
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
				throw new MultiAccessError(`unknown provider "${options.provider}"`, { kind: "config" });
			}
			if (!providers[options.provider].configured) {
				throw new MultiAccessError(`provider "${options.provider}" is not configured`, { kind: "no-provider" });
			}
			return [options.provider];
		}
		const order = config.providerOrder.filter((name) => providers[name]?.configured);
		if (order.length === 0) {
			throw new MultiAccessError(
				"no provider configured: set DEEPSEEK_SEARCH_API_KEY and/or CLEVERSEE_API_KEY",
				{ kind: "no-provider" },
			);
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

	async function runSearch(query, options) {
		const order = resolveOrder(options);
		const attempts = [];
		let degraded = false;
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
						degraded,
						warnings: result.warnings ?? [],
						estimatedCostCny: estimatedCostCny(name, "search", result),
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
				if (kind === "config" || kind === "no-provider") throw error;
				if (kind === "auth") {
					degraded = true;
					if (config.strictAuth) throw error;
				}
				if (!isFailoverKind(kind)) throw error;
			}
		}

		const kind = lastError?.kind ?? "empty";
		throw new MultiAccessError(
			`no provider returned results (${attemptsSummary(attempts) || "all skipped"})`,
			{ kind, provider: null, attempts },
		);
	}

	async function runFetch(url, options) {
		const order = resolveOrder(options);
		const attempts = [];
		let degraded = false;
		let lastError = null;

		for (const name of order) {
			const provider = providers[name];
			const scrapeEnabled = options.scrape ?? config.cleversee.scrape;
			const modes = name === "cleversee" ? ["basic", ...(scrapeEnabled ? ["scrape"] : [])] : [null];

			for (const mode of modes) {
				const breaker = getBreaker(name, "fetch", mode);
				if (!breaker.canAttempt(now())) {
					attempts.push({ provider: name, capability: "fetch", mode, outcome: "circuit-open" });
					count(name, "fetch", "skipped");
					continue;
				}

				const started = now();
				try {
					await getLimiter(name, "fetch", mode).acquire();
					const result = await provider.fetchPage(url, { ...options, mode: mode ?? options.mode });
					const ms = now() - started;

					if (!result.content) {
						attempts.push({ provider: name, capability: "fetch", mode, outcome: "empty", ms });
						count(name, "fetch", "empty");
						continue;
					}

					breaker.recordSuccess();
					count(name, "fetch", "ok");
					log({ provider: name, capability: "fetch", mode, outcome: "ok", ms, chars: result.content.length });
					return {
						...result,
						meta: {
							...result.meta,
							provider: name,
							capability: "fetch",
							attempts: [...attempts, { provider: name, capability: "fetch", mode, outcome: "ok", ms }],
							degraded,
							estimatedCostCny: estimatedCostCny(name, "fetch", result),
						},
					};
				} catch (error) {
					const ms = now() - started;
					const kind = error?.kind ?? "transient";
					if (kind === "aborted") throw error;
					attempts.push({ provider: name, capability: "fetch", mode, outcome: "error", kind, status: error?.status ?? null, message: safeErrorMessage(error), ms });
					count(name, "fetch", "error");
					log({ provider: name, capability: "fetch", mode, outcome: "error", kind, status: error?.status ?? null, ms });
					if (countsTowardBreaker(kind)) breaker.recordFailure(now());
					lastError = error;
					if (kind === "config" || kind === "no-provider") throw error;
					if (kind === "auth") {
						degraded = true;
						if (config.strictAuth) throw error;
					}
					if (!isFailoverKind(kind)) throw error;
				}
			}
		}

		const kind = lastError?.kind ?? "empty";
		throw new MultiAccessError(
			`unable to fetch page through any provider (${attemptsSummary(attempts) || "all skipped"})`,
			{ kind, provider: null, attempts },
		);
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
				strictAuth: config.strictAuth,
			};
		},
	};
}
