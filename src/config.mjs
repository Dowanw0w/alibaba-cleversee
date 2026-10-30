import { MultiAccessError } from "./errors.mjs";

// CleverSee 引擎档位与能力（价格单位：元/千次，仅用于估算与展示）。
export const ENGINES = Object.freeze({
	CNLiteBasic: { label: "国内极速版", maxResults: 50, siteFilters: true, pricePer1kCny: 8 },
	CNAuto: { label: "国内智能版", maxResults: 10, siteFilters: false, pricePer1kCny: 18 },
	LiteAdvanced: { label: "极速版（旧规格）", maxResults: 50, siteFilters: true, pricePer1kCny: 12 },
	Generic: { label: "通用标准版", maxResults: 10, siteFilters: false, pricePer1kCny: 42 },
	GenericAdvanced: { label: "通用增强版", maxResults: 80, siteFilters: false, pricePer1kCny: 44.8 },
	GlobalAdvanced: { label: "国际版", maxResults: 20, siteFilters: true, pricePer1kCny: 56 },
	Deep: { label: "深度版", maxResults: 10, siteFilters: false, pricePer1kCny: null },
});

// 唯一上游；保留数组形态以兼容路由与 status 输出。
export const PROVIDER_NAMES = Object.freeze(["cleversee"]);
export const RECENCY_VALUES = ["day", "week", "month", "year"];

// 单次调用估算成本（元）。
export const COST_CNY = Object.freeze({
	cleverseeReadPageBasic: 0.002,
	cleverseeReadPageScrape: 0.01,
});

function readBool(env, name, fallback = false) {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	return raw === "1" || String(raw).toLowerCase() === "true" || String(raw).toLowerCase() === "yes";
}

function readInt(env, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new MultiAccessError(`${name} must be an integer in [${min}, ${max}], got ${JSON.stringify(raw)}`, { kind: "config" });
	}
	return value;
}

export function loadConfig(env = process.env, overrides = {}) {
	const engine = overrides.engine ?? env.MULTI_ACCESS_ENGINE ?? "CNLiteBasic";
	if (!ENGINES[engine]) {
		throw new MultiAccessError(`unknown CleverSee engine "${engine}" (allowed: ${Object.keys(ENGINES).join(", ")})`, { kind: "config" });
	}

	return {
		providerOrder: [...PROVIDER_NAMES],
		engine,
		engineInfo: ENGINES[engine],
		allowPrivate: readBool(env, "MULTI_ACCESS_ALLOW_PRIVATE", false),
		debug: readBool(env, "MULTI_ACCESS_DEBUG", false),
		cacheTtlMs: readInt(env, "MULTI_ACCESS_CACHE_TTL", 600, { min: 0, max: 86_400 }) * 1000,
		cacheMaxEntries: readInt(env, "MULTI_ACCESS_CACHE_MAX", 100, { min: 1, max: 5_000 }),
		limiterMaxWaitMs: readInt(env, "MULTI_ACCESS_LIMITER_MAX_WAIT_MS", 1_500, { min: 0, max: 30_000 }),
		breakerThreshold: readInt(env, "MULTI_ACCESS_BREAKER_THRESHOLD", 3, { min: 1, max: 100 }),
		breakerCooldownMs: readInt(env, "MULTI_ACCESS_BREAKER_COOLDOWN_MS", 120_000, { min: 1_000, max: 3_600_000 }),
		cleversee: {
			apiKey: overrides.cleverseeKey ?? env.CLEVERSEE_API_KEY ?? "",
			baseUrl: String(env.CLEVERSEE_BASE_URL || "https://cloud-iqs.aliyuncs.com").replace(/\/+$/, ""),
			engine,
			searchTimeoutMs: readInt(env, "MULTI_ACCESS_CLEVERSEE_SEARCH_TIMEOUT_MS", 15_000, { min: 1_000, max: 120_000 }),
			readPageTimeoutMs: readInt(env, "MULTI_ACCESS_CLEVERSEE_READPAGE_TIMEOUT_MS", 15_000, { min: 1_000, max: 120_000 }),
			scrapeTimeoutMs: readInt(env, "MULTI_ACCESS_CLEVERSEE_SCRAPE_TIMEOUT_MS", 30_000, { min: 1_000, max: 120_000 }),
			qps: readInt(env, "MULTI_ACCESS_CLEVERSEE_QPS", 10, { min: 1, max: 100 }),
			readPageQps: readInt(env, "MULTI_ACCESS_CLEVERSEE_READPAGE_QPS", 5, { min: 1, max: 100 }),
			summary: readBool(env, "MULTI_ACCESS_CLEVERSEE_SUMMARY", false),
			readPageMaxAge: readInt(env, "MULTI_ACCESS_CLEVERSEE_READPAGE_MAX_AGE", 0, { min: 0, max: 2_592_000 }),
			scrape: readBool(env, "MULTI_ACCESS_CLEVERSEE_SCRAPE", false),
		},
	};
}
