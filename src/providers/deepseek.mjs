import { MultiAccessError } from "../errors.mjs";
import { requestJson } from "../http.mjs";
import { clamp, dedupe, isoDaysAgo, normalizeDomain, textBlock, textOneLine } from "../util.mjs";

export const DEEPSEEK_MAX_QUERY_CHARS = 128;

const RECENCY_DAYS = Object.freeze({ day: 1, week: 7, month: 30, year: 365 });

// DeepSeek 只接受 query 级语法，没有结构化过滤参数，这里把 include/exclude/recency 拼成操作符。
export function buildDeepSeekQuery(query, options = {}) {
	const base = String(query ?? "").trim();
	if (!base) {
		throw new MultiAccessError("query must not be empty", { kind: "invalid", provider: "deepseek" });
	}

	const parts = [base];
	const include = dedupe((options.includeDomains ?? []).map(normalizeDomain).filter(Boolean));
	const exclude = dedupe((options.excludeDomains ?? []).map(normalizeDomain).filter(Boolean));

	if (include.length > 0) parts.push(include.map((domain) => `site:${domain}`).join(" OR "));
	for (const domain of exclude) parts.push(`-site:${domain}`);

	if (options.recency) {
		const days = RECENCY_DAYS[options.recency];
		if (!days) {
			throw new MultiAccessError(`unsupported recency "${options.recency}" (allowed: day, week, month, year)`, { kind: "invalid", provider: "deepseek" });
		}
		parts.push(`after:${isoDaysAgo(days, options.now ?? Date.now())}`);
	}

	const built = parts.join(" ");
	const length = [...built].length;
	if (length > DEEPSEEK_MAX_QUERY_CHARS) {
		throw new MultiAccessError(
			`query becomes ${length} characters after domain/date operators; DeepSeek accepts at most ${DEEPSEEK_MAX_QUERY_CHARS}`,
			{ kind: "query-too-long", provider: "deepseek" },
		);
	}
	return built;
}

function mapResult(item) {
	if (!item || typeof item !== "object") return null;
	if (typeof item.url !== "string" || !item.url) return null;
	let url;
	try {
		url = new URL(item.url);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;

	return {
		title: textOneLine(item.title) || url.href,
		url: url.href,
		snippet: textOneLine(item.snippet),
		summary: textOneLine(item.summary),
		content: textBlock(item.content),
		publishedAt: typeof item.date === "string" && item.date ? item.date : null,
		siteName: typeof item.site_name === "string" && item.site_name ? item.site_name : null,
		siteIcon: typeof item.site_icon === "string" && item.site_icon ? item.site_icon : null,
		score: typeof item.rerank_score === "number" ? item.rerank_score : null,
		authority: Number.isInteger(item.authority) ? item.authority : null,
		provider: "deepseek",
	};
}

function classifyHttp(res) {
	const message = textOneLine(res.data?.error?.message) || textOneLine(res.raw).slice(0, 240) || `HTTP ${res.status}`;
	const status = res.status;
	const kind =
		status === 401
			? "auth"
			: status === 402
				? "payment"
				: status === 429
					? "rate"
					: status === 408 || status >= 500
						? "transient"
						: status === 403 || status === 404
							? "target"
							: "invalid";
	return new MultiAccessError(`DeepSeek HTTP ${status}: ${message}`, { kind, provider: "deepseek", status });
}

export function createDeepSeekProvider(config, deps = {}) {
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
	const now = deps.now ?? Date.now;

	const headers = () => ({ Authorization: `Bearer ${config.apiKey}` });

	return {
		name: "deepseek",

		async search(query, options = {}) {
			const built = buildDeepSeekQuery(query, {
				includeDomains: options.includeDomains,
				excludeDomains: options.excludeDomains,
				recency: options.recency,
				now: now(),
			});

			const body = {
				query: built,
				count: clamp(options.count ?? 10, 1, 50),
				need_content: Boolean(options.needContent),
			};
			if (options.oriQuestion) body.ori_question = String(options.oriQuestion).slice(0, 128);
			if (options.localization) body.localization = String(options.localization);

			const res = await requestJson(`${config.baseUrl}/v1/tools/search`, {
				method: "POST",
				headers: headers(),
				body,
				timeoutMs: options.timeoutMs ?? config.searchTimeoutMs,
				signal: options.signal,
				fetchImpl,
				secret: config.apiKey,
			});

			if (res.status !== 200) throw classifyHttp(res);
			const list = Array.isArray(res.data?.results) ? res.data.results : null;
			if (!list) {
				throw new MultiAccessError("DeepSeek returned an invalid response: missing results array", {
					kind: "invalid-response",
					provider: "deepseek",
					status: res.status,
				});
			}

			const seen = new Set();
			const results = [];
			for (const item of list) {
				const mapped = mapResult(item);
				if (!mapped || seen.has(mapped.url)) continue;
				seen.add(mapped.url);
				results.push(mapped);
			}

			return {
				provider: "deepseek",
				results,
				meta: {
					queryLength: [...built].length,
					rawCount: list.length,
					queryHasOperators: built !== String(query ?? "").trim(),
				},
			};
		},

		async fetchPage(url, options = {}) {
			const res = await requestJson(`${config.baseUrl}/v1/tools/fetch`, {
				method: "POST",
				headers: headers(),
				body: { url },
				timeoutMs: options.timeoutMs ?? config.fetchTimeoutMs,
				signal: options.signal,
				fetchImpl,
				secret: config.apiKey,
			});

			if (res.status !== 200) throw classifyHttp(res);

			const title = textOneLine(res.data?.title);
			const content = textBlock(res.data?.content);
			if (!content) {
				throw new MultiAccessError("DeepSeek fetch returned no usable page content", {
					kind: "target",
					provider: "deepseek",
					status: res.status,
				});
			}

			return {
				provider: "deepseek",
				mode: "fetch",
				url,
				title,
				content,
				meta: {},
			};
		},
	};
}
