import assert from "node:assert/strict";
import test from "node:test";
import { createMultiAccess } from "../src/index.mjs";

// 真实 API 联调：必须显式开启，且需要 CLEVERSEE_API_KEY。
//   fish -lc 'MULTI_ACCESS_LIVE=1 node --test test/live.test.mjs'
const live = process.env.MULTI_ACCESS_LIVE === "1" && Boolean(process.env.CLEVERSEE_API_KEY);
const skip = live ? false : "set MULTI_ACCESS_LIVE=1 with CLEVERSEE_API_KEY";

test("live: search returns results from CleverSee", { skip }, async (t) => {
	const client = createMultiAccess();
	const result = await client.search("Kubernetes 1.31 release notes", { count: 3 });
	t.diagnostic(`provider=${result.provider} results=${result.results.length} engine=${result.engine ?? "-"}`);
	assert.equal(result.provider, "cleversee");
	assert.ok(result.results.length > 0);
	for (const item of result.results) {
		assert.match(item.url, /^https?:\/\//);
		assert.ok(item.title);
	}
});

test("live: domain filter is applied", { skip }, async (t) => {
	const client = createMultiAccess();
	const result = await client.search("networking", { count: 3, includeDomains: ["kubernetes.io"] });
	t.diagnostic(`provider=${result.provider} results=${result.results.length}`);
	assert.ok(result.results.length > 0);
	assert.ok(result.results.every((item) => new URL(item.url).hostname.endsWith("kubernetes.io")));
});

test("live: fetch returns markdown", { skip }, async (t) => {
	const client = createMultiAccess();
	const result = await client.fetch("https://example.com/");
	t.diagnostic(`provider=${result.provider} mode=${result.mode} chars=${result.content.length}`);
	assert.equal(result.provider, "cleversee");
	assert.ok(result.content.length > 0);
});
