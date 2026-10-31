import assert from "node:assert/strict";
import test from "node:test";
import { buildCleverSeeSearchBody, createCleverSeeProvider } from "../src/providers/cleversee.mjs";
import { jsonResponse, scriptedFetch, testConfig } from "./helpers.mjs";

const NOW = Date.UTC(2026, 9, 19);

test("cleversee search body uses CNLiteBasic structured filters", () => {
	const { body, warnings } = buildCleverSeeSearchBody("阿里云 联网搜索", {
		engine: "CNLiteBasic",
		count: 100,
		recency: "week",
		includeDomains: ["aliyun.com"],
		excludeDomains: ["example.com"],
		needContent: true,
		summary: false,
		now: NOW,
	});

	assert.deepEqual(warnings, ["numResults capped to engine limit 50"]);
	assert.equal(body.engineType, "CNLiteBasic");
	assert.equal(body.timeRange, "OneWeek");
	assert.deepEqual(body.advancedParams, {
		numResults: "50",
		includeSites: "aliyun.com",
		excludeSites: "example.com",
	});
	assert.deepEqual(body.contents, { rerankScore: true, mainText: true });
});

test("cleversee search body warns when the engine cannot filter sites", () => {
	const { body, warnings } = buildCleverSeeSearchBody("query", {
		engine: "CNAuto",
		count: 50,
		includeDomains: ["aliyun.com"],
		now: NOW,
	});
	assert.equal(body.advancedParams.numResults, "10");
	assert.equal(body.advancedParams.includeSites, undefined);
	assert.equal(warnings.length, 2);
	assert.ok(warnings.some((warning) => /does not support site filters/.test(warning)));
});

test("cleversee GlobalAdvanced uses publish-date filters instead of timeRange", () => {
	const { body } = buildCleverSeeSearchBody("query", { engine: "GlobalAdvanced", recency: "month", now: NOW });
	assert.equal(body.timeRange, undefined);
	assert.equal(body.advancedParams.startPublishedDate, "2026-09-19");
	assert.equal(body.advancedParams.endPublishedDate, "2026-10-19");
});

test("cleversee search maps pageItems and dedupes links", async () => {
	const fetchImpl = scriptedFetch(() =>
		jsonResponse({
			pageItems: [
				{
					title: "阿里云",
					link: "https://www.aliyun.com/",
					snippet: "云计算",
					mainText: "正文",
					publishedTime: "2025-12-10T16:00:00+08:00",
					hostname: "阿里云",
					hostLogo: "https://www.aliyun.com/favicon.ico",
					rerankScore: 0.8,
					websiteAuthorityScore: 3,
					hostAuthorityScore: 1.9,
					tags: { genre: "Article" },
				},
				{ title: "duplicate", link: "https://www.aliyun.com/" },
				{ title: "bad", link: "javascript:alert(1)" },
			],
			costCredits: { valueAdded: { summary: 0, advanced: 0 } },
			searchInformation: { searchTime: 412 },
			requestId: "req-1",
		}),
	);

	const provider = createCleverSeeProvider(testConfig().cleversee, { fetchImpl, now: () => NOW });
	const result = await provider.search("阿里云", { count: 5, needContent: true });

	assert.equal(fetchImpl.calls[0].url, "https://cloud-iqs.aliyuncs.com/search/unified");
	assert.equal(fetchImpl.calls[0].headers.Authorization, "Bearer test-cleversee-key");
	assert.equal(result.results.length, 1);
	assert.equal(result.results[0].url, "https://www.aliyun.com/");
	assert.equal(result.results[0].content, "正文");
	assert.equal(result.results[0].authority, 3);
	assert.equal(result.results[0].hostAuthorityScore, 1.9);
	assert.equal(result.meta.searchTimeMs, 412);
});

test("cleversee search accepts an empty pageItems list", async () => {
	const provider = createCleverSeeProvider(testConfig().cleversee, {
		fetchImpl: scriptedFetch(() => jsonResponse({ pageItems: [] })),
		now: () => NOW,
	});
	const result = await provider.search("小众英文文档", {});
	assert.deepEqual(result.results, []);
});

test("cleversee search classifies HTTP and business errors", async () => {
	const config = testConfig().cleversee;

	const throttled = createCleverSeeProvider(config, {
		fetchImpl: scriptedFetch(() => jsonResponse({ code: 429, message: "throttled" })),
		now: () => NOW,
	});
	await assert.rejects(throttled.search("q"), (error) => error.kind === "rate");

	const unauthorized = createCleverSeeProvider(config, {
		fetchImpl: scriptedFetch(() => jsonResponse({ errorCode: "Retrieval.NotActivate", errorMessage: "activate" }, 403)),
		now: () => NOW,
	});
	await assert.rejects(unauthorized.search("q"), (error) => error.kind === "auth");

	const broken = createCleverSeeProvider(config, {
		fetchImpl: scriptedFetch(() => jsonResponse({ nope: true })),
		now: () => NOW,
	});
	await assert.rejects(broken.search("q"), (error) => error.kind === "invalid-response");
});

test("cleversee readpage basic returns markdown and metadata", async () => {
	const fetchImpl = scriptedFetch(() =>
		jsonResponse({
			requestId: "rp-1",
			errorCode: null,
			errorMessage: null,
			data: { statusCode: 200, markdown: "# Title\n\nBody", metadata: { url: "https://example.com/a", title: "Title", pageType: "article" } },
		}),
	);
	const provider = createCleverSeeProvider(testConfig().cleversee, { fetchImpl, now: () => NOW });
	const result = await provider.fetchPage("https://example.com/a", { mode: "basic" });

	assert.equal(fetchImpl.calls[0].url, "https://cloud-iqs.aliyuncs.com/readpage/basic");
	assert.equal(fetchImpl.calls[0].body.formats[0], "markdown");
	assert.equal(fetchImpl.calls[0].body.readability.readabilityMode, "article");
	assert.equal(result.content, "# Title\n\nBody");
	assert.equal(result.title, "Title");
	assert.equal(result.meta.statusCode, 200);
});

test("cleversee readpage maps target and provider errors", async () => {
	const config = testConfig().cleversee;

	const blocked = createCleverSeeProvider(config, {
		fetchImpl: scriptedFetch(() => jsonResponse({ data: { statusCode: 4030 }, errorCode: null })),
		now: () => NOW,
	});
	await assert.rejects(blocked.fetchPage("https://example.com"), (error) => error.kind === "target");

	const restricted = createCleverSeeProvider(config, {
		fetchImpl: scriptedFetch(() => jsonResponse({ errorCode: "ReadPage.SecurityRestrict", errorMessage: "robots" })),
		now: () => NOW,
	});
	await assert.rejects(restricted.fetchPage("https://example.com"), (error) => error.kind === "target");

	const rateLimited = createCleverSeeProvider(config, {
		fetchImpl: scriptedFetch(() => jsonResponse({ errorCode: "Retrieval.Throttling.User", errorMessage: "qps" }, 429)),
		now: () => NOW,
	});
	await assert.rejects(rateLimited.fetchPage("https://example.com"), (error) => error.kind === "rate");
});

function readPageProvider(payload, env = {}) {
	const fetchImpl = scriptedFetch(() => jsonResponse(payload));
	const provider = createCleverSeeProvider(testConfig(env).cleversee, { fetchImpl, now: () => NOW });
	return { provider, fetchImpl };
}

test("cleversee readpage forwards the configured page budget", async () => {
	const { provider, fetchImpl } = readPageProvider(
		{ data: { statusCode: 200, markdown: "# Title\n\nBody", metadata: { title: "Title" } } },
		{ CLEVERSEE_PAGE_TIMEOUT_MS: "45000" },
	);
	await provider.fetchPage("https://example.com/a", { mode: "basic" });
	assert.equal(fetchImpl.calls[0].body.pageTimeout, 45_000);
});

test("cleversee readpage treats a 408 as a retryable transient timeout", async () => {
	const { provider } = readPageProvider({ data: { statusCode: 408, markdown: "" } });
	await assert.rejects(provider.fetchPage("https://example.com/slow", { mode: "basic" }), (error) => {
		assert.equal(error.kind, "transient");
		assert.equal(error.status, 408);
		assert.match(error.message, /did not finish within 20000ms/);
		return true;
	});
});

test("cleversee readpage keeps client errors as targets and server errors as transient", async () => {
	const forbidden = readPageProvider({ data: { statusCode: 403, markdown: "" } }).provider;
	await assert.rejects(forbidden.fetchPage("https://example.com/blocked", { mode: "basic" }), (error) => error.kind === "target");

	const broken = readPageProvider({ data: { statusCode: 500, markdown: "" } }).provider;
	await assert.rejects(broken.fetchPage("https://example.com/broken", { mode: "basic" }), (error) => error.kind === "transient");
});

test("cleversee readpage rejects anti-bot interstitials instead of returning them", async () => {
	const body = { data: { statusCode: 200, markdown: "Please wait...", metadata: {} } };

	const basic = readPageProvider(body).provider;
	await assert.rejects(basic.fetchPage("https://juejin.cn/post/1", { mode: "basic" }), (error) => {
		assert.equal(error.kind, "empty");
		assert.match(error.message, /anti-bot interstitial/);
		assert.match(error.message, /retry with scrape enabled/);
		return true;
	});

	const scraped = readPageProvider(body).provider;
	await assert.rejects(scraped.fetchPage("https://juejin.cn/post/1", { mode: "scrape" }), (error) => error.kind === "target");
});

test("cleversee readpage flags a redirect away from the requested page", async () => {
	const { provider } = readPageProvider({
		data: {
			statusCode: 200,
			markdown: "# Home\n\nLanding page",
			metadata: { title: "Home", url: "https://example.com/gone-article", redirectedUrl: "https://example.com" },
		},
	});
	const result = await provider.fetchPage("https://example.com/gone-article", { mode: "basic" });
	assert.equal(result.meta.redirectedTo, "https://example.com/");
	assert.equal(result.meta.requestedUrl, "https://example.com/gone-article");
});

test("cleversee readpage does not flag same-path redirects", async () => {
	const { provider } = readPageProvider({
		data: {
			statusCode: 200,
			markdown: "# Article\n\nBody",
			metadata: { title: "Article", url: "https://www.example.com/a/", redirectedUrl: "https://www.example.com/a/" },
		},
	});
	const result = await provider.fetchPage("https://example.com/a", { mode: "basic" });
	assert.equal(result.meta.redirectedTo, null);
});
