import { CleverSeeError } from "./errors.mjs";

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
		throw new CleverSeeError(`${name} must be an integer in [${min}, ${max}], got ${JSON.stringify(raw)}`, { kind: "config" });
	}
	return value;
}

export function loadConfig(env = process.env, overrides = {}) {
	const engine = overrides.engine ?? env.CLEVERSEE_ENGINE ?? "CNLiteBasic";
	if (!ENGINES[engine]) {
		throw new CleverSeeError(`unknown CleverSee engine "${engine}" (allowed: ${Object.keys(ENGINES).join(", ")})`, { kind: "config" });
	}

	// 上游 ReadPage 的单页渲染预算，与本地 HTTP 超时解耦：慢站（实测 6.7~18.5s）
	// 会稳定超过 10s 并让上游以 statusCode=408 返回，故默认放到 20s。
	const pageTimeoutMs = readInt(env, "CLEVERSEE_PAGE_TIMEOUT_MS", 20_000, { min: 1_000, max: 120_000 });

	return {
		providerOrder: [...PROVIDER_NAMES],
		engine,
		engineInfo: ENGINES[engine],
		allowPrivate: readBool(env, "CLEVERSEE_ALLOW_PRIVATE", false),
		debug: readBool(env, "CLEVERSEE_DEBUG", false),
		cacheTtlMs: readInt(env, "CLEVERSEE_CACHE_TTL", 600, { min: 0, max: 86_400 }) * 1000,
		cacheMaxEntries: readInt(env, "CLEVERSEE_CACHE_MAX", 100, { min: 1, max: 5_000 }),
		limiterMaxWaitMs: readInt(env, "CLEVERSEE_LIMITER_MAX_WAIT_MS", 1_500, { min: 0, max: 30_000 }),
		breakerThreshold: readInt(env, "CLEVERSEE_BREAKER_THRESHOLD", 3, { min: 1, max: 100 }),
		breakerCooldownMs: readInt(env, "CLEVERSEE_BREAKER_COOLDOWN_MS", 120_000, { min: 1_000, max: 3_600_000 }),
		cleversee: {
			apiKey: overrides.cleverseeKey ?? env.CLEVERSEE_API_KEY ?? "",
			baseUrl: String(env.CLEVERSEE_BASE_URL || "https://cloud-iqs.aliyuncs.com").replace(/\/+$/, ""),
			engine,
			searchTimeoutMs: readInt(env, "CLEVERSEE_SEARCH_TIMEOUT_MS", 15_000, { min: 1_000, max: 120_000 }),
			pageTimeoutMs,
			// 本地 HTTP 超时必须大于上游渲染预算，否则会先把请求打断成 network 错误。
			readPageTimeoutMs: readInt(env, "CLEVERSEE_READPAGE_TIMEOUT_MS", pageTimeoutMs + 5_000, { min: 1_000, max: 180_000 }),
			scrapeTimeoutMs: readInt(env, "CLEVERSEE_SCRAPE_TIMEOUT_MS", Math.max(30_000, pageTimeoutMs + 10_000), { min: 1_000, max: 180_000 }),
			fetchRetries: readInt(env, "CLEVERSEE_FETCH_RETRIES", 1, { min: 0, max: 3 }),
			fetchRetryBackoffMs: readInt(env, "CLEVERSEE_FETCH_RETRY_BACKOFF_MS", 400, { min: 0, max: 5_000 }),
			qps: readInt(env, "CLEVERSEE_QPS", 10, { min: 1, max: 100 }),
			readPageQps: readInt(env, "CLEVERSEE_READPAGE_QPS", 5, { min: 1, max: 100 }),
			summary: readBool(env, "CLEVERSEE_SUMMARY", false),
			readPageMaxAge: readInt(env, "CLEVERSEE_READPAGE_MAX_AGE", 0, { min: 0, max: 2_592_000 }),
			scrape: readBool(env, "CLEVERSEE_SCRAPE", false),
		},
	};
}
