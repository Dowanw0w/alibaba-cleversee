import assert from "node:assert/strict";
import test from "node:test";
import { buildDeepSeekQuery, createDeepSeekProvider, DEEPSEEK_MAX_QUERY_CHARS } from "../src/providers/deepseek.mjs";
import { jsonResponse, scriptedFetch, testConfig } from "./helpers.mjs";

const NOW = Date.UTC(2026, 9, 19); // 2026-10-19T00:00:00Z

test("buildDeepSeekQuery adds site/exclude/after operators", () => {
	const query = buildDeepSeekQuery("kubernetes upgrade", {
		includeDomains: ["kubernetes.io", "https://github.com/foo/bar"],
		excludeDomains: ["example.com"],
		recency: "week",
		now: NOW,
	});
	assert.equal(query, "kubernetes upgrade site:kubernetes.io OR site:github.com -site:example.com after:2026-10-12");
});

test("buildDeepSeekQuery rejects queries that exceed the 128 character limit", () => {
	assert.throws(
		() =>
			buildDeepSeekQuery("a".repeat(120), {
				includeDomains: ["one.example.com", "two.example.com"],
				now: NOW,
			}),
		(error) => error.kind === "query-too-long" && error.message.includes(String(DEEPSEEK_MAX_QUERY_CHARS)),
	);
});

test("buildDeepSeekQuery rejects empty queries and unknown recency", () => {
	assert.throws(() => buildDeepSeekQuery("   "), (error) => error.kind === "invalid");
	assert.throws(() => buildDeepSeekQuery("x", { recency: "hour" }), (error) => error.kind === "invalid");
});

test("deepseek search maps fields, dedupes URLs and forwards options", async () => {
	const config = testConfig().deepseek;
	const fetchImpl = scriptedFetch(() =>
		jsonResponse({
			results: [
				{
					title: "Kubernetes 1.31",
					url: "https://kubernetes.io/blog/1-31",
					snippet: "short",
					summary: "long summary",
					content: "full body",
					site_name: "kubernetes.io",
					site_icon: "https://kubernetes.io/favicon.ico",
					date: "2024-08-13T00:00:00+00:00",
					rerank_score: 2.1,
					authority: 4,
				},
				{ title: "duplicate", url: "https://kubernetes.io/blog/1-31" },
				{ title: "bad url", url: "not-a-url" },
				{ title: "ftp", url: "ftp://example.com/file" },
			],
		}),
	);

	const provider = createDeepSeekProvider(config, { fetchImpl, now: () => NOW });
	const result = await provider.search("kubernetes", {
		count: 99,
		needContent: true,
		includeDomains: ["kubernetes.io"],
		recency: "month",
		oriQuestion: "what changed in 1.31",
	});

	assert.equal(fetchImpl.calls.length, 1);
	assert.equal(fetchImpl.calls[0].url, "https://api.deepseek.com/v1/tools/search");
	assert.equal(fetchImpl.calls[0].headers.Authorization, "Bearer test-deepseek-key");
	assert.equal(fetchImpl.calls[0].body.count, 50);
	assert.equal(fetchImpl.calls[0].body.need_content, true);
	assert.equal(fetchImpl.calls[0].body.ori_question, "what changed in 1.31");
	assert.match(fetchImpl.calls[0].body.query, /site:kubernetes\.io/);
	assert.match(fetchImpl.calls[0].body.query, /after:2026-09-19/);

	assert.equal(result.results.length, 1);
	assert.deepEqual(result.results[0], {
		title: "Kubernetes 1.31",
		url: "https://kubernetes.io/blog/1-31",
		snippet: "short",
		summary: "long summary",
		content: "full body",
		publishedAt: "2024-08-13T00:00:00+00:00",
		siteName: "kubernetes.io",
		siteIcon: "https://kubernetes.io/favicon.ico",
		score: 2.1,
		authority: 4,
		provider: "deepseek",
	});
});

test("deepseek search classifies HTTP errors", async () => {
	const config = testConfig().deepseek;
	const cases = [
		[402, "payment"],
		[401, "auth"],
		[429, "rate"],
		[500, "transient"],
		[400, "invalid"],
	];
	for (const [status, kind] of cases) {
		const provider = createDeepSeekProvider(config, {
			fetchImpl: scriptedFetch(() => jsonResponse({ error: { message: `status ${status}` } }, status)),
			now: () => NOW,
		});
		await assert.rejects(provider.search("q"), (error) => error.kind === kind && error.status === status);
	}
});

test("deepseek search rejects malformed responses", async () => {
	const provider = createDeepSeekProvider(testConfig().deepseek, {
		fetchImpl: scriptedFetch(() => jsonResponse({ nope: true })),
		now: () => NOW,
	});
	await assert.rejects(provider.search("q"), (error) => error.kind === "invalid-response");
});

test("deepseek fetch returns title and markdown content", async () => {
	const provider = createDeepSeekProvider(testConfig().deepseek, {
		fetchImpl: scriptedFetch(() => jsonResponse({ title: "Example", content: "# Example\n\nBody." })),
		now: () => NOW,
	});
	const result = await provider.fetchPage("https://example.com");
	assert.equal(result.provider, "deepseek");
	assert.equal(result.title, "Example");
	assert.equal(result.content, "# Example\n\nBody.");
});

test("deepseek fetch maps 404 and empty content to target errors", async () => {
	const notFound = createDeepSeekProvider(testConfig().deepseek, {
		fetchImpl: scriptedFetch(() => jsonResponse({ error: { message: "not found" } }, 404)),
		now: () => NOW,
	});
	await assert.rejects(notFound.fetchPage("https://example.com"), (error) => error.kind === "target");

	const empty = createDeepSeekProvider(testConfig().deepseek, {
		fetchImpl: scriptedFetch(() => jsonResponse({ title: "", content: "" })),
		now: () => NOW,
	});
	await assert.rejects(empty.fetchPage("https://example.com"), (error) => error.kind === "target");
});
