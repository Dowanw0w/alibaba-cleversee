import assert from "node:assert/strict";
import test from "node:test";
import { createMultiAccess } from "../src/index.mjs";
import { jsonResponse, scriptedFetch } from "./helpers.mjs";

const NOW = Date.UTC(2026, 9, 19);
const ENV = { DEEPSEEK_SEARCH_API_KEY: "d", CLEVERSEE_API_KEY: "c" };

function routedFetch() {
	return scriptedFetch((call) => {
		if (call.url.endsWith("/v1/tools/search")) {
			return jsonResponse({
				results: [
					{
						title: "Kubernetes",
						url: "https://kubernetes.io/docs",
						snippet: "docs",
						summary: "summary",
						date: "2026-01-01T00:00:00+00:00",
						rerank_score: 2.2,
						authority: 4,
					},
				],
			});
		}
		if (call.url.endsWith("/v1/tools/fetch")) {
			return jsonResponse({ error: { message: "no usable content" } }, 404);
		}
		if (call.url.endsWith("/readpage/basic")) {
			return jsonResponse({
				requestId: "rp",
				errorCode: null,
				data: { statusCode: 200, markdown: "# Page\n\nBody", metadata: { title: "Page", url: "https://example.com/page" } },
			});
		}
		throw new Error(`unexpected URL ${call.url}`);
	});
}

test("client search uses DeepSeek first", async () => {
	const fetchImpl = routedFetch();
	const client = createMultiAccess({ env: ENV, fetchImpl, now: () => NOW });

	const result = await client.search("kubernetes", { count: 3 });
	assert.equal(result.provider, "deepseek");
	assert.equal(result.results.length, 1);
	assert.equal(fetchImpl.calls[0].body.count, 3);
	assert.equal(fetchImpl.calls[0].body.need_content, false);
});

test("client fetch falls back to CleverSee ReadPage and caches the result", async () => {
	const fetchImpl = routedFetch();
	const client = createMultiAccess({ env: ENV, fetchImpl, now: () => NOW });

	const first = await client.fetch("https://example.com/page");
	assert.equal(first.provider, "cleversee");
	assert.equal(first.mode, "basic");
	assert.equal(first.content, "# Page\n\nBody");
	assert.equal(first.meta.attempts[0].provider, "deepseek");

	const callsAfterFirst = fetchImpl.calls.length;
	const second = await client.fetch("https://example.com/page");
	assert.equal(second.meta.cached, true);
	assert.equal(fetchImpl.calls.length, callsAfterFirst);

	const third = await client.fetch("https://example.com/page", { refresh: true });
	assert.equal(third.meta.cached, undefined);
	assert.equal(fetchImpl.calls.length, callsAfterFirst + 2);
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

test("client reports no-provider when neither key is set", async () => {
	const client = createMultiAccess({ env: {}, fetchImpl: routedFetch(), now: () => NOW });
	await assert.rejects(client.search("q"), (error) => error.kind === "no-provider");
});

test("client status exposes provider configuration and cache state", () => {
	const client = createMultiAccess({ env: ENV, fetchImpl: routedFetch(), now: () => NOW });
	const status = client.status();
	assert.equal(status.providers.deepseek.configured, true);
	assert.equal(status.providers.cleversee.configured, true);
	assert.equal(status.engine, "CNLiteBasic");
	assert.deepEqual(status.order, ["deepseek", "cleversee"]);
	assert.equal(status.cache.entries, 0);
});

test("client respects a zero cache TTL", async () => {
	const fetchImpl = routedFetch();
	const client = createMultiAccess({ env: { ...ENV, MULTI_ACCESS_CACHE_TTL: "0" }, fetchImpl, now: () => NOW });
	await client.fetch("https://example.com/page");
	const callsAfterFirst = fetchImpl.calls.length;
	await client.fetch("https://example.com/page");
	assert.equal(fetchImpl.calls.length, callsAfterFirst + 2);
});
