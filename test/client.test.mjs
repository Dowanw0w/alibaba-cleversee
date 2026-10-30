import assert from "node:assert/strict";
import test from "node:test";
import { createMultiAccess } from "../src/index.mjs";
import { jsonResponse, scriptedFetch } from "./helpers.mjs";

const NOW = Date.UTC(2026, 9, 19);
const ENV = { CLEVERSEE_API_KEY: "c" };

const SEARCH_ITEM = {
	title: "Kubernetes",
	link: "https://kubernetes.io/docs",
	snippet: "docs",
	mainText: "body",
	publishedTime: "2026-01-01T00:00:00+08:00",
	hostname: "kubernetes.io",
	rerankScore: 2.2,
	websiteAuthorityScore: 4,
};

function routedFetch({ basicStatus = 200 } = {}) {
	return scriptedFetch((call) => {
		if (call.url.endsWith("/search/unified")) {
			return jsonResponse({ pageItems: [SEARCH_ITEM], requestId: "req-1" });
		}
		if (call.url.endsWith("/readpage/basic")) {
			if (basicStatus !== 200) return jsonResponse({ errorCode: null, data: { statusCode: basicStatus } });
			return jsonResponse({
				requestId: "rp",
				errorCode: null,
				data: { statusCode: 200, markdown: "# Page\n\nBody", metadata: { title: "Page", url: "https://example.com/page" } },
			});
		}
		if (call.url.endsWith("/readpage/scrape")) {
			return jsonResponse({
				requestId: "rps",
				errorCode: null,
				data: { statusCode: 200, markdown: "# Rendered\n\nBody", metadata: { title: "Rendered" } },
			});
		}
		throw new Error(`unexpected URL ${call.url}`);
	});
}

test("client search calls CleverSee and forwards count and domain filters", async () => {
	const fetchImpl = routedFetch();
	const client = createMultiAccess({ env: ENV, fetchImpl, now: () => NOW });

	const result = await client.search("kubernetes", { count: 3, includeDomains: ["kubernetes.io"], recency: "week" });
	assert.equal(result.provider, "cleversee");
	assert.equal(result.engine, "CNLiteBasic");
	assert.equal(result.results.length, 1);
	assert.equal(fetchImpl.calls.length, 1);
	assert.equal(fetchImpl.calls[0].url, "https://cloud-iqs.aliyuncs.com/search/unified");
	assert.equal(fetchImpl.calls[0].body.engineType, "CNLiteBasic");
	assert.equal(fetchImpl.calls[0].body.advancedParams.numResults, "3");
	assert.equal(fetchImpl.calls[0].body.advancedParams.includeSites, "kubernetes.io");
	assert.equal(fetchImpl.calls[0].body.timeRange, "OneWeek");
});

test("client honors MULTI_ACCESS_ENGINE in the request body", async () => {
	const fetchImpl = routedFetch();
	const client = createMultiAccess({ env: { ...ENV, MULTI_ACCESS_ENGINE: "CNAuto" }, fetchImpl, now: () => NOW });

	const result = await client.search("kubernetes", { count: 3 });
	assert.equal(result.engine, "CNAuto");
	assert.equal(fetchImpl.calls[0].body.engineType, "CNAuto");
	assert.equal(client.status().engine, "CNAuto");
});

test("client fetch reads through ReadPage and caches the result", async () => {
	const fetchImpl = routedFetch();
	const client = createMultiAccess({ env: ENV, fetchImpl, now: () => NOW });

	const first = await client.fetch("https://example.com/page");
	assert.equal(first.provider, "cleversee");
	assert.equal(first.mode, "basic");
	assert.equal(first.content, "# Page\n\nBody");

	const callsAfterFirst = fetchImpl.calls.length;
	const second = await client.fetch("https://example.com/page");
	assert.equal(second.meta.cached, true);
	assert.equal(fetchImpl.calls.length, callsAfterFirst);

	const third = await client.fetch("https://example.com/page", { refresh: true });
	assert.equal(third.meta.cached, undefined);
	assert.equal(fetchImpl.calls.length, callsAfterFirst + 1);
});

test("client fetch falls back to the rendered ReadPage when scrape is allowed", async () => {
	const fetchImpl = routedFetch({ basicStatus: 4030 });
	const client = createMultiAccess({ env: ENV, fetchImpl, now: () => NOW });

	const result = await client.fetch("https://example.com/page", { scrape: true });
	assert.equal(result.mode, "scrape");
	assert.equal(result.content, "# Rendered\n\nBody");
	assert.deepEqual(
		result.meta.attempts.map((attempt) => `${attempt.mode}:${attempt.outcome}`),
		["basic:error", "scrape:ok"],
	);
});

test("client refuses private, credential-bearing and non-http URLs before any request", async () => {
	const fetchImpl = routedFetch();
	const client = createMultiAccess({ env: ENV, fetchImpl, now: () => NOW });

	for (const url of ["http://127.0.0.1:8080/x", "http://localhost/x", "file:///etc/passwd", "https://user:pass@example.com/x"]) {
		await assert.rejects(client.fetch(url), (error) => error.kind === "invalid");
	}
	assert.equal(fetchImpl.calls.length, 0);
});

test("client can opt into private hosts", async () => {
	const fetchImpl = routedFetch();
	const client = createMultiAccess({ env: { ...ENV, MULTI_ACCESS_ALLOW_PRIVATE: "1" }, fetchImpl, now: () => NOW });
	const result = await client.fetch("http://127.0.0.1:8080/page");
	assert.equal(result.provider, "cleversee");
});

test("client reports no-provider when the CleverSee key is missing", async () => {
	const client = createMultiAccess({ env: {}, fetchImpl: routedFetch(), now: () => NOW });
	await assert.rejects(client.search("q"), (error) => error.kind === "no-provider");
});

test("client status exposes provider configuration and cache state", () => {
	const client = createMultiAccess({ env: ENV, fetchImpl: routedFetch(), now: () => NOW });
	const status = client.status();
	assert.equal(status.providers.cleversee.configured, true);
	assert.equal(status.engine, "CNLiteBasic");
	assert.deepEqual(status.order, ["cleversee"]);
	assert.equal(status.cache.entries, 0);
	assert.equal(status.reads.allowPrivate, false);
});

test("client respects a zero cache TTL", async () => {
	const fetchImpl = routedFetch();
	const client = createMultiAccess({ env: { ...ENV, MULTI_ACCESS_CACHE_TTL: "0" }, fetchImpl, now: () => NOW });
	await client.fetch("https://example.com/page");
	const callsAfterFirst = fetchImpl.calls.length;
	await client.fetch("https://example.com/page");
	assert.equal(fetchImpl.calls.length, callsAfterFirst + 1);
});
