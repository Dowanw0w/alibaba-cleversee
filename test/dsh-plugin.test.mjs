import assert from "node:assert/strict";
import test from "node:test";
import { apply, inject, name } from "../dsh/index.mjs";
import { jsonResponse, scriptedFetch } from "./helpers.mjs";

const SEARCH_URL = "https://cloud-iqs.aliyuncs.com/search/unified";
const READPAGE_BASIC = "https://cloud-iqs.aliyuncs.com/readpage/basic";

function harness() {
	const providers = { search: undefined, fetch: undefined };
	const ctx = {
		web: {
			registerSearchProvider(provider) {
				providers.search = provider;
			},
			registerFetchProvider(provider) {
				providers.fetch = provider;
			},
		},
		get() {
			return undefined;
		},
	};
	return { ctx, providers };
}

function searchPayload() {
	return {
		code: 200,
		pageItems: [
			{
				title: "Kubernetes 1.31 Release Notes",
				link: "https://kubernetes.io/blog/2024/08/13/kubernetes-v1-31-release/",
				snippet: "Release notes for Kubernetes 1.31.",
				publishedTime: "2024-08-13T00:00:00Z",
				hostname: "kubernetes.io",
				rerankScore: 0.91,
			},
			// Same URL twice: the upstream duplication must not reach the model.
			{ title: "Duplicate", link: "https://kubernetes.io/blog/2024/08/13/kubernetes-v1-31-release/" },
		],
	};
}

test("DSH plugin registers both providers under the cleversee id", () => {
	process.env.CLEVERSEE_API_KEY = "test-key";
	const { ctx, providers } = harness();
	apply(ctx, { engine: "CNLiteBasic" });

	assert.equal(name, "web-cleversee");
	assert.deepEqual(inject, ["web"]);
	assert.equal(providers.search.id, "cleversee");
	assert.equal(providers.fetch.id, "cleversee");
	assert.equal(providers.search.available(), true);
});

test("DSH search provider maps CleverSee results onto the web seam", async () => {
	process.env.CLEVERSEE_API_KEY = "test-key";
	const fetchImpl = scriptedFetch((call) => {
		assert.equal(call.url, SEARCH_URL);
		assert.equal(call.body.advancedParams.numResults, "4");
		assert.equal(call.headers.Authorization, "Bearer test-key");
		return jsonResponse(searchPayload());
	});

	const { ctx, providers } = harness();
	apply(ctx, { engine: "CNLiteBasic" });

	const previousFetch = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	try {
		const result = await providers.search.search({ query: "kubernetes 1.31", maxResults: 4 });
		assert.deepEqual(result, {
			sources: [
				{
					url: "https://kubernetes.io/blog/2024/08/13/kubernetes-v1-31-release/",
					title: "Kubernetes 1.31 Release Notes",
					snippet: "Release notes for Kubernetes 1.31.",
					publishedAt: "2024-08-13T00:00:00Z",
				},
			],
			truncated: false,
		});
		assert.equal(fetchImpl.calls.length, 1);
	} finally {
		globalThis.fetch = previousFetch;
	}
});

test("DSH fetch provider returns ReadPage text as a text body", async () => {
	process.env.CLEVERSEE_API_KEY = "test-key";
	const fetchImpl = scriptedFetch(() =>
		jsonResponse({
			data: {
				statusCode: 200,
				markdown: "# Example\n\nPage body text.",
				metadata: { title: "Example", url: "https://example.com/a" },
			},
		}),
	);

	const { ctx, providers } = harness();
	apply(ctx, {});

	const previousFetch = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	try {
		const result = await providers.fetch.fetch({ url: "https://example.com/a" });
		assert.deepEqual(result, {
			url: "https://example.com/a",
			statusCode: 200,
			body: { kind: "text", content: "# Example\n\nPage body text." },
			truncated: false,
		});
		assert.equal(fetchImpl.calls[0].url, READPAGE_BASIC);
	} finally {
		globalThis.fetch = previousFetch;
	}
});

test("DSH plugin reports an unavailable provider without an API key", async () => {
	delete process.env.CLEVERSEE_API_KEY;
	const { ctx, providers } = harness();
	apply(ctx, {});

	assert.equal(providers.search.available(), false);
	await assert.rejects(
		() => providers.search.search({ query: "x" }),
		(error) =>
			error.code === "WEB_PROVIDER_ERROR" && /CleverSee API key is not configured/.test(error.message),
	);
});

test("DSH plugin wraps upstream failures as provider errors", async () => {
	process.env.CLEVERSEE_API_KEY = "test-key";
	const fetchImpl = scriptedFetch(() => jsonResponse({ message: "boom" }, 500));

	const { ctx, providers } = harness();
	apply(ctx, {});

	const previousFetch = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	try {
		await assert.rejects(
			() => providers.search.search({ query: "x" }),
			(error) => error.code === "WEB_PROVIDER_ERROR" && /CleverSee search failed \[transient\]/.test(error.message),
		);
	} finally {
		globalThis.fetch = previousFetch;
	}
});

test("DSH plugin can register search only", () => {
	process.env.CLEVERSEE_API_KEY = "test-key";
	const { ctx, providers } = harness();
	apply(ctx, { fetch: false });

	assert.ok(providers.search);
	assert.equal(providers.fetch, undefined);
});
