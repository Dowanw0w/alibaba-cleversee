import { createCache } from "./cache.mjs";
import { loadConfig, PROVIDER_NAMES, RECENCY_VALUES } from "./config.mjs";
import { MultiAccessError } from "./errors.mjs";
import { createCleverSeeProvider } from "./providers/cleversee.mjs";
import { createRouter } from "./router.mjs";
import { assertFetchableUrl, clamp } from "./util.mjs";

function stringList(value, label) {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value)) throw new MultiAccessError(`${label} must be an array of strings`, { kind: "invalid" });
	const list = value.map((item) => String(item ?? "").trim()).filter(Boolean);
	return list.length > 0 ? list : undefined;
}

function normalizeSearchOptions(options = {}) {
	if (options.recency !== undefined && !RECENCY_VALUES.includes(options.recency)) {
		throw new MultiAccessError(`recency must be one of ${RECENCY_VALUES.join(", ")}`, { kind: "invalid" });
	}
	if (options.provider !== undefined && !PROVIDER_NAMES.includes(options.provider)) {
		throw new MultiAccessError(`provider must be one of ${PROVIDER_NAMES.join(", ")}`, { kind: "invalid" });
	}
	return {
		...options,
		count: clamp(options.count ?? 5, 1, 50),
		includeDomains: stringList(options.includeDomains, "includeDomains"),
		excludeDomains: stringList(options.excludeDomains, "excludeDomains"),
	};
}

function normalizeFetchOptions(options = {}) {
	if (options.provider !== undefined && !PROVIDER_NAMES.includes(options.provider)) {
		throw new MultiAccessError(`provider must be one of ${PROVIDER_NAMES.join(", ")}`, { kind: "invalid" });
	}
	return { ...options };
}

export function createMultiAccess(options = {}) {
	const env = options.env ?? process.env;
	const config = loadConfig(env, {
		engine: options.engine,
		cleverseeKey: options.cleverseeKey,
	});

	const deps = {
		fetchImpl: options.fetchImpl ?? globalThis.fetch,
		now: options.now ?? Date.now,
	};

	const cleversee = createCleverSeeProvider(config.cleversee, deps);

	const providers = {
		cleversee: { ...cleversee, configured: Boolean(config.cleversee.apiKey) },
	};

	const log = options.log ?? (() => {});
	const router = createRouter({
		config,
		providers,
		now: deps.now,
		sleep: options.sleep,
		log,
	});

	const cache = createCache({
		ttlMs: config.cacheTtlMs,
		maxEntries: config.cacheMaxEntries,
		now: deps.now,
	});

	return {
		config,

		async search(query, searchOptions = {}) {
			const text = typeof query === "string" ? query : String(query ?? "");
			if (!text.trim()) throw new MultiAccessError("query must not be empty", { kind: "invalid" });
			return router.search(text, normalizeSearchOptions(searchOptions));
		},

		async fetch(url, fetchOptions = {}) {
			const normalized = normalizeFetchOptions(fetchOptions);
			const safeUrl = assertFetchableUrl(url, { allowPrivate: config.allowPrivate });

			if (!normalized.refresh) {
				const hit = cache.get(safeUrl);
				if (hit) {
					return { ...hit, meta: { ...hit.meta, cached: true } };
				}
			}

			const result = await router.fetch(safeUrl, normalized);
			cache.set(safeUrl, result);
			return result;
		},

		status() {
			return {
				...router.status(),
				cache: { entries: cache.size, ttlSeconds: Math.round(config.cacheTtlMs / 1000) },
				reads: {
					allowPrivate: config.allowPrivate,
					cleverseeEngine: config.engine,
					cleverseeScrape: config.cleversee.scrape,
				},
			};
		},

		clearCache() {
			cache.clear();
		},
	};
}
