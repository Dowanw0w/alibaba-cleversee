import { ENGINES } from "../config.mjs";
import { CleverSeeError } from "../errors.mjs";
import { requestJson } from "../http.mjs";
import { dedupe, isoDaysAgo, normalizeDomain, textBlock, textOneLine } from "../util.mjs";

const TIME_RANGE = Object.freeze({ day: "OneDay", week: "OneWeek", month: "OneMonth", year: "OneYear" });
const RECENCY_DAYS = Object.freeze({ day: 1, week: 7, month: 30, year: 365 });

export function buildCleverSeeSearchBody(query, options = {}) {
	const text = String(query ?? "").trim();
	if (!text) {
		throw new CleverSeeError("query must not be empty", { kind: "invalid", provider: "cleversee" });
	}

	const engine = options.engine ?? "CNLiteBasic";
	const info = ENGINES[engine];
	if (!info) {
		throw new CleverSeeError(`unknown CleverSee engine "${engine}"`, { kind: "config", provider: "cleversee" });
	}

	const warnings = [];
	const advanced = {};
	const requested = Number.isFinite(Number(options.count)) ? Math.max(1, Math.trunc(Number(options.count))) : 10;
	const limit = Math.min(info.maxResults, 50);
	const numResults = Math.min(requested, limit);
	if (numResults < requested) {
		warnings.push(`numResults capped to engine limit ${limit}`);
	}
	advanced.numResults = String(numResults);

	const include = dedupe((options.includeDomains ?? []).map(normalizeDomain).filter(Boolean));
	const exclude = dedupe((options.excludeDomains ?? []).map(normalizeDomain).filter(Boolean));
	if (include.length > 0 || exclude.length > 0) {
		if (info.siteFilters) {
			if (include.length > 0) advanced.includeSites = include.join(",");
			if (exclude.length > 0) advanced.excludeSites = exclude.join(",");
		} else {
			warnings.push(`engine ${engine} does not support site filters; include/exclude domains were ignored`);
		}
	}

	const body = { query: text, engineType: engine };

	if (options.recency) {
		if (engine === "GlobalAdvanced") {
			const days = RECENCY_DAYS[options.recency];
			if (!days) throw new CleverSeeError(`unsupported recency "${options.recency}"`, { kind: "invalid", provider: "cleversee" });
			const at = options.now ?? Date.now();
			advanced.startPublishedDate = isoDaysAgo(days, at);
			advanced.endPublishedDate = isoDaysAgo(0, at);
		} else {
			const range = TIME_RANGE[options.recency];
			if (!range) throw new CleverSeeError(`unsupported recency "${options.recency}"`, { kind: "invalid", provider: "cleversee" });
			body.timeRange = range;
		}
	}
	if (options.category) body.category = String(options.category);

	body.advancedParams = advanced;
	body.contents = { rerankScore: true };
	if (options.needContent) body.contents.mainText = true;
	if (options.summary) body.contents.summary = true;

	return { body, engine, warnings };
}

function mapResult(item) {
	if (!item || typeof item !== "object") return null;
	const rawUrl = typeof item.link === "string" ? item.link : "";
	if (!rawUrl) return null;
	let url;
	try {
		url = new URL(rawUrl);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;

	return {
		title: textOneLine(item.title) || url.href,
		url: url.href,
		snippet: textOneLine(item.snippet),
		summary: textOneLine(item.summary),
		content: textBlock(item.mainText) || textBlock(item.markdownText),
		publishedAt: typeof item.publishedTime === "string" && item.publishedTime ? item.publishedTime : null,
		siteName: typeof item.hostname === "string" && item.hostname ? item.hostname : null,
		siteIcon: typeof item.hostLogo === "string" && item.hostLogo ? item.hostLogo : null,
		score: typeof item.rerankScore === "number" ? item.rerankScore : null,
		authority: Number.isInteger(item.websiteAuthorityScore) ? item.websiteAuthorityScore : null,
		hostAuthorityScore: typeof item.hostAuthorityScore === "number" ? item.hostAuthorityScore : null,
		tags: item.tags && typeof item.tags === "object" ? item.tags : null,
		provider: "cleversee",
	};
}

function classifyHttp(res) {
	const errorCode = textOneLine(res.data?.errorCode) || textOneLine(res.data?.code);
	const message = textOneLine(res.data?.errorMessage) || textOneLine(res.data?.message) || textOneLine(res.raw).slice(0, 240) || `HTTP ${res.status}`;
	const status = res.status;
	let kind;
	if (status === 401) kind = "auth";
	else if (status === 429) kind = "rate";
	else if (status >= 500) kind = "transient";
	else if (status === 403) kind = /NotActivate|NotAuthorised|InvalidAccessKey/i.test(errorCode) ? "auth" : "target";
	else if (status === 400) kind = "invalid";
	else kind = "invalid";
	return new CleverSeeError(`CleverSee HTTP ${status}${errorCode ? ` [${errorCode}]` : ""}: ${message}`, {
		kind,
		provider: "cleversee",
		status,
		code: errorCode || null,
	});
}

const READPAGE_ERROR_KINDS = [
	[/^Retrieval\.NotActivate$|^Retrieval\.NotAuthorised$/i, "auth"],
	[/^ReadPage\.SecurityRestrict$/i, "target"],
	[/^ReadPage\.RequestTimeout$/i, "transient"],
	[/^ReadPage\.RateLimitByDomain$|^Retrieval\.Throttling|^Retrieval\.TestUserQueryPerDayExceeded/i, "rate"],
	[/^ReadPage\.UnknownError$/i, "transient"],
];

function readPageError(code, message, status) {
	let kind = "target";
	for (const [pattern, mapped] of READPAGE_ERROR_KINDS) {
		if (pattern.test(code)) {
			kind = mapped;
			break;
		}
	}
	return new CleverSeeError(`CleverSee ReadPage ${code ? `[${code}] ` : ""}${message}`.trim(), {
		kind,
		provider: "cleversee",
		status,
		code: code || null,
	});
}

// 上游 ReadPage 把「目标页渲染超时」也放进 data.statusCode（实测 408），
// 与目标站点真实返回的 408 无法区分；两者都应由同档重试消化，而不是判成
// target（那样既不重试也不计入熔断，还会把责任错归给目标站）。
// 历史代码里的 4080/4290 属于同一套内部码，一并保留。
const TARGET_STATUS_KINDS = new Map([
	[408, "transient"],
	[4080, "transient"],
	[429, "rate"],
	[4290, "rate"],
]);

function isServerStatus(statusCode) {
	return (statusCode >= 500 && statusCode < 600) || (statusCode >= 5000 && statusCode < 6000);
}

function targetStatusKind(statusCode) {
	const mapped = TARGET_STATUS_KINDS.get(statusCode);
	if (mapped) return mapped;
	return isServerStatus(statusCode) ? "transient" : "target";
}

// 反爬中间页以 HTTP 200 返回（实测掘金 14 字符 "Please wait..."），
// 若不识别会被当成功返回，静默污染下游。
const CHALLENGE_MARKERS = [
	/please wait/i,
	/just a moment/i,
	/enable javascript/i,
	/checking your browser/i,
	/verify you are (a )?human/i,
	/cf-browser-verification|cf_chl_opt|challenge-platform|attention required/i,
	/安全验证|人机验证|正在验证|滑动验证|请稍候|访问过于频繁/,
];

const MIN_USABLE_CHARS = 80;

export function challengeReason(content, title) {
	const head = `${title}\n${content.slice(0, 600)}`;
	if (CHALLENGE_MARKERS.some((pattern) => pattern.test(head))) return "anti-bot interstitial";
	// 无标题且几乎无正文：保守判为中间页（有标题的短页面仍按正常结果返回）。
	if (!title && content.length < MIN_USABLE_CHARS) return "too little text and no title";
	return null;
}

function redirectTarget(requested, metadata) {
	// redirectedUrl 是上游实际落地的 URL（301/302 后）；metadata.url 可能是请求本身。
	const finalUrl = textOneLine(metadata?.redirectedUrl) || textOneLine(metadata?.url);
	if (!finalUrl) return null;
	try {
		const from = new URL(requested);
		const to = new URL(finalUrl);
		const trim = (path) => path.replace(/\/+$/, "");
		const host = (value) => value.toLowerCase().replace(/^www\./, "");
		if (host(from.hostname) === host(to.hostname) && trim(from.pathname) === trim(to.pathname)) return null;
		return to.href;
	} catch {
		return null;
	}
}

export function createCleverSeeProvider(config, deps = {}) {
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
	const now = deps.now ?? Date.now;

	const headers = () => ({ Authorization: `Bearer ${config.apiKey}` });

	return {
		name: "cleversee",

		async search(query, options = {}) {
			const { body, engine, warnings } = buildCleverSeeSearchBody(query, {
				engine: options.engine ?? config.engine ?? "CNLiteBasic",
				count: options.count,
				recency: options.recency,
				includeDomains: options.includeDomains,
				excludeDomains: options.excludeDomains,
				needContent: options.needContent,
				summary: options.summary ?? config.summary,
				category: options.category,
				now: now(),
			});

			const res = await requestJson(`${config.baseUrl}/search/unified`, {
				method: "POST",
				headers: headers(),
				body,
				timeoutMs: options.timeoutMs ?? config.searchTimeoutMs,
				signal: options.signal,
				fetchImpl,
				secret: config.apiKey,
			});

			if (res.status !== 200) throw classifyHttp(res);
			if (res.data?.code && Number(res.data.code) !== 200 && Number(res.data.code) !== 201) {
				throw new CleverSeeError(`CleverSee business error ${res.data.code}: ${textOneLine(res.data.message) || "unknown"}`, {
					kind: Number(res.data.code) === 429 ? "rate" : "invalid-response",
					provider: "cleversee",
					status: res.status,
					code: String(res.data.code),
				});
			}

			const list = Array.isArray(res.data?.pageItems) ? res.data.pageItems : null;
			if (!list) {
				throw new CleverSeeError("CleverSee returned an invalid response: missing pageItems array", {
					kind: "invalid-response",
					provider: "cleversee",
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
				provider: "cleversee",
				engine,
				results,
				warnings,
				meta: {
					engine,
					rawCount: list.length,
					costCredits: res.data?.costCredits ?? null,
					searchTimeMs: res.data?.searchInformation?.searchTime ?? null,
					requestId: res.data?.requestId ?? null,
				},
			};
		},

		async fetchPage(url, options = {}) {
			const mode = options.mode === "scrape" ? "scrape" : "basic";
			const timeoutMs = options.timeoutMs ?? (mode === "scrape" ? config.scrapeTimeoutMs : config.readPageTimeoutMs);
			const body = {
				url,
				formats: ["markdown"],
				readability: { readabilityMode: "article" },
				maxAge: options.maxAge ?? config.readPageMaxAge,
				pageTimeout: options.pageTimeoutMs ?? config.pageTimeoutMs ?? 20_000,
			};

			const res = await requestJson(`${config.baseUrl}/readpage/${mode}`, {
				method: "POST",
				headers: headers(),
				body,
				timeoutMs,
				signal: options.signal,
				fetchImpl,
				secret: config.apiKey,
			});

			if (res.status !== 200) throw classifyHttp(res);
			if (res.data?.errorCode) {
				throw readPageError(res.data.errorCode, textOneLine(res.data.errorMessage), res.status);
			}

			const data = res.data?.data ?? {};
			const statusCode = Number(data.statusCode);
			if (Number.isFinite(statusCode) && statusCode >= 400) {
				const kind = targetStatusKind(statusCode);
				const message =
					kind === "transient"
						? `page fetch did not finish within ${options.pageTimeoutMs ?? config.pageTimeoutMs}ms (raise CLEVERSEE_PAGE_TIMEOUT_MS)`
						: `target returned status ${statusCode}`;
				throw new CleverSeeError(`CleverSee ReadPage ${mode}: ${message}`, {
					kind,
					provider: "cleversee",
					status: statusCode,
					code: String(statusCode),
				});
			}

			const content = textBlock(data.markdown) || textBlock(data.text);
			if (!content) {
				throw new CleverSeeError(`CleverSee ReadPage ${mode} returned no usable content`, {
					kind: "target",
					provider: "cleversee",
					status: res.status,
				});
			}

			const title = textOneLine(data.metadata?.title);
			const challenge = challengeReason(content, title);
			if (challenge) {
				// basic 阶段的中间页属于可恢复：交给 router 升到 scrape（若开启）。
				const kind = mode === "basic" ? "empty" : "target";
				const hint = mode === "basic" ? "; retry with scrape enabled for a browser-rendered page" : "";
				throw new CleverSeeError(
					`CleverSee ReadPage ${mode}: ${challenge} (${content.length} chars${title ? ", title present" : ", no title"})${hint}`,
					{ kind, provider: "cleversee", status: Number.isFinite(statusCode) ? statusCode : res.status },
				);
			}

			const redirectedTo = redirectTarget(url, data.metadata);

			return {
				provider: "cleversee",
				mode,
				url: data.metadata?.url || url,
				title,
				content,
				meta: {
					requestId: res.data?.requestId ?? null,
					statusCode: Number.isFinite(statusCode) ? statusCode : null,
					pageType: data.metadata?.pageType ?? null,
					requestedUrl: url,
					redirectedTo,
				},
			};
		},
	};
}
